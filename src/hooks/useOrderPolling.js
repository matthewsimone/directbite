import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { printOrder, printExternalOrder } from '../utils/epsonPrint'
import { writeExternalPrintResult } from '../utils/externalPrintStatus'
import { isStuckUnacked } from '../utils/stuckStage'

// Auto-print gate (B2 write-complete signal).
// The webhook stamps orders.items_written_at as its FINAL write, after all
// order_items + order_item_toppings are persisted. That stamp is the ONLY
// print trigger: an order prints the moment it is provably complete.
// There is deliberately NO age-based fallback. An order that is not fully
// written must never print — a half-written ticket sends the kitchen an
// order missing items or toppings, which is worse than a delayed print.
// An order whose stamp never lands stays unprinted until it is stamped;
// the operator's Reprint control covers that case.

// Escalation threshold: an order acknowledged but still not marked in-progress
// after this many minutes drives the second (escalation) alert layer.
const ESCALATION_MINUTES = 7

// DSP (KitchenHub) orders: tablet window + hard cap on how long the tick may
// wait for the external fetch before falling back to the previous set.
const EXTERNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const EXTERNAL_FETCH_TIMEOUT_MS = 4000
const EXTERNAL_COLUMNS =
  'id, restaurant_id, kh_order_id, provider_id, provider_name, order_number, daily_number, ' +
  'order_type, status, asap, scheduled_for, pickup_at, placed_at, customer_name, customer_phone, ' +
  'notes, delivery_type, delivery, items, charges, total, payment_method, prep_time_minutes, ' +
  'acknowledged_at, accepted_at, completed_at, cancelled_at, cancelled_by, print_status, ' +
  'print_attempts, paid, last_event_at, created_at, updated_at'

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
  // DSP orders — populated only when restaurant.dsp_orders_enabled is true.
  // The ref mirrors state so fetchOrders (memoized on [restaurant]) can read
  // the last good set without a stale closure.
  const [externalOrders, setExternalOrdersState] = useState([])
  const externalOrdersRef = useRef([])
  const setExternalOrders = useCallback(updater => {
    externalOrdersRef.current =
      typeof updater === 'function' ? updater(externalOrdersRef.current) : updater
    setExternalOrdersState(externalOrdersRef.current)
  }, [])
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

    // Durable status write: the print already happened (above). If this DB write
    // fails transiently, the order would stay 'pending' and reprint next poll (a
    // duplicate). Retry a few times before giving up so a momentary blip doesn't
    // cause a double ticket. Does NOT affect the print — that already fired.
    let statusErr = null
    for (let w = 0; w < 3; w++) {
      const { error } = await supabase.from('orders').update({
        print_status: result.success ? 'printed' : 'failed',
        print_attempts: attempt,
      }).eq('id', newOrder.id)
      if (!error) { statusErr = null; break }
      statusErr = error
      if (w < 2) await new Promise(r => setTimeout(r, 300))
    }
    if (statusErr) console.error('[AutoPrint] print_status write failed after retries:', statusErr)
  }

  // Never rejects. On any failure (error, throw, timeout) it resolves to the
  // previous set so the Ordr chime/print/retry path is unaffected.
  function fetchExternalOrders() {
    const run = (async () => {
      try {
        const since = new Date(Date.now() - EXTERNAL_WINDOW_MS).toISOString()
        const { data, error } = await supabase
          .from('external_orders')
          .select(EXTERNAL_COLUMNS)
          .eq('restaurant_id', restaurant.id)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
        if (error || !data) {
          console.error('[POLL:EXT] fetch failed', error?.code, error?.message)
          return externalOrdersRef.current
        }
        const tagged = data.map(o => ({ ...o, __source: 'external' }))
        setExternalOrders(tagged)
        return tagged
      } catch (err) {
        console.error('[POLL:EXT] exception', err)
        return externalOrdersRef.current
      }
    })()
    const timeout = new Promise(resolve =>
      setTimeout(() => resolve(externalOrdersRef.current), EXTERNAL_FETCH_TIMEOUT_MS)
    )
    return Promise.race([run, timeout])
  }

  // DSP auto-print. Never rejects (printExternalOrder and
  // writeExternalPrintResult both resolve on every path). No print_logs row:
  // print_logs.order_id references orders.
  async function autoPrintExternal(extOrder, copies) {
    try {
      const attempt = (extOrder.print_attempts || 0) + 1
      const result = await printExternalOrder(restaurant.printer_ip, extOrder, { name: restaurant.name }, copies)
      if (result.success) printedExternalIds.current.add(extOrder.id)
      setExternalOrders(prev => prev.map(o => o.id === extOrder.id
        ? { ...o, print_status: result.success ? 'printed' : 'failed', print_attempts: attempt }
        : o))
      await writeExternalPrintResult(extOrder.id, result, attempt)
    } catch (err) {
      console.error('[ExtPrint] auto-print exception', extOrder.id, err)
    }
  }

  const retryingIds = useRef(new Set())
  // DSP ids that printed successfully this session. Guards against a stale
  // external set (fetch timeout/error fallback, or a fetch that raced the
  // status write) re-dispatching a ticket that already printed.
  const printedExternalIds = useRef(new Set())
  const recheckTimer = useRef(null)
  const recheckCount = useRef(0)
  const realtimeDebounce = useRef(null)

  const fetchOrders = useCallback(async () => {
    if (!restaurant) return

    const startedAt = Date.now()
    diagnostics.current.pollAttempts++
    diagnostics.current.lastPollAt = new Date().toISOString()

    console.log('[POLL] tick', diagnostics.current.lastPollAt, 'isOpen=', isRestaurantOpen())

    try {
      // Kicked off in parallel with the Ordr query; awaited only at the chime
      // decision, after auto-print has already been dispatched.
      const externalPromise = restaurant.dsp_orders_enabled === true ? fetchExternalOrders() : null
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
      // Write-complete gate: print an order once the webhook has stamped
      // items_written_at (all items + toppings persisted). An order detected as
      // new but not yet stamped is DEFERRED — collected in deferredIds and
      // deliberately left OUT of knownOrderIds below — so it stays eligible and
      // a later poll prints it once the stamp lands. Marking it seen now would
      // skip it forever.
      const deferredIds = new Set()
      const freshNew = data.filter(
        o => o.status === 'new' && !knownOrderIds.current.has(o.id)
      )
      // print_trigger 'in_progress': suppress the on-arrival auto-print. Only
      // the firing is gated — knownOrderIds bookkeeping below still runs every
      // poll, so an order taken in in-progress mode stays tracked as "known"
      // and can't retroactively arrival-print if the toggle later flips.
      if (restaurant?.print_trigger !== 'in_progress' && freshNew.length > 0 && knownOrderIds.current.size > 0) {
        for (const newOrder of freshNew) {
          const writeComplete = newOrder.items_written_at != null
          // Print ONLY once the webhook signals the write is complete. No age
          // fallback: an unstamped order is deferred indefinitely, left unmarked
          // so it stays eligible for a later poll once the stamp lands.
          if (!writeComplete) {
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
      // DSP orders join the new-order chime only when the flag is on. The ternary
      // means no await (no extra microtask) when the flag is off.
      const ext = externalPromise ? await externalPromise : null
      const hasUnacked =
        data.some(o => o.status === 'new' && !o.acknowledged_at) ||
        data.some(o => isStuckUnacked(o, now)) ||
        (ext !== null && ext.some(o => o.status === 'new' && !o.acknowledged_at))
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

      // Retry failed/pending prints on every poll cycle. Skipped entirely in
      // print_trigger 'in_progress' mode: there, a taken order legitimately
      // sits new+pending briefly before the operator take, and this loop must
      // not auto-print it (that would defeat the feature).
      if (restaurant.printer_ip && restaurant?.print_trigger !== 'in_progress') {
        const now = Date.now()
        const retryable = data.filter(o =>
          (o.print_status === 'failed' || o.print_status === 'pending') &&
          o.items_written_at != null &&
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

      // ── Take-fire: print-on-Mark-In-Progress mode ──────────────────────
      // print_trigger 'in_progress': the order did NOT print on arrival (both the
      // detect block and retry loop are gated off above). Instead it prints when the
      // operator TAKES it — status reaches 'in_progress' (Mark In Progress, or UD
      // dispatch server-write) or 'scheduled' (Accept on a scheduled order). Fires
      // auto_print_copies copies, exactly once:
      //   • print_status IN ('pending','failed')  → durable guard: once we write
      //     'printed' the order is excluded forever; a failed attempt stays eligible
      //     (never-miss: it retries next poll until it prints or hits attempt cap).
      //   • !retryingIds                          → in-flight guard: the multi-second
      //     print can't be double-dispatched by an overlapping poll.
      //   • items_written_at != null              → never print a half-written ticket.
      //   • print_attempts < 3                    → bound the retry so a hard-failing
      //     printer can't loop forever; after the cap, operator uses Reprint.
      if (restaurant.printer_ip && restaurant?.print_trigger === 'in_progress') {
        const takeFire = data.filter(o =>
          (o.status === 'in_progress' || o.status === 'scheduled') &&
          (o.print_status === 'pending' || o.print_status === 'failed') &&
          o.items_written_at != null &&
          (o.print_attempts || 0) < 3 &&
          !retryingIds.current.has(o.id)
        )
        for (const order of takeFire) {
          retryingIds.current.add(order.id)
          autoPrint(order, restaurant?.auto_print_copies || 1)
            .finally(() => retryingIds.current.delete(order.id))
        }
      }

      // ── DSP (KitchenHub) auto-print ────────────────────────────────────
      // Flag-on only (ext is null otherwise). Fire-and-forget like autoPrint;
      // in-flight guard reuses retryingIds under an `ext-` prefix so ids can't
      // collide with Ordr orders. 30-min window so enabling the flag never
      // prints a backlog — measured from arrival (created_at) in arrival mode,
      // and from acceptance (accepted_at ?? last_event_at) in 'in_progress'
      // mode, where a DSP ticket fires on accept.
      if (ext !== null && restaurant.printer_ip) {
        const extNow = Date.now()
        const inProgressMode = restaurant?.print_trigger === 'in_progress'
        const windowStart = o => new Date(inProgressMode ? (o.accepted_at ?? o.last_event_at) : o.created_at).getTime()
        const toPrint = ext.filter(o =>
          (inProgressMode ? o.status === 'accepted' : (o.status === 'new' || o.status === 'accepted')) &&
          (o.print_status === 'pending' || o.print_status === 'failed') &&
          (o.print_attempts || 0) < 3 &&
          extNow - windowStart(o) < 30 * 60 * 1000 &&
          !retryingIds.current.has(`ext-${o.id}`) &&
          !printedExternalIds.current.has(o.id)
        )
        for (const o of toPrint) {
          const key = `ext-${o.id}`
          retryingIds.current.add(key)
          autoPrintExternal(o, restaurant?.auto_print_copies || 1)
            .finally(() => retryingIds.current.delete(key))
        }
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
      // Bounded re-arm: with no age fallback, a stamp that never lands would
      // otherwise re-arm this timer forever. Cap the burst at 10 re-checks
      // (~15s) and fall back to the regular 10s poll; the counter resets as
      // soon as a poll completes with nothing deferred.
      if (deferredIds.size === 0) {
        recheckCount.current = 0
      } else if (recheckTimer.current === null && recheckCount.current < 10) {
        recheckCount.current++
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
    // DSP orders are also gated on Ordr hours. Pre-pilot: KitchenHub store hours
    // must match Ordr hours, or DSP orders after close are not fetched.
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

    let extChannel = null
    if (restaurant?.id && restaurant.dsp_orders_enabled === true) {
      extChannel = supabase
        .channel(`external-orders-rt-${restaurant.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'external_orders', filter: `restaurant_id=eq.${restaurant.id}` },
          () => triggerRealtimeFetch()
        )
        .subscribe()
    }

    return () => {
      clearInterval(interval)
      if (recheckTimer.current) { clearTimeout(recheckTimer.current); recheckTimer.current = null }
      if (realtimeDebounce.current) { clearTimeout(realtimeDebounce.current); realtimeDebounce.current = null }
      if (channel) supabase.removeChannel(channel)
      if (extChannel) supabase.removeChannel(extChannel)
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
    externalOrders,
    setExternalOrders,
  }
}
