import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { printOrder } from '../utils/epsonPrint'
import { isStuckUnacked } from '../utils/stuckStage'

// Auto-print gate (B2 write-complete signal).
// The webhook stamps orders.items_written_at as its FINAL write, after all
// order_items + order_item_toppings are persisted. Primary gate: print as soon
// as items_written_at is set — the order is provably complete, no blind wait.
// Fallback gate: if the stamp never lands (an order predating this feature, or
// a rare stamp-write failure), still print once the order is older than
// PRINT_FALLBACK_MS so a print is never permanently blocked. This replaces the
// old fixed 5s settle delay with a deterministic signal + a safety net.
const PRINT_FALLBACK_MS = 8000

// Escalation threshold: an order acknowledged but still not marked in-progress
// after this many minutes drives the second (escalation) alert layer.
const ESCALATION_MINUTES = 7

// ── Looping audio element (module-level singleton) ──
// Created lazily on first call so the constructor doesn't run during
// SSR / non-browser test contexts. Lives at module scope so re-mounts
// of the hook (e.g. tab switches) reuse the same element instead of
// orphaning a running clip. Fully Kiosk's "Autoplay Audio" setting
// covers <audio> elements with autoplay/loop semantics; that's the
// reason we use an element here instead of synthesizing via Web Audio.
let audioElement = null

function getAudioElement() {
  if (typeof window === 'undefined') return null
  if (!audioElement) {
    audioElement = new Audio('/chime.wav')
    audioElement.loop = true
    audioElement.preload = 'auto'
  }
  return audioElement
}

// ── Escalation audio element (SECOND module-level singleton) ──
// A fully separate looping element for the escalation tone, mirroring the
// new-order singleton above but pointing at the distinct escalation clip. It
// has its own element + its own isPlaying ref so the two alert layers never
// share state or fight over playback.
let escalationAudioElement = null

function getEscalationAudioElement() {
  if (typeof window === 'undefined') return null
  if (!escalationAudioElement) {
    escalationAudioElement = new Audio('/escalation-chime.wav')
    escalationAudioElement.loop = true
    escalationAudioElement.preload = 'auto'
  }
  return escalationAudioElement
}

// One-time gesture-based unlock for non-FullyKiosk environments (admin
// staff viewing the tablet page from a phone/laptop). Calling .play()
// inside a gesture handler primes the element so later programmatic
// plays succeed even without further gestures. Harmless on Fully Kiosk
// (the FK autoplay setting already covers element-based audio).
let unlocked = false
function installGestureUnlock() {
  if (typeof window === 'undefined' || unlocked) return
  const unlock = () => {
    unlocked = true
    const a = getAudioElement()
    if (!a) return
    a.play().then(() => { a.pause(); a.currentTime = 0 }).catch(() => {})
    document.removeEventListener('touchstart', unlock)
    document.removeEventListener('click', unlock)
  }
  document.addEventListener('touchstart', unlock, { once: true, passive: true })
  document.addEventListener('click', unlock, { once: true })
}

export function useOrderPolling(restaurant, hours) {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const knownOrderIds = useRef(new Set())
  const isPlayingRef = useRef(false)
  const isEscalatingRef = useRef(false)

  const diagnostics = useRef({
    pollAttempts: 0,
    pollSuccesses: 0,
    pollFailures: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ordersReturnedLastPoll: 0,
    audioPlayAttempts: 0,
    audioPlayFailures: 0,
    audioPauseAttempts: 0,
    lastAudioError: null,
    visibilityRefetches: 0,
  })

  useEffect(() => { installGestureUnlock() }, [])

  function isRestaurantOpen() {
    if (!hours || hours.length === 0) return true
    const now = new Date()
    const dayOfWeek = now.getDay()
    const currentTime = now.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const todayHours = hours.find(h => h.day_of_week === dayOfWeek)
    if (!todayHours?.is_open || !todayHours.open_time || !todayHours.close_time) return false
    return currentTime >= todayHours.open_time && currentTime <= todayHours.close_time
  }

  // Drive the audio element based on whether any un-acknowledged new
  // orders exist in the just-fetched data. The element's `loop` attr
  // handles repetition natively — no setInterval needed.
  function syncAudioState(hasUnacked) {
    const a = getAudioElement()
    if (!a) return
    if (hasUnacked && !isPlayingRef.current) {
      diagnostics.current.audioPlayAttempts++
      a.play().then(() => {
        isPlayingRef.current = true
      }).catch(err => {
        diagnostics.current.audioPlayFailures++
        diagnostics.current.lastAudioError = err?.message || String(err)
        console.warn('[CHIME] play blocked:', err)
        // Pulsing green tile already covers the no-audio case visually.
      })
    } else if (!hasUnacked && isPlayingRef.current) {
      diagnostics.current.audioPauseAttempts++
      a.pause()
      a.currentTime = 0
      isPlayingRef.current = false
    }
  }

  // Escalation audio — a separate second layer, mirroring syncAudioState
  // exactly but operating ONLY on the escalation element + isEscalatingRef.
  // Independent of the new-order chime: both can be playing at once (a fresh
  // un-acked order AND an older acked-but-not-started one).
  function syncEscalationAudioState(hasEscalation) {
    const a = getEscalationAudioElement()
    if (!a) return
    if (hasEscalation && !isEscalatingRef.current) {
      diagnostics.current.audioPlayAttempts++
      a.play().then(() => {
        isEscalatingRef.current = true
      }).catch(err => {
        diagnostics.current.audioPlayFailures++
        diagnostics.current.lastAudioError = err?.message || String(err)
        console.warn('[ESCALATION] play blocked:', err)
        // Pulsing amber tile already covers the no-audio case visually.
      })
    } else if (!hasEscalation && isEscalatingRef.current) {
      diagnostics.current.audioPauseAttempts++
      a.pause()
      a.currentTime = 0
      isEscalatingRef.current = false
    }
  }

  async function autoPrint(newOrder, copies = 1) {
    if (!restaurant?.printer_ip) return
    // Real attempt count (newOrder.print_attempts comes from the poll's
    // select('*')): first print 0->1, retry of a once-failed order 1->2, etc.
    // Used in BOTH writes below so the log row and the order counter agree,
    // and so the retry filter's (print_attempts < 3) cap actually engages.
    const attempt = (newOrder.print_attempts || 0) + 1
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('*, order_item_toppings(*)')
      .eq('order_id', newOrder.id)
      .order('created_at')

    const result = await printOrder(
      restaurant.printer_ip,
      { ...newOrder, items: orderItems || [] },
      { name: restaurant.name, address: restaurant.address, phone: restaurant.phone, receipt_font: restaurant?.receipt_font ?? 'standard' },
      copies
    )

    const { error: logErr } = await supabase.from('print_logs').insert({
      order_id: newOrder.id,
      order_number: newOrder.order_number,
      restaurant_id: restaurant.id,
      attempt_number: attempt,
      status: result.success ? 'success' : 'failed',
      error_message: result.success ? null : result.message,
      // Raw ePOS diagnostics on EVERY attempt (success + failure) so a phantom
      // "success" still has its ASB bitmask recorded for later inspection.
      asb_status: (typeof result.status === 'number' ? result.status : null),
      status_code: (result.code != null ? String(result.code) : null),
    })
    if (logErr) console.error('[AutoPrint] Failed to insert print log:', logErr)

    const { error: statusErr } = await supabase.from('orders').update({
      print_status: result.success ? 'printed' : 'failed',
      print_attempts: attempt,
    }).eq('id', newOrder.id)
    if (statusErr) console.error('[AutoPrint] Failed to update print_status:', statusErr)
  }

  const retryingIds = useRef(new Set())
  const recheckTimer = useRef(null)
  const realtimeDebounce = useRef(null)

  const fetchOrders = useCallback(async () => {
    if (!restaurant) return

    const startedAt = Date.now()
    diagnostics.current.pollAttempts++
    diagnostics.current.lastPollAt = new Date().toISOString()

    console.log('[POLL] tick', diagnostics.current.lastPollAt, 'isOpen=', isRestaurantOpen())

    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', restaurant.id)
        .in('status', ['new', 'in_progress', 'scheduled', 'complete', 'cancelled', 'self_delivering'])
        .order('created_at', { ascending: false })

      if (error) {
        diagnostics.current.pollFailures++
        diagnostics.current.lastFailureAt = new Date().toISOString()
        diagnostics.current.lastErrorCode = error.code || 'unknown'
        diagnostics.current.lastErrorMessage = error.message || String(error)
        console.error('[POLL] supabase error', error.code, error.message, error.details)
        return
      }

      if (!data) {
        diagnostics.current.pollFailures++
        diagnostics.current.lastFailureAt = new Date().toISOString()
        diagnostics.current.lastErrorMessage = 'no data and no error returned'
        console.warn('[POLL] no data and no error returned')
        return
      }

      diagnostics.current.pollSuccesses++
      diagnostics.current.lastSuccessAt = new Date().toISOString()
      diagnostics.current.ordersReturnedLastPoll = data.length

      console.log('[POLL] resp ok', { count: data.length, durationMs: Date.now() - startedAt })

      // Auto-print first-seen new orders. knownOrderIds dedups print
      // attempts across the session — independent of chime/ack state.
      //
      // Write-complete gate (see PRINT_FALLBACK_MS): print an order once the
      // webhook has stamped items_written_at (all items + toppings persisted).
      // An order detected as new but not yet stamped is DEFERRED — collected in
      // deferredIds and deliberately left OUT of knownOrderIds below — so it
      // stays eligible and a later poll prints it once the stamp lands (or the
      // age fallback fires). Marking it seen now would skip it forever.
      const settleNow = Date.now()
      const deferredIds = new Set()
      const freshNew = data.filter(
        o => o.status === 'new' && !knownOrderIds.current.has(o.id)
      )
      if (freshNew.length > 0 && knownOrderIds.current.size > 0) {
        for (const newOrder of freshNew) {
          const writeComplete = newOrder.items_written_at != null
          const ageMs = settleNow - new Date(newOrder.created_at).getTime()
          // Primary: print the moment the webhook signals the write is complete.
          // Fallback: a missing stamp (old order / stamp failure) still prints once
          // it's older than PRINT_FALLBACK_MS. Otherwise defer to a later poll,
          // left unmarked so it stays eligible (same defer mechanism as before).
          if (!writeComplete && ageMs < PRINT_FALLBACK_MS) {
            deferredIds.add(newOrder.id)
            continue
          }
          retryingIds.current.add(newOrder.id)
          autoPrint(newOrder, restaurant?.auto_print_copies || 1)
            .finally(() => retryingIds.current.delete(newOrder.id))
        }
      }

      // Chime decision: any un-acknowledged new order, OR any stuck-pending
      // order at stage >= 2 not yet acknowledged → keep audio playing. Both
      // signals live in the DB (acknowledged_at / stuck_acknowledged_at), so
      // it's reload-safe: reload re-fetches, re-evaluates, re-plays as needed.
      const now = Date.now()
      const hasUnacked =
        data.some(o => o.status === 'new' && !o.acknowledged_at) ||
        data.some(o => isStuckUnacked(o, now))
      syncAudioState(hasUnacked)

      // Escalation layer (independent of hasUnacked): an order acknowledged but
      // still 'new' — not yet marked in-progress — for >= ESCALATION_MINUTES.
      // Mutually exclusive with the new-order chime per order (that requires
      // !acknowledged_at; this requires acknowledged_at != null).
      const hasEscalation = data.some(o =>
        o.status === 'new' &&
        o.acknowledged_at != null &&
        (now - new Date(o.acknowledged_at).getTime()) >= ESCALATION_MINUTES * 60 * 1000
      )
      syncEscalationAudioState(hasEscalation)

      // Retry failed/pending prints on every poll cycle
      if (restaurant.printer_ip) {
        const now = Date.now()
        const retryable = data.filter(o =>
          (o.print_status === 'failed' || o.print_status === 'pending') &&
          o.status === 'new' &&
          (o.print_attempts || 0) < 3 &&
          now - new Date(o.created_at).getTime() > 30000 &&
          now - new Date(o.created_at).getTime() < 30 * 60 * 1000 &&
          !retryingIds.current.has(o.id)
        )
        for (const order of retryable) {
          retryingIds.current.add(order.id)
          autoPrint(order, 1).finally(() => retryingIds.current.delete(order.id))
        }
      }

      // ── Scheduled-order wake-up ────────────────────────────────────────
      // A scheduled uber_direct order booked at placement (status 'scheduled'
      // with uber_delivery_id set) is promoted into the active queue as its
      // pickup time nears, so it surfaces in the In Progress tab with the full
      // UberDirect status line + getStuckStage escalation, like any dispatched
      // order. Threshold: now >= scheduled_for − estimated_pickup_minutes (the
      // prep lead the customer's slot was quoted against; floored to 30 if the
      // restaurant has no value).
      //
      // Direct status write — intentionally does NOT stamp accepted_at (set at
      // operator accept; left untouched here). NOT updateStatus (that stamps it).
      // Fire-once via status itself: once 'in_progress' the order no longer
      // matches the filter, so it promotes exactly once with no extra column.
      // The .eq('status','scheduled') makes concurrent multi-tablet writes a
      // race-safe no-op (second tablet matches 0 rows). ASAP orders (no
      // scheduled_for / not 'scheduled') and in_house orders (not uber_direct)
      // never match the filter — zero effect on them.
      const prepLeadMs = (Number(restaurant.estimated_pickup_minutes) || 30) * 60 * 1000
      const wakeNow = Date.now()
      const toWake = data.filter(o =>
        o.status === 'scheduled' &&
        o.delivery_fulfillment_method === 'uber_direct' &&
        o.uber_delivery_id != null &&
        o.scheduled_for != null &&
        wakeNow >= new Date(o.scheduled_for).getTime() - prepLeadMs
      )
      for (const o of toWake) {
        supabase
          .from('orders')
          .update({ status: 'in_progress' })
          .eq('id', o.id)
          .eq('status', 'scheduled')
          .then(({ error }) => {
            if (error) console.error('[WakeUp] promote failed', o.id, error)
          })
      }

      // Mark every fetched order seen EXCEPT ones deferred as too-fresh above —
      // those stay eligible so a later poll can auto-print them once settled.
      knownOrderIds.current = new Set(
        data.filter(o => !deferredIds.has(o.id)).map(o => o.id)
      )

      // If any order was deferred (row visible but items_written_at not yet
      // stamped), re-check shortly instead of waiting the full 10s poll. The
      // write settles ~1s after the row appears, so a ~1.5s re-check prints it
      // promptly. Single-timer guard: never stack overlapping re-checks.
      if (deferredIds.size > 0 && recheckTimer.current === null) {
        recheckTimer.current = setTimeout(() => {
          recheckTimer.current = null
          if (isRestaurantOpen()) fetchOrders()
        }, 1500)
      }
      setOrders(data)
      setLoading(false)
    } catch (err) {
      diagnostics.current.pollFailures++
      diagnostics.current.lastFailureAt = new Date().toISOString()
      diagnostics.current.lastErrorMessage = err?.message || String(err)
      console.error('[POLL] exception caught', err)
    }
  }, [restaurant])

  // Polling loop — runs at TabletPage level, survives tab switches
  useEffect(() => {
    fetchOrders()
    const interval = setInterval(() => {
      if (isRestaurantOpen()) fetchOrders()
    }, 10000)

    // Realtime poke: an orders-table change triggers an EARLY fetchOrders() so
    // prints fire ~sub-second instead of waiting up to 10s for the next poll.
    // This only changes WHEN the fetch runs — printing still flows through the
    // unchanged items_written_at gate + knownOrderIds baseline + serialized
    // queue inside fetchOrders. The handler NEVER prints and NEVER calls
    // autoPrint directly. The 10s poll above stays as the backstop for a dropped
    // socket. A burst of events coalesces into one fetch via a 250ms debounce,
    // using the same single-timer guard idiom as recheckTimer.
    const triggerRealtimeFetch = () => {
      if (realtimeDebounce.current !== null) return // coalesce: a fetch is already pending
      realtimeDebounce.current = setTimeout(() => {
        realtimeDebounce.current = null
        if (isRestaurantOpen()) fetchOrders()
      }, 250)
    }

    let channel = null
    if (restaurant?.id) {
      channel = supabase
        .channel(`orders-rt-${restaurant.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurant.id}` },
          () => triggerRealtimeFetch()
        )
        .subscribe()
    }

    return () => {
      clearInterval(interval)
      if (recheckTimer.current) { clearTimeout(recheckTimer.current); recheckTimer.current = null }
      if (realtimeDebounce.current) { clearTimeout(realtimeDebounce.current); realtimeDebounce.current = null }
      if (channel) supabase.removeChannel(channel)
      // Don't tear down the audio element on unmount — it's module-level
      // and will be reused by the next mount. We do pause it so a stale
      // chime doesn't keep playing if the tablet navigates away mid-loop.
      const a = getAudioElement()
      if (a && isPlayingRef.current) {
        a.pause()
        a.currentTime = 0
        isPlayingRef.current = false
      }
      // Same for the escalation element — pause on unmount so it doesn't keep
      // looping after navigating away (mirrors the new-order pause above).
      const e = getEscalationAudioElement()
      if (e && isEscalatingRef.current) {
        e.pause()
        e.currentTime = 0
        isEscalatingRef.current = false
      }
    }
  }, [fetchOrders])

  return {
    orders,
    setOrders,
    loading,
    fetchOrders,
    diagnostics,
  }
}
