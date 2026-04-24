import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

function formatMoney(v) { return `$${Number(v).toFixed(2)}` }
function formatTime(d) { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) }
function formatDate(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }

// ── Adjustments Panel ──
function AdjustmentsPanel({ adjustments, restaurants, onAction }) {
  const [processing, setProcessing] = useState(null)

  async function handleAction(adj, action) {
    setProcessing(adj.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        alert('Session expired. Please log in again.')
        return
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-approve-adjustment`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ adjustment_id: adj.id, action }),
        }
      )
      const result = await res.json()
      console.log('[Adjustment]', action, adj.id, result)

      if (result.success) {
        onAction(adj.id, action === 'approve' ? 'approved' : 'denied')
      } else {
        alert(`${action === 'approve' ? 'Approval' : 'Denial'} failed: ${result.error || 'Unknown error'}`)
      }
    } catch (err) {
      console.error('[Adjustment] Error:', err)
      alert(`Request failed: ${err.message}`)
    } finally {
      setProcessing(null)
    }
  }

  if (adjustments.length === 0) return null

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
      <h3 className="font-semibold text-amber-800 mb-3">
        ⚠️ {adjustments.length} Pending Adjustment Request{adjustments.length > 1 ? 's' : ''}
      </h3>
      <div className="space-y-3">
        {adjustments.map(adj => {
          const rest = restaurants.find(r => r.id === adj.restaurant_id)
          return (
            <div key={adj.id} className="bg-white rounded-lg p-3 flex items-center justify-between gap-4 border border-amber-100">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  Order #{adj.order_number} — {rest?.name || 'Unknown'}
                </p>
                <p className="text-sm text-gray-500">
                  {adj.type === 'refund' ? '- Refund' : '+ Charge'} {formatMoney(adj.amount)} — {adj.note}
                </p>
                <p className="text-xs text-gray-400">{formatDate(adj.created_at)} {formatTime(adj.created_at)}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => handleAction(adj, 'approve')}
                  disabled={processing === adj.id}
                  className="px-3 py-1.5 bg-[#16A34A] text-white text-xs font-semibold rounded-lg disabled:opacity-50"
                >
                  APPROVE
                </button>
                <button
                  onClick={() => handleAction(adj, 'deny')}
                  disabled={processing === adj.id}
                  className="px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
                >
                  DENY
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Order Detail Panel ──
function OrderDetailPanel({ order, onClose, onRefresh }) {
  const [items, setItems] = useState([])
  const [printLogs, setPrintLogs] = useState([])
  const [showPartialRefund, setShowPartialRefund] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [processing, setProcessing] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetchDetails()
  }, [order.id])

  async function fetchDetails() {
    const [itemsRes, logsRes] = await Promise.all([
      supabase.from('order_items').select('*, order_item_toppings(*)').eq('order_id', order.id).order('created_at'),
      supabase.from('print_logs').select('*').eq('order_id', order.id).order('created_at'),
    ])
    setItems(itemsRes.data || [])
    setPrintLogs(logsRes.data || [])
  }

  async function callEdgeFunction(path, body) {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
    return res.json()
  }

  async function handleReprint() {
    setProcessing(true)
    setMessage('')
    const result = await callEdgeFunction('retry-print', { order_id: order.id })
    setMessage(result.success ? 'Print job sent' : `Print failed: ${result.message || result.error}`)
    fetchDetails()
    setProcessing(false)
  }

  async function handleFullRefund() {
    if (!confirm('Fully refund and cancel this order?')) return
    setProcessing(true)
    setMessage('')
    const result = await callEdgeFunction('admin-refund', { order_id: order.id, type: 'full' })
    setMessage(result.success ? 'Full refund processed' : `Error: ${result.error}`)
    if (result.success) onRefresh()
    setProcessing(false)
  }

  async function handlePartialRefund() {
    if (!refundAmount) return
    setProcessing(true)
    setMessage('')
    const result = await callEdgeFunction('admin-refund', {
      order_id: order.id,
      type: 'partial',
      amount: parseFloat(refundAmount),
    })
    setMessage(result.success ? `Partial refund of ${formatMoney(refundAmount)} processed` : `Error: ${result.error}`)
    setShowPartialRefund(false)
    setRefundAmount('')
    setProcessing(false)
  }

  const isDelivery = order.order_type === 'delivery'

  return (
    <div className="h-full flex flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between p-4 border-b border-gray-200">
        <h3 className="font-bold text-lg">Order #{order.order_number}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <div className="flex gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${
            order.status === 'new' ? 'bg-yellow-100 text-yellow-800' :
            order.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
            order.status === 'complete' ? 'bg-green-100 text-green-800' :
            'bg-red-100 text-red-800'
          }`}>{order.status === 'in_progress' ? 'In Progress' : order.status}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${isDelivery ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'}`}>
            {isDelivery ? 'Delivery' : 'Pickup'}
          </span>
        </div>

        <div>
          <p className="text-sm text-gray-500">Customer</p>
          <p className="font-medium">{order.customer_name}</p>
          <p className="text-sm">{order.customer_phone} &middot; {order.customer_email}</p>
          {isDelivery && order.delivery_address && <p className="text-sm text-gray-600 mt-1">{order.delivery_address}</p>}
        </div>

        <div>
          <p className="text-sm text-gray-500 mb-2">Items</p>
          {items.map(item => (
            <div key={item.id} className="mb-2">
              <p className="text-sm font-semibold">
                {item.quantity}x {item.item_name}{item.size_name ? ` — ${item.size_name}` : ''} <span className="text-gray-500 font-normal">{formatMoney(item.base_price * item.quantity)}</span>
              </p>
              {item.order_item_toppings?.map(t => (
                <p key={t.id} className="text-xs text-gray-500 pl-4">
                  {t.placement_type === 'addon'
                    ? `${t.topping_name}   ${Number(t.price_charged) === 0 ? 'Free' : `+${formatMoney(t.price_charged)}`}`
                    : `${t.placement.toUpperCase()}: ${t.topping_name}   ${Number(t.price_charged) === 0 ? 'Free' : `+${formatMoney(t.price_charged)}`}`}
                </p>
              ))}
              {item.special_instructions && <p className="text-xs italic text-gray-400 pl-4">{item.special_instructions}</p>}
            </div>
          ))}
        </div>

        <div className="text-sm space-y-1 border-t pt-3">
          <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span>{formatMoney(order.subtotal)}</span></div>
          {Number(order.discount_amount) > 0 && <div className="flex justify-between text-green-600"><span>Discount ({order.discount_percentage}%)</span><span>-{formatMoney(order.discount_amount)}</span></div>}
          {isDelivery && Number(order.delivery_fee) > 0 && <div className="flex justify-between"><span className="text-gray-500">Delivery Fee</span><span>{formatMoney(order.delivery_fee)}</span></div>}
          <div className="flex justify-between"><span className="text-gray-500">Tax</span><span>{formatMoney(order.tax_amount)}</span></div>
          {Number(order.tip_amount) > 0 && <div className="flex justify-between"><span className="text-gray-500">Tip</span><span>{formatMoney(order.tip_amount)}</span></div>}
          <div className="flex justify-between"><span className="text-gray-500">Service Fee</span><span>{formatMoney(order.service_fee)}</span></div>
          <div className="flex justify-between font-bold border-t pt-1"><span>Total</span><span>{formatMoney(order.total_amount)}</span></div>
        </div>

        {printLogs.length > 0 && (
          <div>
            <p className="text-sm text-gray-500 mb-1">Print Log</p>
            {printLogs.map(l => (
              <p key={l.id} className="text-xs text-gray-600">
                {l.status === 'success' ? '✓' : '✗'} Attempt {l.attempt_number} — {formatTime(l.created_at)}
                {l.error_message && <span className="text-red-500"> ({l.error_message})</span>}
              </p>
            ))}
          </div>
        )}

        {message && <p className="text-sm text-center text-[#16A34A] bg-green-50 rounded p-2">{message}</p>}
      </div>

      <div className="p-4 border-t space-y-2">
        <button onClick={handleReprint} disabled={processing} className="w-full h-10 rounded-lg border border-gray-300 font-semibold text-sm disabled:opacity-50">
          REPRINT
        </button>
        <div className="flex gap-2">
          <button onClick={handleFullRefund} disabled={processing} className="flex-1 h-10 rounded-lg bg-red-600 text-white font-semibold text-sm disabled:opacity-50">
            FULL REFUND
          </button>
          <button onClick={() => setShowPartialRefund(!showPartialRefund)} disabled={processing} className="flex-1 h-10 rounded-lg border border-red-300 text-red-600 font-semibold text-sm disabled:opacity-50">
            PARTIAL REFUND
          </button>
        </div>
        {showPartialRefund && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
              <input
                type="number" min="0.01" step="0.01" value={refundAmount}
                onChange={e => setRefundAmount(e.target.value)}
                className="w-full h-10 pl-7 pr-3 border border-gray-300 rounded-lg text-sm"
                placeholder="0.00"
              />
            </div>
            <button onClick={handlePartialRefund} disabled={processing || !refundAmount} className="px-4 h-10 rounded-lg bg-red-600 text-white text-sm font-semibold disabled:opacity-50">
              Refund
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Orders Tab ──
export default function OrdersTab() {
  const [orders, setOrders] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [adjustments, setAdjustments] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState(null)

  // Filters
  const [filterRestaurant, setFilterRestaurant] = useState('all')
  const [filterDate, setFilterDate] = useState('today')
  const [filterStatus, setFilterStatus] = useState('all')

  useEffect(() => { fetchAll() }, [filterRestaurant, filterDate, filterStatus])

  async function fetchAll() {
    setLoading(true)
    const [restRes, adjRes] = await Promise.all([
      supabase.from('restaurants').select('id, name').order('name'),
      supabase.from('adjustment_requests').select('*').eq('status', 'pending').order('created_at'),
    ])
    setRestaurants(restRes.data || [])
    setAdjustments(adjRes.data || [])

    // Build orders query
    let query = supabase.from('orders').select('*, restaurants!inner(name)').order('created_at', { ascending: false })

    if (filterRestaurant !== 'all') query = query.eq('restaurant_id', filterRestaurant)
    if (filterStatus !== 'all') query = query.eq('status', filterStatus)

    // Date filter
    const now = new Date()
    if (filterDate === 'today') {
      query = query.gte('created_at', new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString())
    } else if (filterDate === 'week') {
      const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7)
      query = query.gte('created_at', weekAgo.toISOString())
    } else if (filterDate === 'month') {
      const monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1)
      query = query.gte('created_at', monthAgo.toISOString())
    }

    const { data } = await query.limit(200)
    setOrders(data || [])
    setLoading(false)
  }

  function handleAdjustmentAction(adjId, newStatus) {
    setAdjustments(prev => prev.filter(a => a.id !== adjId))
  }

  function printStatusBadge(order) {
    if (order.print_status === 'printed') return <span className="text-green-600 text-xs">✓ Printed</span>
    if (order.print_status === 'failed') return <span className="text-red-500 text-xs">⚠️ Failed</span>
    return <span className="text-gray-400 text-xs">⏳ Pending</span>
  }

  function statusBadge(status) {
    const styles = {
      new: 'bg-yellow-100 text-yellow-800',
      in_progress: 'bg-blue-100 text-blue-800',
      complete: 'bg-green-100 text-green-800',
      cancelled: 'bg-red-100 text-red-800',
    }
    return (
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status] || 'bg-gray-100'}`}>
        {status === 'in_progress' ? 'In Progress' : status}
      </span>
    )
  }

  return (
    <div className="h-full flex">
      {/* Main content */}
      <div className={`flex-1 overflow-y-auto p-6 ${selectedOrder ? 'max-w-[calc(100%-400px)]' : ''}`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">All Orders</h2>
          {adjustments.length > 0 && (
            <span className="bg-amber-100 text-amber-800 text-xs font-semibold px-2 py-1 rounded-full">
              {adjustments.length} Pending Adjustment{adjustments.length > 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4 flex-wrap">
          <select value={filterRestaurant} onChange={e => setFilterRestaurant(e.target.value)}
            className="h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white">
            <option value="all">All Restaurants</option>
            {restaurants.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={filterDate} onChange={e => setFilterDate(e.target.value)}
            className="h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white">
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="all">All Time</option>
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white">
            <option value="all">All Statuses</option>
            <option value="new">New</option>
            <option value="in_progress">In Progress</option>
            <option value="complete">Complete</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {/* Adjustments */}
        <AdjustmentsPanel adjustments={adjustments} restaurants={restaurants} onAction={handleAdjustmentAction} />

        {/* Orders table */}
        {loading ? (
          <p className="text-gray-400 text-center mt-8">Loading orders...</p>
        ) : orders.length === 0 ? (
          <p className="text-gray-400 text-center mt-8">No orders found</p>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Order#</th>
                  <th className="px-4 py-3">Restaurant</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Print</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr
                    key={order.id}
                    onClick={() => setSelectedOrder(order)}
                    className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${selectedOrder?.id === order.id ? 'bg-green-50' : ''}`}
                  >
                    <td className="px-4 py-3 font-medium">#{order.order_number}</td>
                    <td className="px-4 py-3">{order.restaurants?.name}</td>
                    <td className="px-4 py-3">{order.customer_name}</td>
                    <td className="px-4 py-3 capitalize">{order.order_type}</td>
                    <td className="px-4 py-3">{statusBadge(order.status)}</td>
                    <td className="px-4 py-3 font-medium">{formatMoney(order.total_amount)}</td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(order.created_at)} {formatTime(order.created_at)}</td>
                    <td className="px-4 py-3">{printStatusBadge(order)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedOrder && (
        <div className="w-[400px] shrink-0">
          <OrderDetailPanel
            order={selectedOrder}
            onClose={() => setSelectedOrder(null)}
            onRefresh={fetchAll}
          />
        </div>
      )}
    </div>
  )
}
