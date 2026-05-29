import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { printOrder } from '../../utils/epsonPrint'
import { formatPhone } from '../../utils/format'
import { formatScheduledLabel, groupOrdersByCreatedAtNy } from '../../utils/scheduling'

const DAY_MS = 24 * 60 * 60 * 1000

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

// M10: Format a timestamp as H:MM AM/PM in Eastern Time. Distinct from
// formatTime() which uses the browser's local timezone — formatTimeNY pins
// to America/New_York so the displayed pickup commitment matches what was
// sent to Uber regardless of tablet/browser locale settings.
// TODO: When expanding beyond Eastern Time markets, replace hardcoded
// 'America/New_York' with restaurant-level timezone column. See
// user_memories for context.
function formatTimeNY(dateStr) {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  })
}

// M10 + UI-polish: Uber Direct status label + color mapping for tile + detail
// display. Maps Uber's lifecycle states to operator-friendly phrases. Used by
// the tile's status line AND the detail-panel header. Friendlier labels (UI
// polish) replace the terser M10 set. *_in_progress aliases are kept
// defensively — Uber has sent both forms. Unknown statuses fall through.
function getUberStatusDisplay(uber_status) {
  switch (uber_status) {
    case 'pending':
      return { label: 'Searching for courier', color: 'text-gray-500' }
    case 'pickup_in_progress':
    case 'pickup':
      return { label: 'Courier en route', color: 'text-gray-500' }
    case 'pickup_complete':
      return { label: 'Picked up', color: 'text-gray-500' }
    case 'dropoff':
    case 'dropoff_in_progress':
      return { label: 'Delivering', color: 'text-gray-500' }
    case 'delivered':
      return { label: 'Delivered', color: 'text-green-700' }
    case 'canceled':
      return { label: 'Canceled', color: 'text-red-700' }
    case 'failed':
      return { label: 'Failed', color: 'text-red-700' }
    case 'returned':
      return { label: 'Returned', color: 'text-red-700' }
    default:
      return { label: 'Status unknown', color: 'text-gray-500' }
  }
}

// UI-polish (D6): the trailing "· Scheduled X:XX" / "· ETA X:XX" portion of
// the Uber Direct status line. Live ETA supersedes the scheduled pickup once
// a courier reports one. Returns '' when there's nothing to append (so no
// dangling middle-dot appears). All times in Eastern (formatTimeNY), matching
// the M10 pickup-commitment display.
//   - uber_dropoff_eta set & in the future  → " · ETA <time>"     (live)
//   - uber_dropoff_eta set & in the past     → ''                  (stale; hide)
//   - else pending / no status, pickup time  → " · Scheduled <time>"
//   - else                                    → ''
function formatEtaSuffix(order) {
  if (order.uber_dropoff_eta) {
    const etaMs = new Date(order.uber_dropoff_eta).getTime()
    if (!Number.isNaN(etaMs) && etaMs > Date.now()) {
      return ` · ETA ${formatTimeNY(order.uber_dropoff_eta)}`
    }
    return ''
  }
  if ((!order.uber_status || order.uber_status === 'pending') && order.uber_pickup_ready_dt) {
    return ` · Scheduled ${formatTimeNY(order.uber_pickup_ready_dt)}`
  }
  return ''
}

// ── Order Card ──
function OrderCard({ order, onTap, onRetryPrint }) {
  const isDelivery = order.order_type === 'delivery'
  const borderColor = isDelivery ? 'border-l-blue-500' : 'border-l-[#16A34A]'
  const isUnacked = order.status === 'new' && !order.acknowledged_at
  const showRetry = (order.print_status === 'failed' || order.print_status === 'pending') && onRetryPrint

  // Customer info line. Each segment is independently optional so missing
  // phone or address gracefully degrades. delivery_address is only
  // included for delivery orders; for pickup it's omitted even if present.
  const customerInfo = [
    order.customer_name,
    order.customer_phone ? formatPhone(order.customer_phone) : null,
    isDelivery && order.delivery_address ? order.delivery_address : null,
  ].filter(Boolean).join(', ')

  return (
    <div className={`w-full text-left rounded-xl border border-gray-200 border-l-4 ${borderColor} shadow-sm hover:shadow-md transition-shadow ${isUnacked ? 'animate-flash-green' : 'bg-white'}`}>
      <button
        onClick={() => onTap(order)}
        className="w-full text-left p-4"
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
          {order.scheduled_for && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-300 text-black text-xs font-semibold whitespace-nowrap">
              Scheduled {formatScheduledLabel(order.scheduled_for)}
            </span>
          )}
        </div>
        {customerInfo && (
          <div className="text-sm text-gray-500 mb-1 truncate">
            {customerInfo}
          </div>
        )}
        <div className="flex justify-between items-center text-gray-600 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-gray-900">#{order.order_number}</span>
            {order.print_status === 'printed' && <span className="text-green-500 text-xs">✓</span>}
            {order.print_status === 'failed' && <span className="text-red-500 text-xs">⚠</span>}
            {order.print_status === 'pending' && <span className="text-gray-400 text-xs">⏳</span>}
          </div>
          <span>{formatTime(order.created_at)}</span>
        </div>
        {/* UI-polish: Uber Direct status line, now BELOW the order number and
            larger/bolder than the old grey text-xs treatment. Single line,
            middle-dot separated: "UberDirect · <status> · ETA/Scheduled X:XX".
            Live ETA supersedes the scheduled pickup time (formatEtaSuffix).
            Color: blue-700 in-flight, green delivered, red canceled/failed/
            returned. Pre-dispatch shows "awaiting dispatch". */}
        {order.delivery_fulfillment_method === 'uber_direct' && (
          <div className={`mt-1 text-sm font-semibold ${
            order.uber_status === 'delivered' ? 'text-green-700'
              : (order.uber_status === 'canceled' || order.uber_status === 'failed' || order.uber_status === 'returned') ? 'text-red-700'
              : 'text-blue-700'
          }`}>
            {order.uber_status
              ? `UberDirect · ${getUberStatusDisplay(order.uber_status).label}${formatEtaSuffix(order)}`
              : 'UberDirect · awaiting dispatch'}
          </div>
        )}
      </button>
      {showRetry && (
        <div className="px-4 pb-3">
          <button
            onClick={(e) => { e.stopPropagation(); onRetryPrint(order) }}
            className="w-full h-9 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-semibold"
          >
            Retry Print
          </button>
        </div>
      )}
    </div>
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
  // M9a: Uber Direct prep-time + dispatch modal state. Only used when
  // delivery_fulfillment_method === 'uber_direct'.
  const [showPrepTimeModal, setShowPrepTimeModal] = useState(false)
  const [selectedPrepMinutes, setSelectedPrepMinutes] = useState(null)
  const [dispatching, setDispatching] = useState(false)
  // null | { new_fee_cents, original_fee_cents, delta_cents, new_quote_id }
  const [showPriceChangeModal, setShowPriceChangeModal] = useState(null)
  const [adjustType, setAdjustType] = useState('refund')
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustNote, setAdjustNote] = useState('')
  const [adjustSubmitted, setAdjustSubmitted] = useState(false)
  const [adjustments, setAdjustments] = useState([])
  const [updating, setUpdating] = useState(false)
  // M9d: live Uber delivery state, fetched the moment the operator taps
  // "Cancel & Refund Order" so the confirm modal can show policy-derived
  // cancellation messaging. null until fetched; then an object shaped like
  // the uber-get-delivery response: { dispatched, uber_status?,
  // courier_assigned?, dropoff_eta?, fetch_failed? }.
  const [cancelFeeInfo, setCancelFeeInfo] = useState(null)
  const [fetchingFee, setFetchingFee] = useState(false)

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

  // M9d: open the cancel-confirm modal, pre-fetching live Uber delivery
  // state for uber_direct orders so the modal can warn the operator about a
  // possible Uber cancellation fee (or that cancellation is no longer
  // possible). For in_house orders — or uber_direct orders not yet
  // dispatched — there is nothing to fetch; we open the modal immediately
  // with dispatched:false (regular refund, no Uber fee). A fetch failure
  // NEVER blocks the cancel: we set fetch_failed and the modal degrades to
  // "couldn't fetch state, proceed anyway?".
  async function openCancelConfirm() {
    if (order.delivery_fulfillment_method === 'uber_direct' && order.uber_delivery_id) {
      setFetchingFee(true)
      try {
        const { data: { session }, error: refreshError } = await supabase.auth.refreshSession()
        if (refreshError || !session) {
          alert('Session expired. Please log in again.')
          setFetchingFee(false)
          return
        }
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/uber-get-delivery`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ order_id: order.id }),
          }
        )
        const result = await res.json()
        if (result.success) {
          setCancelFeeInfo(result)
        } else {
          // Couldn't read delivery state — degrade gracefully, don't block.
          setCancelFeeInfo({ dispatched: true, uber_status: null, fetch_failed: true })
        }
      } catch (err) {
        setCancelFeeInfo({ dispatched: true, uber_status: null, fetch_failed: true })
      }
      setFetchingFee(false)
    } else {
      // in_house, or uber_direct not yet dispatched: plain refund path.
      setCancelFeeInfo({ dispatched: false })
    }
    setShowCancelConfirm(true)
  }

  // M9d: policy-derived cancellation notice for the confirm modal. Maps the
  // live Uber delivery state (cancelFeeInfo) to plain-language guidance +
  // colour cue. No dollar figure is asserted — Uber exposes no reliable
  // cancellation-fee field; the cost is policy/state-derived (no courier →
  // free; pickup → a pickup fee; in-delivery → a fee). Returns null when
  // there's nothing Uber-specific to say (in_house / not dispatched).
  function uberCancelNotice() {
    if (!cancelFeeInfo || !cancelFeeInfo.dispatched) return null
    if (cancelFeeInfo.fetch_failed || !cancelFeeInfo.uber_status) {
      return {
        text: "Couldn't fetch the current Uber delivery state. Proceed with cancel & refund anyway?",
        cls: 'bg-amber-50 border border-amber-300 text-amber-900',
      }
    }
    switch (cancelFeeInfo.uber_status) {
      case 'pending':
        return {
          text: '✅ No courier assigned yet — no Uber cancellation fee.',
          cls: 'bg-green-50 border border-green-300 text-green-900',
        }
      case 'pickup':
        return {
          text: '⚠️ Courier en route to your restaurant. Uber may charge a small cancellation fee (typically $5). You absorb this.',
          cls: 'bg-amber-50 border border-amber-300 text-amber-900',
        }
      case 'pickup_complete':
        return {
          text: '🚫 Driver has picked up the food. Cancellation likely NOT possible. If you proceed and Uber refuses, no refund will be issued.',
          cls: 'bg-red-50 border border-red-400 text-red-900',
        }
      case 'dropoff':
        return {
          text: '🚫 Driver is delivering now. Cancellation NOT possible — keep order intact.',
          cls: 'bg-red-50 border border-red-400 text-red-900',
        }
      case 'delivered':
        return {
          text: 'Order already delivered. No refund.',
          cls: 'bg-red-50 border border-red-400 text-red-900',
        }
      case 'canceled':
        return {
          text: 'This delivery is already canceled.',
          cls: 'bg-gray-50 border border-gray-300 text-gray-700',
        }
      default:
        return {
          text: `Current delivery state: ${cancelFeeInfo.uber_status}. A cancellation fee may apply — you absorb it.`,
          cls: 'bg-amber-50 border border-amber-300 text-amber-900',
        }
    }
  }

  async function updateStatus(newStatus) {
    setUpdating(true)

    if (newStatus === 'cancelled') {
      // M9c: admin-refund now runs the full cancel cascade server-side. For
      // uber_direct orders it releases the Uber delivery BEFORE refunding
      // Stripe (and refuses to refund if Uber can't cancel — past the window
      // / already picked up). For in_house orders it's the original
      // Stripe-only refund. No client-side branching needed; we just route
      // every cancel through admin-refund and surface its error verbatim.
      // Trigger cancel + refund via edge function
      try {
        const { data: { session }, error: refreshError } = await supabase.auth.refreshSession()
        if (refreshError || !session) {
          alert('Session expired. Please log in again.')
          setUpdating(false)
          setShowCancelConfirm(false)
          return
        }
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
          // M9c: distinguish the cancel-cascade failure modes so the operator
          // understands whether a refund was issued. uber_cancel_failed and
          // already_delivered both mean NO refund happened.
          let message
          if (result.error === 'uber_cancel_failed') {
            message = "Couldn't cancel the Uber delivery (it may be past the cancellation window or already picked up). The order was NOT refunded — contact Uber/customer."
          } else if (result.error === 'already_delivered') {
            message = 'This order has already been delivered. No refund issued.'
          } else {
            message = `Refund failed: ${result.error || 'Unknown error'}`
          }
          alert(message)
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
      // accepted_at stamps the moment the restaurant first acts on a new
      // order — both Accept (scheduled) and Mark In Progress count as
      // acceptance. Don't overwrite on later transitions.
      const updates = { status: newStatus }
      if (order.status === 'new' && (newStatus === 'scheduled' || newStatus === 'in_progress')) {
        updates.accepted_at = new Date().toISOString()
      }
      const { error } = await supabase
        .from('orders')
        .update(updates)
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

  // M9a: derive prep-time bracket options for the dispatch modal.
  // Decision #4: [estimated_delivery_minutes - 10, base, +10, +15], clamped
  // 5-120, deduped. Operator falls back to the Custom input for non-standard
  // cases (e.g., scheduled orders with a longer prep window).
  function prepBrackets() {
    const base = Number(restaurant?.estimated_delivery_minutes) || 30
    const raw = [base - 10, base, base + 10, base + 15]
    const clamped = raw.map(n => Math.max(5, Math.min(120, n)))
    return Array.from(new Set(clamped)).sort((a, b) => a - b)
  }

  // M9a: POST to uber-create-delivery and handle structured response.
  // quoteIdOverride is passed when the operator taps "Accept Anyway" on
  // the price-change modal (carries the new_quote_id back to the function
  // so it can dispatch against the refreshed quote without re-checking).
  async function dispatchToUber(quoteIdOverride = null) {
    if (!selectedPrepMinutes) return
    setDispatching(true)
    try {
      const { data: { session }, error: refreshError } = await supabase.auth.refreshSession()
      if (refreshError || !session) {
        alert('Session expired. Please log in again.')
        return
      }
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/uber-create-delivery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            order_id: order.id,
            pickup_ready_minutes: selectedPrepMinutes,
            ...(quoteIdOverride ? { accepted_quote_id: quoteIdOverride } : {}),
          }),
        }
      )
      const result = await res.json()
      if (result.success) {
        // Successful dispatch (or idempotent re-dispatch). Patch the order
        // in place so the badge appears immediately; the next poll cycle
        // reconciles. updateStatus side effects (accepted_at, status
        // 'in_progress') are persisted server-side; mirror locally so the
        // tablet UI updates without waiting for the poll.
        const patchedOrder = {
          ...order,
          status: 'in_progress',
          accepted_at: order.accepted_at || new Date().toISOString(),
          uber_delivery_id: result.delivery_id,
          uber_tracking_url: result.tracking_url,
          uber_status: result.status,
          uber_dispatched_at: new Date().toISOString(),
        }
        setShowPrepTimeModal(false)
        setShowPriceChangeModal(null)
        setSelectedPrepMinutes(null)
        onStatusChange(patchedOrder)
        return
      }
      // Error branches.
      switch (result.error) {
        case 'quote_price_changed':
          // Pop the secondary modal with delta details. Operator decides.
          setShowPriceChangeModal({
            new_fee_cents: result.new_fee_cents,
            original_fee_cents: result.original_fee_cents,
            delta_cents: result.delta_cents,
            new_quote_id: result.new_quote_id,
          })
          break
        case 'no_uber_available':
          alert("Uber can't dispatch to this address right now. You may need to cancel & refund, or contact the customer.")
          setShowPrepTimeModal(false)
          break
        case 'bad_address':
          alert(`Uber rejected this address. ${result.detail || ''}`.trim())
          setShowPrepTimeModal(false)
          break
        case 'rate_limited':
          alert(`Uber rate limit. Try again in ${result.retry_after || 60} seconds.`)
          break
        case 'quote_not_found':
        case 'missing_quote_id':
        case 'quote_expired_no_dropoff_coords':
        case 'accepted_quote_expired':
          alert('Quote unavailable. Reload the order and try again.')
          setShowPrepTimeModal(false)
          setShowPriceChangeModal(null)
          break
        default:
          alert(`Dispatch failed: ${result.error || 'unknown error'}`)
      }
    } catch (err) {
      console.error('[Tablet] dispatchToUber failed', err)
      alert('Dispatch request failed. Please try again.')
    } finally {
      setDispatching(false)
    }
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
          {/* UI-polish (D1): UberDirect status line on the detail panel too,
              below the order number, same format/style as the tile. */}
          {order.delivery_fulfillment_method === 'uber_direct' && (
            <div className={`mt-0.5 text-sm font-semibold ${
              order.uber_status === 'delivered' ? 'text-green-700'
                : (order.uber_status === 'canceled' || order.uber_status === 'failed' || order.uber_status === 'returned') ? 'text-red-700'
                : 'text-blue-700'
            }`}>
              {order.uber_status
                ? `UberDirect · ${getUberStatusDisplay(order.uber_status).label}${formatEtaSuffix(order)}`
                : 'UberDirect · awaiting dispatch'}
            </div>
          )}
        </div>
        <span className={`ml-auto px-3 py-1 rounded-full text-xs font-semibold uppercase ${
          order.status === 'new' ? 'bg-yellow-100 text-yellow-800' :
          order.status === 'scheduled' ? 'bg-amber-200 text-amber-900' :
          order.status === 'in_progress' ? 'bg-blue-100 text-blue-800' :
          order.status === 'complete' ? 'bg-green-100 text-green-800' :
          'bg-red-100 text-red-800'
        }`}>
          {order.status === 'in_progress' ? 'In Progress' : order.status}
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-6" style={{ WebkitOverflowScrolling: 'touch' }}>
        {order.scheduled_for && (
          <div className="bg-amber-100 border border-amber-300 rounded-xl px-4 py-3">
            <p className="text-base font-semibold text-amber-900">
              Scheduled for: {formatScheduledLabel(order.scheduled_for)}
            </p>
          </div>
        )}

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

        {/* Special Instructions */}
        {order.special_instructions && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-amber-800 uppercase tracking-wide mb-1">Instructions</h3>
            <p className="text-base text-amber-900 font-medium">{order.special_instructions}</p>
          </div>
        )}

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

        {/* Refund info */}
        {order.refund_status && (
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-1">
            <h3 className="text-sm font-semibold text-purple-800 uppercase tracking-wide">Refund</h3>
            <p className="text-base font-medium text-purple-900">
              {order.refund_status === 'completed' ? 'Full Refund' : order.refund_status === 'partial' ? 'Partial Refund' : order.refund_status === 'failed' ? 'Refund Failed' : order.refund_status}
              {order.refund_amount ? ` — ${formatMoney(order.refund_amount / 100)}` : ''}
            </p>
            {order.refund_reason && <p className="text-sm text-purple-700">{order.refund_reason}</p>}
          </div>
        )}

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
            {/* M9d: policy-derived Uber cancellation notice (uber_direct only). */}
            {(() => {
              const notice = uberCancelNotice()
              return notice ? (
                <p className={`text-sm text-center rounded-lg p-2.5 ${notice.cls}`}>{notice.text}</p>
              ) : null
            })()}
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
            {order.status === 'new' && !order.scheduled_for && (
              <button
                onClick={() => {
                  // M9a: intercept for uber_direct orders — open prep modal
                  // before dispatching to Uber. in_house orders flow through
                  // the existing updateStatus path unchanged.
                  if (order.delivery_fulfillment_method === 'uber_direct') {
                    setShowStatusOptions(false)
                    setShowPrepTimeModal(true)
                  } else {
                    updateStatus('in_progress')
                  }
                }}
                disabled={updating}
                className="w-full h-12 rounded-xl bg-blue-600 text-white font-semibold disabled:opacity-50"
              >
                Mark In Progress
              </button>
            )}
            {order.status === 'new' && order.scheduled_for && (
              <button
                onClick={() => {
                  // M9a: same intercept for scheduled uber_direct orders.
                  // pickup_ready_minutes will typically be set by the operator
                  // to roughly minutes-until-scheduled_for using the Custom
                  // input; the bracket defaults are not scheduled-aware in v1.
                  if (order.delivery_fulfillment_method === 'uber_direct') {
                    setShowStatusOptions(false)
                    setShowPrepTimeModal(true)
                  } else {
                    updateStatus('scheduled')
                  }
                }}
                disabled={updating}
                className="w-full h-12 rounded-xl bg-amber-500 text-white font-semibold disabled:opacity-50"
              >
                Accept
              </button>
            )}
            {(order.status === 'in_progress' || order.status === 'scheduled') && (
              <button
                onClick={() => updateStatus('complete')}
                disabled={updating}
                className="w-full h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                Mark Complete
              </button>
            )}
            <button
              onClick={openCancelConfirm}
              disabled={fetchingFee}
              className="w-full h-12 rounded-xl bg-red-600 text-white font-semibold disabled:opacity-50"
            >
              {fetchingFee ? 'Checking…' : 'Cancel Order'}
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

        {/* M9a: Uber Direct prep-time modal — operator picks pickup_ready
            window before dispatching the delivery to Uber. */}
        {showPrepTimeModal && (
          <div className="bg-gray-50 p-4 rounded-xl space-y-3">
            <p className="font-semibold text-gray-800">Prep time</p>
            <p className="text-sm text-gray-600">
              When will the order be ready for Uber pickup?
            </p>
            <div className="grid grid-cols-2 gap-2">
              {prepBrackets().map(min => (
                <button
                  key={min}
                  onClick={() => setSelectedPrepMinutes(min)}
                  className={`h-12 rounded-xl border ${
                    selectedPrepMinutes === min
                      ? 'border-[#16A34A] bg-[#16A34A]/10 text-[#16A34A] font-semibold'
                      : 'border-gray-300'
                  }`}
                >
                  {min} min
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">Custom:</span>
              <input
                type="number"
                min="5"
                max="120"
                value={selectedPrepMinutes ?? ''}
                onChange={e => setSelectedPrepMinutes(Number(e.target.value) || null)}
                className="flex-1 h-10 px-3 border border-gray-300 rounded-lg"
                placeholder="minutes"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setShowPrepTimeModal(false); setSelectedPrepMinutes(null) }}
                disabled={dispatching}
                className="flex-1 h-12 rounded-xl border border-gray-300 font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={() => dispatchToUber()}
                disabled={dispatching || !selectedPrepMinutes}
                className="flex-1 h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                {dispatching ? 'Dispatching...' : 'Confirm and Dispatch'}
              </button>
            </div>
          </div>
        )}

        {/* M9a: Uber price-change modal — surfaced when the refreshed quote
            differs from the original by >= $2. Operator decides whether to
            absorb the difference (Accept Anyway) or cancel + refund. */}
        {showPriceChangeModal && (
          <div className="bg-amber-50 border border-amber-300 p-4 rounded-xl space-y-3">
            <p className="font-semibold text-amber-900">
              Uber price changed by ${(Math.abs(showPriceChangeModal.delta_cents) / 100).toFixed(2)}
            </p>
            <p className="text-sm text-amber-800">
              Original: ${(showPriceChangeModal.original_fee_cents / 100).toFixed(2)} → New: ${(showPriceChangeModal.new_fee_cents / 100).toFixed(2)}
            </p>
            <p className="text-xs text-amber-700">
              The customer was billed the original price. Accepting will dispatch at the new price; the restaurant absorbs any positive delta.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowPriceChangeModal(null); setShowPrepTimeModal(false); setSelectedPrepMinutes(null) }}
                disabled={dispatching}
                className="flex-1 h-12 rounded-xl border border-gray-300 font-semibold"
              >
                Cancel & Refund
              </button>
              <button
                onClick={() => dispatchToUber(showPriceChangeModal.new_quote_id)}
                disabled={dispatching}
                className="flex-1 h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                {dispatching ? 'Dispatching...' : 'Accept Anyway'}
              </button>
            </div>
          </div>
        )}

        {/* Main action buttons */}
        {!showReprint && !showStatusOptions && !showCancelConfirm && !showAdjustForm && !showPrepTimeModal && !showPriceChangeModal && (
          order.delivery_fulfillment_method === 'uber_direct' && order.status === 'new' ? (
            /* M10: Direct one-tap dispatch flow for new uber_direct orders.
               Skips the UPDATE STATUS intermediate step — primary CTA opens
               the prep modal directly. Cancel preserved as a text link below
               so the operator can still refund without going through Update
               Status. Existing in_progress / complete / cancelled paths fall
               into the else branch below. */
            <div className="space-y-3">
              <button
                onClick={() => setShowPrepTimeModal(true)}
                className="w-full h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base"
              >
                Set Pickup Time & Mark in Progress
              </button>
              <button
                onClick={() => setShowReprint(true)}
                className="w-full h-12 rounded-xl border-2 border-gray-300 font-bold text-sm"
              >
                REPRINT
              </button>
              <button
                onClick={openCancelConfirm}
                disabled={fetchingFee}
                className="w-full text-center text-sm text-red-600 hover:text-red-800 py-1 disabled:opacity-50"
              >
                {fetchingFee ? 'Checking…' : 'Cancel & Refund Order'}
              </button>
            </div>
          ) : (
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
          )
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
// Polling, chime, and auto-print are handled by useOrderPolling in TabletPage
export default function OrdersTab({ restaurant, setRestaurant, orders, setOrders, ordersLoading: loading, fetchOrders }) {
  const [subTab, setSubTab] = useState('new')
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [showOlder, setShowOlder] = useState(false)

  const subTabs = [
    { key: 'new', label: 'New' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'complete', label: 'Complete' },
  ]

  async function handleOrderTap(order) {
    // Open the detail panel first so the UI is snappy; the ack write
    // runs in parallel. Optimistic local patch stops the green pulse
    // immediately — the next poll cycle reconciles. If the DB write
    // fails, the next poll re-introduces the un-ack state and the
    // pulse resumes.
    setSelectedOrder(order)
    if (order.status === 'new' && !order.acknowledged_at) {
      const ackAt = new Date().toISOString()
      setOrders(prev => prev.map(o => o.id === order.id ? { ...o, acknowledged_at: ackAt } : o))
      const { error } = await supabase
        .from('orders')
        .update({ acknowledged_at: ackAt })
        .eq('id', order.id)
      if (error) console.error('[Ack] write failed', error)
    }
  }

  async function handleRetryPrint(order) {
    if (!restaurant?.printer_ip) return
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('*, order_item_toppings(*)')
      .eq('order_id', order.id)
      .order('created_at')

    const result = await printOrder(restaurant.printer_ip, { ...order, items: orderItems || [] }, { name: restaurant.name, address: restaurant.address, phone: restaurant.phone })

    const attempts = (order.print_attempts || 0) + 1
    await supabase.from('print_logs').insert({
      order_id: order.id,
      order_number: order.order_number,
      restaurant_id: restaurant.id,
      attempt_number: attempts,
      status: result.success ? 'success' : 'failed',
      error_message: result.success ? null : result.message,
    })
    await supabase.from('orders').update({
      print_status: result.success ? 'printed' : 'failed',
      print_attempts: attempts,
    }).eq('id', order.id)

    fetchOrders()
  }

  function handleStatusChange(updatedOrder) {
    setOrders(prev => prev.map(o => o.id === updatedOrder.id ? updatedOrder : o))
    setSelectedOrder(updatedOrder)
  }

  const filteredOrders = (() => {
    const filtered = orders.filter(o => {
      if (subTab === 'complete') return o.status === 'complete' || o.status === 'cancelled'
      return o.status === subTab
    })
    // Scheduled tab: next-up first so the kitchen sees the most urgent
    // upcoming order at the top. Other tabs keep the polling-query order
    // (created_at DESC).
    if (subTab === 'scheduled') {
      return [...filtered].sort(
        (a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime()
      )
    }
    return filtered
  })()

  // Complete tab: cap at last 30 days unless "Load older" expanded, then
  // bucket by NY-time calendar day for the date-grouped section headers.
  // Skips work entirely for other tabs via the early return.
  const groupedComplete = useMemo(() => {
    if (subTab !== 'complete') return null
    const completeFiltered = orders.filter(
      o => o.status === 'complete' || o.status === 'cancelled'
    )
    const cutoff = Date.now() - 30 * DAY_MS
    const visible = showOlder
      ? completeFiltered
      : completeFiltered.filter(o => new Date(o.created_at).getTime() >= cutoff)
    return {
      groups: groupOrdersByCreatedAtNy(visible),
      hasMore: !showOlder && completeFiltered.length > visible.length,
    }
  }, [orders, subTab, showOlder])

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
            {tab.key === 'scheduled' && orders.filter(o => o.status === 'scheduled').length > 0 && (
              <span className="ml-2 bg-amber-300 text-black text-xs rounded-full px-2 py-0.5">
                {orders.filter(o => o.status === 'scheduled').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Order list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <p className="text-center text-gray-400 mt-8">Loading orders...</p>
        ) : subTab === 'complete' ? (
          <div>
            {groupedComplete.groups.length === 0 ? (
              <>
                <p className="text-center text-gray-400 mt-8">
                  {groupedComplete.hasMore
                    ? 'No completed orders in the last 30 days'
                    : 'No completed orders'}
                </p>
                {groupedComplete.hasMore && (
                  <button
                    onClick={() => setShowOlder(true)}
                    className="text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 px-4 py-2 rounded border border-gray-200 mt-6 w-full"
                  >
                    Load older
                  </button>
                )}
              </>
            ) : (
              <>
                {groupedComplete.groups.map((group, i) => (
                  <div key={group.dateKey}>
                    <div className={i === 0 ? 'text-sm text-gray-400 text-right mb-2' : 'text-sm text-gray-400 text-right mt-6 mb-2'}>
                      {group.label}
                    </div>
                    <div className="space-y-3">
                      {group.orders.map(order => (
                        <OrderCard key={order.id} order={order} onTap={handleOrderTap} onRetryPrint={restaurant?.printer_ip ? handleRetryPrint : null} />
                      ))}
                    </div>
                  </div>
                ))}
                {groupedComplete.hasMore && (
                  <button
                    onClick={() => setShowOlder(true)}
                    className="text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 px-4 py-2 rounded border border-gray-200 mt-6 w-full"
                  >
                    Load older
                  </button>
                )}
              </>
            )}
          </div>
        ) : filteredOrders.length === 0 ? (
          <p className="text-center text-gray-400 mt-8">No {subTab === 'in_progress' ? 'in progress' : subTab} orders</p>
        ) : (
          filteredOrders.map(order => (
            <OrderCard key={order.id} order={order} onTap={handleOrderTap} onRetryPrint={restaurant?.printer_ip ? handleRetryPrint : null} />
          ))
        )}
      </div>
    </div>
  )
}
