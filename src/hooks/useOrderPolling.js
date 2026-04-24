import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { printOrder } from '../utils/epsonPrint'

// ── Web Audio chime generator ──
function createChime(audioCtx) {
  const now = audioCtx.currentTime
  const frequencies = [880, 1108.73, 1318.51]
  frequencies.forEach((freq, i) => {
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, now)
    gain.gain.setValueAtTime(0, now + i * 0.08)
    gain.gain.linearRampToValueAtTime(0.3, now + i * 0.08 + 0.05)
    gain.gain.linearRampToValueAtTime(0, now + i * 0.08 + 0.6)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(now + i * 0.08)
    osc.stop(now + i * 0.08 + 0.7)
  })
}

export function useOrderPolling(restaurant, hours) {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const audioCtxRef = useRef(null)
  const chimeIntervalRef = useRef(null)
  const knownOrderIds = useRef(new Set())
  const hasNewAlert = useRef(false)

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

  function startChime() {
    if (hasNewAlert.current) return
    hasNewAlert.current = true
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    createChime(audioCtxRef.current)
    chimeIntervalRef.current = setInterval(() => {
      if (audioCtxRef.current) createChime(audioCtxRef.current)
    }, 3000)
  }

  function stopChime() {
    hasNewAlert.current = false
    if (chimeIntervalRef.current) {
      clearInterval(chimeIntervalRef.current)
      chimeIntervalRef.current = null
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

    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .in('status', ['new', 'in_progress', 'complete', 'cancelled'])
      .order('created_at', { ascending: false })

    if (data) {
      const newOrderIds = new Set(data.map(o => o.id))
      const freshNew = data.filter(
        o => o.status === 'new' && !knownOrderIds.current.has(o.id)
      )

      if (freshNew.length > 0 && knownOrderIds.current.size > 0) {
        startChime()
        for (const newOrder of freshNew) {
          autoPrint(newOrder)
        }
      }

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
    }
  }, [restaurant])

  // Polling loop — runs at TabletPage level, survives tab switches
  useEffect(() => {
    fetchOrders()
    const interval = setInterval(() => {
      if (isRestaurantOpen()) fetchOrders()
    }, 10000)
    return () => { clearInterval(interval); stopChime() }
  }, [fetchOrders])

  return {
    orders,
    setOrders,
    loading,
    stopChime,
    fetchOrders,
  }
}
