import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { printOrder } from '../../utils/epsonPrint'

// ── Web Audio chime generator ──
function createChime(audioCtx) {
  const now = audioCtx.currentTime
  const frequencies = [880, 1108.73, 1318.51] // A5, C#6, E6 (A major chord)

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

// ── Format helpers ──
function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatMoney(amount) {
  return `$${Number(amount).toFixed(2)}`
}

// ── Order Card ──
function OrderCard({ order, onTap }) {
  const isDelivery = order.order_type === 'delivery'
  const borderColor = isDelivery ? 'border-l-blue-500' : 'border-l-[#16A34A]'
  const isNew = order.status === 'new'

  return (
    <button
      onClick={() => onTap(order)}
      className={`w-full text-left bg-white rounded-xl border border-gray-200 border-l-4 ${borderColor} p-4 shadow-sm hover:shadow-md transition-shadow ${isNew ? 'animate-pulse-subtle' : ''}`}
    >
      <div className="flex items-center gap-2 mb-1">
        {isDelivery ? (
          <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10l2-1 2 1 2-1 2 1zm6-6h-2l-2 6h-2m4-6V6a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-[#16A34A]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
          </svg>
        )}
        <span className="font-bold text-sm tracking-wide uppercase">
          {isDelivery ? 'DELIVERY' : 'PICKUP'}
        </span>
      </div>
      <div className="flex justify-between items-center text-gray-600 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-gray-900">#{order.order_number}</span>
          {order.print_status === 'printed' && <span className="text-green-500 text-xs">✓</span>}
          {order.print_status === 'failed' && <span className="text-red-500 text-xs">⚠</span>}
          {order.print_status === 'pending' && <span className="text-gray-400 text-xs">⏳</span>}
        </div>
        <span>{formatTime(order.created_at)}</span>
      </div>
    </button>
  )
}

// ── Order Detail ──
function OrderDetail({ order, restaurant, onBack, onStatusChange }) {
  const [items, setItems] = useState([])
  const [printLogs, setPrintLogs] = useState([])
  const [showReprint, setShowReprint] = useState(false)
  const [showStatusOptions, setShowStatusOptions] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showAdjustForm, setShowAdjustForm] = useState(false)
  const [adjustType, setAdjustType] = useState('refund')
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustNote, setAdjustNote] = useState('')
  const [adjustSubmitted, setAdjustSubmitted] = useState(false)
  const [adjustments, setAdjustments] = useState([])
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    fetchOrderDetails()
  }, [order.id])

  async function fetchOrderDetails() {
    const { data: itemsData } = await supabase
      .from('order_items')
      .select('*, order_item_toppings(*)')
      .eq('order_id', order.id)
      .order('created_at')

    setItems(itemsData || [])

    const { data: logs } = await supabase
      .from('print_logs')
      .select('*')
      .eq('order_id', order.id)
      .order('created_at')

    setPrintLogs(logs || [])

    if (order.status === 'complete') {
      const { data: adj } = await supabase
        .from('adjustment_requests')
        .select('*')
        .eq('order_id', order.id)
        .order('created_at', { ascending: false })

      setAdjustments(adj || [])
    }
  }

  async function updateStatus(newStatus) {
    setUpdating(true)

    if (newStatus === 'cancelled') {
      // Trigger Stripe refund via edge function
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-refund`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ order_id: order.id, type: 'full' }),
          }
        )
        const result = await res.json()
        if (!result.success) {
          alert(`Refund failed: ${result.error || 'Unknown error'}`)
          setUpdating(false)
          setShowCancelConfirm(false)
          return
        }
      } catch (err) {
        alert('Refund request failed. Please try again.')
        setUpdating(false)
        setShowCancelConfirm(false)
        return
      }
    } else {
      const { error } = await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', order.id)

      if (error) {
        setUpdating(false)
        return
      }
    }

    onStatusChange({ ...order, status: newStatus })
    setUpdating(false)
    setShowStatusOptions(false)
    setShowCancelConfirm(false)
  }

  async function handleReprint() {
    if (!restaurant.printer_ip) {
      setShowReprint(false)
      return
    }

    // Fetch full order with items and toppings for printing
    const { data: fullOrder } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order.id)
      .single()

    const { data: orderItems } = await supabase
      .from('order_items')
      .select('*, order_item_toppings(*)')
      .eq('order_id', order.id)
      .order('created_at')

    const result = await printOrder(restaurant.printer_ip, { ...fullOrder, items: orderItems || [] }, { name: restaurant.name, address: restaurant.address, phone: restaurant.phone })

    // Log the print attempt and update order print_status
    await supabase.from('print_logs').insert({
      order_id: order.id,
      order_number: order.order_number,
      restaurant_id: restaurant.id,
      attempt_number: printLogs.length + 1,
      status: result.success ? 'success' : 'failed',
      error_message: result.success ? null : result.message,
    })
    await supabase.from('orders').update({
      print_status: result.success ? 'printed' : 'failed',
      print_attempts: printLogs.length + 1,
    }).eq('id', order.id)

    fetchOrderDetails()
    setShowReprint(false)
  }

  async function submitAdjustment() {
    if (!adjustAmount || !adjustNote.trim()) return
    setUpdating(true)

    const { error } = await supabase.from('adjustment_requests').insert({
      order_id: order.id,
      order_number: order.order_number,
      restaurant_id: restaurant.id,
      type: adjustType,
      amount: parseFloat(adjustAmount),
      note: adjustNote.trim(),
    })

    if (!error) {
      setAdjustSubmitted(true)
      setShowAdjustForm(false)
      setAdjustAmount('')
      setAdjustNote('')
      fetchOrderDetails()
    }
    setUpdating(false)
  }

  const isDelivery = order.order_type === 'delivery'

  return (
    <div className="fixed inset-0 flex flex-col bg-white overflow-hidden z-20">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 p-4 border-b border-gray-200">
        <button
          onClick={onBack}
          className="w-11 h-11 flex items-center justify-center rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h2 className="text-xl font-bold">
            {isDelivery ? 'DELIVERY' : 'PICKUP'} #{order.order_number}
          </h2>
          <p className="text-sm text-gray-500">{formatTime(order.created_at)}</p>
        </div>
        <span className={`ml-auto px-3 py-1 rounded-full text-xs font-semibold uppercase ${
          order.status === 'new' ? 'bg-yellow-100 text-yellow-800' :
          order.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
          order.status === 'complete' ? 'bg-green-100 text-green-800' :
          'bg-red-100 text-red-800'
        }`}>
          {order.status === 'in_progress' ? 'In Progress' : order.status}
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-6" style={{ WebkitOverflowScrolling: 'touch' }}>
        {/* Customer info */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Customer</h3>
          <p className="text-lg font-medium">{order.customer_name}</p>
          <a href={`tel:${order.customer_phone}`} className="text-[#16A34A] text-lg font-medium">
            {order.customer_phone}
          </a>
          {isDelivery && order.delivery_address && (
            <p className="text-gray-700">{order.delivery_address}</p>
          )}
        </div>

        {/* Order items */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Items</h3>
          {items.map(item => (
            <div key={item.id} className="space-y-1">
              <p className="font-bold text-base">
                {item.quantity}x {item.item_name}{item.size_name ? ` (${item.size_name})` : ''}
              </p>
              {item.order_item_toppings?.map(t => (
                <p key={t.id} className="pl-6 text-sm text-gray-600">
                  {t.placement_type === 'addon'
                    ? `${t.topping_name}   ${Number(t.price_charged) === 0 ? 'Free' : `+${formatMoney(t.price_charged)}${item.quantity > 1 ? ' ea' : ''}`}`
                    : `${t.placement.toUpperCase()}: ${t.topping_name}   ${Number(t.price_charged) === 0 ? 'Free' : `+${formatMoney(t.price_charged)}${item.quantity > 1 ? ' ea' : ''}`}`}
                </p>
              ))}
              {item.special_instructions && (
                <p className="pl-6 text-sm italic text-gray-400">{item.special_instructions}</p>
              )}
            </div>
          ))}
        </div>

        {order.include_utensils && (
          <p className="text-sm text-[#16A34A] font-medium mt-2">✓ Include napkins & utensils</p>
        )}

        {/* Price breakdown */}
        <div className="space-y-1 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Total</h3>
          <Row label="Subtotal" value={formatMoney(order.subtotal)} />
          {Number(order.discount_amount) > 0 && (
            <Row label={`Discount (${order.discount_percentage}%)`} value={`-${formatMoney(order.discount_amount)}`} className="text-green-600" />
          )}
          {isDelivery && Number(order.delivery_fee) > 0 && (
            <Row label="Delivery Fee" value={formatMoney(order.delivery_fee)} />
          )}
          <Row label="Tax" value={formatMoney(order.tax_amount)} />
          {Number(order.tip_amount) > 0 && (
            <Row label="Tip" value={formatMoney(order.tip_amount)} />
          )}
          <Row label="Service Fee" value={formatMoney(order.service_fee)} />
          <div className="flex justify-between font-bold text-lg pt-1 border-t border-gray-100 mt-1">
            <span>Total</span>
            <span>{formatMoney(order.total_amount)}</span>
          </div>
        </div>

        {/* Print log */}
        {printLogs.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Print Log</h3>
            {printLogs.map(log => (
              <div key={log.id} className="flex items-center gap-2 text-sm">
                <span className={log.status === 'success' ? 'text-green-600' : 'text-red-500'}>
                  {log.status === 'success' ? '✓' : '✗'}
                </span>
                <span className="text-gray-600">
                  Attempt {log.attempt_number} — {formatTime(log.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Existing adjustments */}
        {adjustments.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Adjustments</h3>
            {adjustments.map(adj => (
              <div key={adj.id} className="flex items-center justify-between text-sm p-2 bg-gray-50 rounded-lg">
                <span>
                  {adj.type === 'refund' ? '- Refund' : '+ Charge'} {formatMoney(adj.amount)}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  adj.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                  adj.status === 'approved' ? 'bg-green-100 text-green-800' :
                  'bg-red-100 text-red-800'
                }`}>
                  {adj.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {adjustSubmitted && (
          <div className="bg-green-50 text-green-800 text-sm p-3 rounded-xl text-center">
            Your adjustment request has been submitted
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div className="shrink-0 px-4 pt-4 border-t border-gray-200 bg-white z-10 space-y-3" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))' }}>
        {/* Reprint confirmation */}
        {showReprint && (
          <div className="bg-gray-50 p-4 rounded-xl space-y-3">
            <p className="text-center font-medium">Reprint this order?</p>
            <div className="flex gap-3">
              <button onClick={() => setShowReprint(false)} className="flex-1 h-12 rounded-xl border border-gray-300 font-semibold">No</button>
              <button onClick={handleReprint} className="flex-1 h-12 rounded-xl bg-[#16A34A] text-white font-semibold">Yes</button>
            </div>
          </div>
        )}

        {/* Cancel confirmation */}
        {showCancelConfirm && (
          <div className="bg-red-50 p-4 rounded-xl space-y-3">
            <p className="text-center font-medium text-red-800">Cancel this order? The customer will be refunded.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowCancelConfirm(false)} className="flex-1 h-12 rounded-xl border border-gray-300 font-semibold">No</button>
              <button
                onClick={() => updateStatus('cancelled')}
                disabled={updating}
                className="flex-1 h-12 rounded-xl bg-red-600 text-white font-semibold disabled:opacity-50"
              >
                Yes, Cancel
              </button>
            </div>
          </div>
        )}

        {/* Status options */}
        {showStatusOptions && !showCancelConfirm && (
          <div className="bg-gray-50 p-4 rounded-xl space-y-3">
            {order.status === 'new' && (
              <button
                onClick={() => updateStatus('in_progress')}
                disabled={updating}
                className="w-full h-12 rounded-xl bg-blue-600 text-white font-semibold disabled:opacity-50"
              >
                Mark In Progress
              </button>
            )}
            {order.status === 'in_progress' && (
              <button
                onClick={() => updateStatus('complete')}
                disabled={updating}
                className="w-full h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                Mark Complete
              </button>
            )}
            <button
              onClick={() => setShowCancelConfirm(true)}
              className="w-full h-12 rounded-xl bg-red-600 text-white font-semibold"
            >
              Cancel Order
            </button>
            <button
              onClick={() => setShowStatusOptions(false)}
              className="w-full h-12 rounded-xl border border-gray-300 font-semibold"
            >
              Back
            </button>
          </div>
        )}

        {/* Adjust form (complete orders) */}
        {showAdjustForm && (
          <div className="bg-gray-50 p-4 rounded-xl space-y-3">
            <div className="flex gap-2">
              <button
                onClick={() => setAdjustType('refund')}
                className={`flex-1 h-11 rounded-xl font-semibold transition-colors ${adjustType === 'refund' ? 'bg-red-600 text-white' : 'border border-gray-300'}`}
              >
                - Refund
              </button>
              <button
                onClick={() => setAdjustType('charge')}
                className={`flex-1 h-11 rounded-xl font-semibold transition-colors ${adjustType === 'charge' ? 'bg-blue-600 text-white' : 'border border-gray-300'}`}
              >
                + Charge
              </button>
            </div>
            <div>
              <label className="text-sm text-gray-500">Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={adjustAmount}
                  onChange={e => setAdjustAmount(e.target.value)}
                  className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-xl"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-gray-500">Note (required)</label>
              <input
                type="text"
                value={adjustNote}
                onChange={e => setAdjustNote(e.target.value)}
                className="w-full h-11 px-3 border border-gray-300 rounded-xl"
                placeholder="Reason for adjustment..."
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowAdjustForm(false); setAdjustAmount(''); setAdjustNote('') }}
                className="flex-1 h-12 rounded-xl border border-gray-300 font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={submitAdjustment}
                disabled={updating || !adjustAmount || !adjustNote.trim()}
                className="flex-1 h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                Submit Request
              </button>
            </div>
          </div>
        )}

        {/* Main action buttons */}
        {!showReprint && !showStatusOptions && !showCancelConfirm && !showAdjustForm && (
          <div className="flex gap-3">
            <button
              onClick={() => setShowReprint(true)}
              className="flex-1 h-14 rounded-xl border-2 border-gray-300 font-bold text-base"
            >
              REPRINT
            </button>
            {order.status === 'complete' ? (
              <button
                onClick={() => setShowAdjustForm(true)}
                className="flex-1 h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base"
              >
                ADJUST
              </button>
            ) : order.status !== 'cancelled' ? (
              <button
                onClick={() => setShowStatusOptions(true)}
                className="flex-1 h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base"
              >
                UPDATE STATUS
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, className = '' }) {
  return (
    <div className={`flex justify-between text-sm ${className}`}>
      <span className="text-gray-500">{label}</span>
      <span>{value}</span>
    </div>
  )
}

// ── Main OrdersTab ──
export default function OrdersTab({ restaurant, setRestaurant, hours }) {
  const [subTab, setSubTab] = useState('new')
  const [orders, setOrders] = useState([])
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [loading, setLoading] = useState(true)
  const audioCtxRef = useRef(null)
  const chimeIntervalRef = useRef(null)
  const knownOrderIds = useRef(new Set())
  const hasNewAlert = useRef(false)

  const subTabs = [
    { key: 'new', label: 'New' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'complete', label: 'Complete' },
  ]

  const fetchOrders = useCallback(async () => {
    if (!restaurant) return

    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .in('status', ['new', 'in_progress', 'complete', 'cancelled'])
      .order('created_at', { ascending: false })

    if (data) {
      // Detect new orders
      const newOrderIds = new Set(data.map(o => o.id))
      const freshNew = data.filter(
        o => o.status === 'new' && !knownOrderIds.current.has(o.id)
      )

      if (freshNew.length > 0 && knownOrderIds.current.size > 0) {
        startChime()

        // Auto-print new orders
        if (restaurant.printer_ip) {
          for (const newOrder of freshNew) {
            const { data: orderItems } = await supabase
              .from('order_items')
              .select('*, order_item_toppings(*)')
              .eq('order_id', newOrder.id)
              .order('created_at')

            printOrder(restaurant.printer_ip, { ...newOrder, items: orderItems || [] }, { name: restaurant.name, address: restaurant.address, phone: restaurant.phone })
              .then(async (result) => {
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
              })
          }
        }
      }

      knownOrderIds.current = newOrderIds
      setOrders(data)
      setLoading(false)
    }
  }, [restaurant])

  function isRestaurantOpen() {
    if (!hours || hours.length === 0) return true // default to polling if no hours set
    const now = new Date()
    const dayOfWeek = now.getDay()
    const currentTime = now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
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

  function handleOrderTap(order) {
    if (order.status === 'new') {
      stopChime()
    }
    setSelectedOrder(order)
  }

  function handleStatusChange(updatedOrder) {
    setOrders(prev => prev.map(o => o.id === updatedOrder.id ? updatedOrder : o))
    setSelectedOrder(updatedOrder)
  }

  // Initial fetch + polling
  useEffect(() => {
    fetchOrders()

    const interval = setInterval(() => {
      if (isRestaurantOpen()) {
        fetchOrders()
      }
    }, 10000)

    return () => {
      clearInterval(interval)
      stopChime()
    }
  }, [fetchOrders])

  const filteredOrders = orders.filter(o => {
    if (subTab === 'complete') return o.status === 'complete' || o.status === 'cancelled'
    return o.status === subTab
  })

  if (selectedOrder) {
    return (
      <OrderDetail
        order={selectedOrder}
        restaurant={restaurant}
        onBack={() => setSelectedOrder(null)}
        onStatusChange={handleStatusChange}
      />
    )
  }

  async function toggleDelivery() {
    const newVal = !restaurant.delivery_available
    const { data } = await supabase
      .from('restaurants')
      .update({ delivery_available: newVal })
      .eq('id', restaurant.id)
      .select()
      .single()
    if (data) setRestaurant(data)
  }

  return (
    <div className="h-full flex flex-col">
      {/* Delivery toggle */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-100">
        <span className={`text-sm font-medium ${restaurant.delivery_available ? 'text-gray-900' : 'text-gray-400'}`}>
          Delivery: {restaurant.delivery_available ? 'ON' : 'OFF'}
        </span>
        <button
          onClick={toggleDelivery}
          className={`relative w-12 h-7 rounded-full transition-colors ${restaurant.delivery_available ? 'bg-[#16A34A]' : 'bg-gray-300'}`}
        >
          <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${restaurant.delivery_available ? 'left-5.5' : 'left-0.5'}`} />
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-gray-200 bg-white">
        {subTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSubTab(tab.key)}
            className={`flex-1 py-3 text-sm font-semibold transition-colors ${
              subTab === tab.key
                ? 'text-[#16A34A] border-b-2 border-[#16A34A]'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {tab.key === 'new' && orders.filter(o => o.status === 'new').length > 0 && (
              <span className="ml-2 bg-red-500 text-white text-xs rounded-full px-2 py-0.5">
                {orders.filter(o => o.status === 'new').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Order list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <p className="text-center text-gray-400 mt-8">Loading orders...</p>
        ) : filteredOrders.length === 0 ? (
          <p className="text-center text-gray-400 mt-8">No {subTab === 'in_progress' ? 'in progress' : subTab} orders</p>
        ) : (
          filteredOrders.map(order => (
            <OrderCard key={order.id} order={order} onTap={handleOrderTap} />
          ))
        )}
      </div>
    </div>
  )
}
