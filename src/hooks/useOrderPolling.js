import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { printOrder } from '../utils/epsonPrint'
import { isStuckUnacked } from '../utils/stuckStage'

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

  async function autoPrint(newOrder) {
    if (!restaurant?.printer_ip) return
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('*, order_item_toppings(*)')
      .eq('order_id', newOrder.id)
      .order('created_at')

    const result = await printOrder(
      restaurant.printer_ip,
      { ...newOrder, items: orderItems || [] },
      { name: restaurant.name, address: restaurant.address, phone: restaurant.phone }
    )

    const { error: logErr } = await supabase.from('print_logs').insert({
      order_id: newOrder.id,
      order_number: newOrder.order_number,
      restaurant_id: restaurant.id,
      attempt_number: 1,
      status: result.success ? 'success' : 'failed',
      error_message: result.success ? null : result.message,
    })
    if (logErr) console.error('[AutoPrint] Failed to insert print log:', logErr)

    const { error: statusErr } = await supabase.from('orders').update({
      print_status: result.success ? 'printed' : 'failed',
      print_attempts: 1,
    }).eq('id', newOrder.id)
    if (statusErr) console.error('[AutoPrint] Failed to update print_status:', statusErr)
  }

  const retryingIds = useRef(new Set())

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

      const newOrderIds = new Set(data.map(o => o.id))

      // Auto-print first-seen new orders. knownOrderIds dedups print
      // attempts across the session — independent of chime/ack state.
      const freshNew = data.filter(
        o => o.status === 'new' && !knownOrderIds.current.has(o.id)
      )
      if (freshNew.length > 0 && knownOrderIds.current.size > 0) {
        for (const newOrder of freshNew) {
          autoPrint(newOrder)
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
          autoPrint(order).finally(() => retryingIds.current.delete(order.id))
        }
      }

      knownOrderIds.current = newOrderIds
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
    return () => {
      clearInterval(interval)
      // Don't tear down the audio element on unmount — it's module-level
      // and will be reused by the next mount. We do pause it so a stale
      // chime doesn't keep playing if the tablet navigates away mid-loop.
      const a = getAudioElement()
      if (a && isPlayingRef.current) {
        a.pause()
        a.currentTime = 0
        isPlayingRef.current = false
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
