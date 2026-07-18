import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { printOrder } from '../../utils/epsonPrint'
import { formatPhone } from '../../utils/format'
import { formatScheduledLabel, groupOrdersByCreatedAtNy } from '../../utils/scheduling'
import { getStuckStage } from '../../utils/stuckStage'
import { isUberActiveNow } from '../../utils/uberActive'

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

// Estimated Uber cancellation fee range, by minutes since dispatch. This is
// an ESTIMATE shown pre-cancel — Uber exposes no live fee field, so we bucket
// by elapsed time. The ACTUAL fee comes back post-cancel via admin-refund and
// is surfaced in the success alert; the two can differ. Returns null when we
// have no dispatch timestamp to measure from.
function estimateUberCancelFee(dispatchedAt) {
  if (!dispatchedAt) return null
  const mins = (Date.now() - new Date(dispatchedAt).getTime()) / 60000
  if (mins < 5) return '$0–$3'
  if (mins < 10) return '$3–$8'
  return '$8–$15'
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
// the Uber Direct status line. Shows the live PICKUP ETA (courier arrival at
// the restaurant) — what the operator cares about — superseding the scheduled
// pickup time once a courier reports one. Returns '' when there's nothing to
// append (so no dangling middle-dot appears). All times in Eastern
// (formatTimeNY), matching the M10 pickup-commitment display.
//   - uber_pickup_eta set & in the future   → " · ETA <time>"     (live)
//   - uber_pickup_eta set & in the past      → ''                  (stale; hide)
//   - else pending / no status, pickup time  → " · Scheduled <time>"
//   - else                                    → ''
function formatEtaSuffix(order) {
  // No ETA once the courier has the food or the delivery is over/aborted. The
  // pickup ETA is only meaningful pre-pickup; after pickup_complete it's in
  // the past and irrelevant (the order also auto-completes). Terminal +
  // post-pickup states are suppressed so no stale "ETA X:XX" lingers.
  if (['pickup_complete', 'delivered', 'canceled', 'failed', 'returned'].includes(order.uber_status)) return ''
  if (order.uber_pickup_eta) {
    const etaMs = new Date(order.uber_pickup_eta).getTime()
    if (!Number.isNaN(etaMs) && etaMs > Date.now()) {
      return ` · ETA ${formatTimeNY(order.uber_pickup_eta)}`
    }
    return ''
  }
  if ((!order.uber_status || order.uber_status === 'pending') && order.uber_pickup_ready_dt) {
    return ` · Scheduled ${formatTimeNY(order.uber_pickup_ready_dt)}`
  }
  return ''
}

// ── self_delivering presentation split (Design B) ──
// A self-delivering order keeps the presentation of the in-house order it now is:
// if it carries a scheduled_for it stays "Scheduled" (badge + tab) until the operator
// completes it — matching in-house scheduled orders, which never auto-promote. ASAP
// self-delivers (no scheduled_for) show as "In Progress". Single source of truth for
// the badge, tab filter, and tab counts.
function isScheduledSelfDeliver(o) {
  return o.status === 'self_delivering' && o.scheduled_for != null
}

// ── Order Card ──
function OrderCard({ order, onTap, onRetryPrint, printTrigger }) {
  // Per-card busy state — the Retry button lives here while handleRetryPrint
  // lives in the parent, so we bracket the awaited call locally. This keeps the
  // busy feedback scoped to THIS card (a single parent flag would light up every
  // card's Retry button at once).
  const [printing, setPrinting] = useState(false)
  const isDelivery = order.order_type === 'delivery'
  const borderColor = isDelivery ? 'border-l-blue-500' : 'border-l-[#16A34A]'
  const isUnacked = order.status === 'new' && !order.acknowledged_at
  // Escalation window: acknowledged but still 'new' (not yet in-progress) for
  // >= 7 min. Same window as hasEscalation in useOrderPolling.js — keep this
  // literal in sync with ESCALATION_MINUTES there (not imported to avoid
  // cross-file coupling for a single number). Mutually exclusive with
  // isUnacked (that needs !acknowledged_at; this needs acknowledged_at != null).
  const isEscalating =
    order.status === 'new' &&
    order.acknowledged_at != null &&
    (Date.now() - new Date(order.acknowledged_at).getTime()) >= 7 * 60 * 1000
  // In 'in_progress' print mode an untaken order is pending by design (it was
  // never asked to print), so Retry/pending UI would be misleading. Once taken
  // (status leaves 'new') a print WAS attempted, so show them normally again.
  const awaitingTake = printTrigger === 'in_progress' && order.status === 'new'
  const showRetry = !awaitingTake && (order.print_status === 'failed' || order.print_status === 'pending') && onRetryPrint
  // Partial-failure cue: a failed refund leaves the order in its pre-cancel
  // status (e.g. in_progress) so it hides in plain sight among active orders.
  // Flag it red so the operator knows it needs manual follow-up — the
  // customer is still charged. Broad signal (any failed refund, in_house or
  // uber_direct); the detail banner tailors copy by uber_status.
  const refundFailed = order.refund_status === 'failed'
  // Stuck-pending escalation (0=none, 1=passive yellow, 2=flashing yellow,
  // 3=red). Drives tile color so a courier-less order can't hide among
  // healthy in-progress tiles. Computed at render; the 10s poll re-renders.
  const stuckStage = getStuckStage(order, Date.now())

  // Card background/ring by priority: stuck stage 3 (hard red, flashing) ≥
  // refund-failed (pale red) ≥ stuck stage 2 (hard yellow, flashing) ≥ stuck
  // stage 1 (hard yellow) ≥ un-acked new (flashing green) ≥ default white.
  // Stuck stages use saturated bg + thick ring so a courier-less order can't
  // be mistaken for a normal blue/white in-progress tile.
  const cardStateClass =
    stuckStage === 3 ? 'bg-red-400 ring-4 ring-red-600 animate-pulse'
      : refundFailed ? 'bg-red-50 ring-1 ring-red-300'
      : stuckStage === 2 ? 'bg-yellow-300 ring-4 ring-yellow-500 animate-pulse'
      : stuckStage === 1 ? 'bg-yellow-300'
      : isUnacked ? 'animate-flash-green'
      : isEscalating ? 'animate-flash-yellow'
      : 'bg-white'

  // Customer info line. Each segment is independently optional so missing
  // phone or address gracefully degrades. delivery_address is only
  // included for delivery orders; for pickup it's omitted even if present.
  const customerInfo = [
    order.customer_name,
    order.customer_phone ? formatPhone(order.customer_phone) : null,
    isDelivery && order.delivery_address ? order.delivery_address : null,
  ].filter(Boolean).join(', ')

  return (
    <div className={`w-full text-left rounded-xl border border-gray-200 border-l-4 ${borderColor} shadow-sm hover:shadow-md transition-shadow ${cardStateClass}`}>
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
          {refundFailed && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-red-600 text-white text-xs font-bold whitespace-nowrap">
              REFUND FAILED
            </span>
          )}
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
            {order.print_status === 'pending' && !awaitingTake && <span className="text-gray-400 text-xs">⏳</span>}
          </div>
          <span>{formatTime(order.created_at)}</span>
        </div>
        {/* UI-polish: Uber Direct status line, now BELOW the order number and
            larger/bolder than the old grey text-xs treatment. Single line,
            middle-dot separated: "UberDirect · <status> · ETA/Scheduled X:XX".
            Live ETA supersedes the scheduled pickup time (formatEtaSuffix).
            Color: blue-700 in-flight, green delivered, red canceled/failed/
            returned. Pre-dispatch shows "awaiting dispatch". */}
        {order.status === 'self_delivering' ? (
          /* D9: self-delivering orders show "Self-delivering" instead of the
             Uber status line (which would read "Canceled" from the release). */
          <div className="mt-1 text-sm font-bold text-yellow-600">Delivering In-House</div>
        ) : order.cancelled_by === 'restaurant_self_deliver' ? (
          /* Self-delivered then completed: the Uber leg was canceled but the
             restaurant delivered it. Neutral near-black, NOT the red "Canceled"
             used for a true cancel+refund (cancelled_by restaurant_refund / uber).
             Keyed on cancelled_by so it survives the self_delivering→complete
             transition (the green branch above only covers the in-progress phase). */
          <div className="mt-1 text-sm font-semibold text-gray-900">UberDirect · Canceled · Self-delivered</div>
        ) : order.delivery_fulfillment_method === 'uber_direct' && (
          <div className={`mt-1 text-sm ${stuckStage >= 2 ? 'font-bold' : 'font-semibold'} ${
            order.uber_status === 'delivered' ? 'text-green-700'
              : stuckStage === 3 ? 'text-white'
              : stuckStage >= 1 ? 'text-yellow-900'
              : (order.uber_status === 'canceled' || order.uber_status === 'failed' || order.uber_status === 'returned') ? 'text-red-700'
              : 'text-blue-700'
          }`}>
            {stuckStage === 3
              ? 'UberDirect · NO DRIVER ASSIGNED'
              : stuckStage >= 1
                ? 'UberDirect · Waiting for Uber Driver — Late'
                : order.uber_status
                  ? `UberDirect · ${getUberStatusDisplay(order.uber_status).label}${formatEtaSuffix(order)}`
                  : 'UberDirect · awaiting dispatch'}
          </div>
        )}
      </button>
      {showRetry && (
        <div className="px-4 pb-3">
          <button
            onClick={async (e) => {
              e.stopPropagation()
              setPrinting(true)
              try { await onRetryPrint(order) } finally { setPrinting(false) }
            }}
            disabled={printing}
            className="w-full h-9 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-semibold disabled:opacity-60"
          >
            {printing ? 'Printing…' : 'Retry Print'}
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
  // Print log is collapsed by default to avoid spamming the detail panel
  // with per-attempt rows; the disclosure header summarizes failures.
  const [printLogExpanded, setPrintLogExpanded] = useState(false)
  const [showReprint, setShowReprint] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [showStatusOptions, setShowStatusOptions] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showDeliverConfirm, setShowDeliverConfirm] = useState(false)
  const [showRefundConfirm, setShowRefundConfirm] = useState(false)
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
    // OrderDetail is reused across orders (no key), so reset the disclosure
    // so a new order's print log opens collapsed.
    setPrintLogExpanded(false)
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
    if (order.delivery_fulfillment_method === 'uber_direct' && order.uber_delivery_id && order.uber_status !== 'canceled') {
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
        cls: 'bg-amber-50 border-2 border-amber-300 text-amber-900',
      }
    }
    switch (cancelFeeInfo.uber_status) {
      case 'pending':
        return {
          text: '✅ No courier assigned yet — no Uber cancellation fee.',
          cls: 'bg-green-50 border-2 border-green-300 text-green-900',
        }
      case 'pickup': {
        const range = estimateUberCancelFee(order.uber_dispatched_at)
        return {
          text: range
            ? `⚠️ Courier en route. Estimated UberDirect cancellation fee: ${range}`
            : '⚠️ Courier en route. UberDirect may charge a cancellation fee.',
          cls: 'bg-amber-50 border-2 border-amber-300 text-amber-900',
        }
      }
      case 'pickup_complete':
        return {
          text: '🚫 Driver has picked up the food. Cancellation likely NOT possible. If you proceed and Uber refuses, no refund will be issued.',
          cls: 'bg-red-50 border-2 border-red-400 text-red-900',
        }
      case 'dropoff':
        return {
          text: '🚫 Driver is delivering now. Cancellation NOT possible — keep order intact.',
          cls: 'bg-red-50 border-2 border-red-400 text-red-900',
        }
      case 'delivered':
        return {
          text: 'Order already delivered. No refund.',
          cls: 'bg-red-50 border-2 border-red-400 text-red-900',
        }
      case 'canceled':
        return {
          text: 'This delivery is already canceled.',
          cls: 'bg-gray-50 border-2 border-gray-300 text-gray-700',
        }
      default:
        return {
          text: `Current delivery state: ${cancelFeeInfo.uber_status}. A cancellation fee may apply — you absorb it.`,
          cls: 'bg-amber-50 border-2 border-amber-300 text-amber-900',
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
        // Success. The operator already saw + accepted any Uber cancellation
        // fee estimate in the cancel modal, so we don't restate the cost here.
        // The actual fee is still persisted to orders.uber_cancellation_fee_cents
        // (migration 038) for reporting.
        alert('Order cancelled and refunded.')
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

  // Stuck-pending "Deliver Yourself": cancel the Uber dispatch (no refund) via
  // uber-self-deliver, then the order becomes 'self_delivering'. Customer keeps
  // their delivery (now from the restaurant); no refund, restaurant keeps the
  // fee. On cancel failure we abort and surface the error (spec).
  async function deliverYourself() {
    setUpdating(true)
    try {
      const { data: { session }, error: refreshError } = await supabase.auth.refreshSession()
      if (refreshError || !session) {
        alert('Session expired. Please log in again.')
        setUpdating(false)
        return
      }
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/uber-self-deliver`,
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
      if (!result.success) {
        alert(`Couldn't switch to self-delivery: ${result.error || 'Unknown error'}. The Uber delivery was not released.`)
        setUpdating(false)
        return
      }
      onStatusChange({ ...order, status: 'self_delivering', uber_status: 'canceled', cancelled_by: 'restaurant_self_deliver' })
    } catch (err) {
      alert('Self-delivery request failed. Please try again.')
    }
    setUpdating(false)
  }

  async function handleReprint() {
    if (!restaurant.printer_ip) {
      setShowReprint(false)
      return
    }

    setPrinting(true)
    try {
      // Fetch full order + items/toppings for printing. Parallel so it's ONE
      // round-trip of latency instead of two sequential fetches. Both kept:
      // reprint must reflect current DB state (fresh order AND fresh items).
      const [{ data: fullOrder }, { data: orderItems }] = await Promise.all([
        supabase.from('orders').select('*').eq('id', order.id).single(),
        supabase.from('order_items').select('*, order_item_toppings(*)').eq('order_id', order.id).order('created_at'),
      ])

      const result = await printOrder(restaurant.printer_ip, { ...fullOrder, items: orderItems || [] }, { name: restaurant.name, address: restaurant.address, phone: restaurant.phone, receipt_font: restaurant?.receipt_font ?? 'standard' })

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
    } finally {
      setPrinting(false)
    }
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

  // Fixed prep-time bracket options for the dispatch modal. Previously derived
  // from restaurant.estimated_delivery_minutes; now a fixed menu so the presets
  // don't drift with the customer-facing delivery estimate. Operator falls back
  // to the Custom input (5-120) for non-standard cases.
  function prepBrackets() {
    return [10, 20, 30, 40]
  }

  // M9a: POST to uber-create-delivery and handle structured response.
  // quoteIdOverride is passed when the operator taps "Accept Anyway" on
  // the price-change modal (carries the new_quote_id back to the function
  // so it can dispatch against the refreshed quote without re-checking).
  async function dispatchToUber(quoteIdOverride = null) {
    // Scheduled orders book at the customer's slot (absolute pickup_ready_dt) and
    // have no prep-minutes selection; ASAP orders book relative minutes from the
    // prep modal. ASAP behavior is byte-identical to before.
    const isScheduled = order.scheduled_for != null
    if (!isScheduled && !selectedPrepMinutes) return
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
            ...(isScheduled
              ? { pickup_ready_dt: order.scheduled_for }
              : { pickup_ready_minutes: selectedPrepMinutes }),
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
          status: isScheduled ? 'scheduled' : 'in_progress',
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

  // "Deliver In-House" availability — any uber_direct order that hasn't reached
  // a terminal/self-delivering state. Lets the operator pull a delivery off Uber
  // and fulfill it themselves, BOTH before dispatch (new) and after (in_progress/
  // scheduled). Wired to the existing deliverYourself() + showDeliverConfirm flow.
  const canDeliverInHouse =
    order.delivery_fulfillment_method === 'uber_direct' &&
    !['complete', 'cancelled', 'self_delivering'].includes(order.status)

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
          {order.cancelled_by === 'restaurant_self_deliver' ? (
            /* Self-delivered (Uber leg canceled, restaurant delivers). Keyed on
               cancelled_by, phase-aware (mirrors the tile): green while still
               in progress, neutral near-black once completed — never the red
               "Canceled" used for a true cancel+refund (restaurant_refund / uber,
               which fall through to the generic block below). */
            order.status === 'self_delivering' ? (
              <div className="mt-0.5 text-sm font-bold text-yellow-600">Delivering In-House</div>
            ) : (
              <div className="mt-0.5 text-sm font-semibold text-gray-900">UberDirect · Canceled · Self-delivered</div>
            )
          ) : order.delivery_fulfillment_method === 'uber_direct' && (
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
          (order.status === 'scheduled' || isScheduledSelfDeliver(order)) ? 'bg-amber-200 text-amber-900' :
          (order.status === 'in_progress' || order.status === 'self_delivering') ? 'bg-blue-100 text-blue-800' :
          order.status === 'complete' ? 'bg-green-100 text-green-800' :
          'bg-red-100 text-red-800'
        }`}>
          {isScheduledSelfDeliver(order) ? 'Scheduled'
            : (order.status === 'in_progress' || order.status === 'self_delivering') ? 'In Progress'
            : order.status}
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-6" style={{ WebkitOverflowScrolling: 'touch' }}>
        {/* Partial-failure alert: refund failed → customer still charged.
            Sits at the very top so it's the first thing the operator sees.
            Copy branches on uber_status (cancel cascade vs in_house). The
            canonical refund record stays in the purple box lower down. */}
        {order.refund_status === 'failed' && (
          <div className="bg-red-50 border-2 border-red-400 rounded-xl px-4 py-3 space-y-1">
            <p className="text-base font-bold text-red-800">⚠ Refund failed — customer still charged</p>
            <p className="text-sm text-red-700">
              {order.uber_status === 'canceled'
                ? 'The Uber delivery was canceled but the Stripe refund did not go through. The customer is still charged and no delivery is happening. Retry "Cancel & Refund" or process the refund manually.'
                : 'The Stripe refund did not go through. The customer is still charged. Retry "Cancel & Refund" or process the refund manually.'}
            </p>
            {order.refund_reason && <p className="text-xs text-red-600">Reason: {order.refund_reason}</p>}
          </div>
        )}
        {/* Stage 1/2 stuck advisory banner (amber): Uber is late but a courier
            may still come. Display-only — no Deliver Yourself / Cancel here.
            Gated s===1||s===2 (never >=1) so it can't co-render with the red
            Stage-3 banner below. */}
        {(() => {
          const s = getStuckStage(order, Date.now())
          if (!((s === 1 || s === 2) && order.status !== 'self_delivering' && order.refund_status !== 'failed')) return null
          return (
            <div className="bg-yellow-50 border-2 border-yellow-400 rounded-xl px-4 py-3 space-y-3">
              <p className="text-base font-bold text-yellow-900">Uber is running late</p>
              <p className="text-sm text-yellow-900">Courier may still be on the way.</p>
              {order.customer_phone && (
                /* Kiosk can't dial — static, readable number for the operator
                   to call from their own phone (not a tel: link). */
                <div>
                  <p className="text-sm text-yellow-900">Call {order.customer_name} for a heads-up:</p>
                  <p className="text-2xl font-bold text-yellow-900 tracking-wide">{formatPhone(order.customer_phone)}</p>
                </div>
              )}
            </div>
          )
        })()}
        {/* Stage 3 stuck-pending action banner: no courier found (15+ min) or
            Uber cancelled the dispatch. Operator must act. Self-delivering and
            already-refunded orders don't show this. */}
        {getStuckStage(order, Date.now()) === 3 && order.status !== 'self_delivering' && order.refund_status !== 'failed' && (
          <div className="bg-red-50 border-2 border-red-400 rounded-xl px-4 py-3 space-y-3">
            <p className="text-base font-bold text-red-800">No driver assigned. Take action now.</p>
            {order.customer_phone && (
              /* Kiosk can't dial — show the number as static, readable text for
                 the operator to call from their own phone (not a tel: link). */
              <div className="rounded-xl bg-white border-2 border-red-400 px-3 py-2 text-center">
                <p className="text-sm text-red-700">Call {order.customer_name} before acting:</p>
                <p className="text-2xl font-bold text-red-900 tracking-wide">{formatPhone(order.customer_phone)}</p>
              </div>
            )}
            <button
              onClick={() => { setShowRefundConfirm(false); setShowDeliverConfirm(true) }}
              disabled={updating}
              className="w-full h-12 rounded-xl bg-[#16A34A] text-white font-bold disabled:opacity-50"
            >
              {updating ? 'Working…' : 'Deliver Yourself'}
            </button>
            <button
              onClick={() => { setShowDeliverConfirm(false); setShowRefundConfirm(true) }}
              disabled={updating}
              className="w-full h-12 rounded-xl bg-white border-2 border-red-400 text-red-700 font-bold disabled:opacity-50"
            >
              Cancel &amp; Refund
            </button>
          </div>
        )}
        {/* B2c: Self-deliver confirm. Sits directly under the Stage-3 banner so
            it appears next to its trigger (the banner's Deliver Yourself button).
            Amber — self-deliver is a positive action. This confirm is the only
            caller of deliverYourself(). */}
        {showDeliverConfirm && (
          <div className="bg-yellow-50 p-4 rounded-xl space-y-3">
            <p className="text-center font-bold text-yellow-900">Deliver this order in-house?</p>
            <p className="text-center text-sm text-yellow-900">You keep the delivery fee and tip.</p>
            {['pickup', 'pickup_complete', 'dropoff'].includes(order.uber_status) && (
              <>
                <p className="text-center text-sm text-yellow-900">A courier is already on the way — Uber may text the customer that the delivery was canceled.</p>
                {order.customer_phone && (
                  <div className="text-center">
                    <p className="text-sm text-yellow-900">Call {order.customer_name} first:</p>
                    <p className="text-2xl font-bold text-yellow-900 tracking-wide">{formatPhone(order.customer_phone)}</p>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-3">
              <button onClick={() => setShowDeliverConfirm(false)} className="flex-1 h-12 rounded-xl border-2 border-gray-400 bg-white font-semibold">Back</button>
              <button onClick={() => { setShowDeliverConfirm(false); deliverYourself() }} disabled={updating} className="flex-1 h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50">Deliver In-House</button>
            </div>
          </div>
        )}
        {/* B3: Cancel & Refund confirm for the Stage-3 crisis banner. Mirrors
            the self-deliver confirm but red. Intentionally omits the Uber
            cancel-fee notice (the regular cancel modal still shows it) — kept
            tight for the crisis flow. Fires the existing updateStatus('cancelled')
            refund path, which is independent of openCancelConfirm/cancelFeeInfo. */}
        {showRefundConfirm && (
          <div className="bg-red-50 p-4 rounded-xl space-y-3">
            <p className="text-center font-bold text-red-800">Cancel & refund?</p>
            {order.customer_phone && (
              <div className="text-center">
                <p className="text-sm text-red-800">Call {order.customer_name} first. Offer pickup or full refund.</p>
                <p className="text-2xl font-bold text-red-900 tracking-wide">{formatPhone(order.customer_phone)}</p>
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setShowRefundConfirm(false)} className="flex-1 h-12 rounded-xl border-2 border-gray-400 bg-white font-semibold">Back</button>
              <button onClick={() => { setShowRefundConfirm(false); updateStatus('cancelled') }} disabled={updating} className="flex-1 h-12 rounded-xl bg-red-600 text-white font-semibold disabled:opacity-50">I've called — Refund</button>
            </div>
          </div>
        )}
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
              {Number(order.discount_percentage) > 0 && item.discount_exempt === true && (
                <p className="pl-6 text-[11px] text-gray-400">*already discounted*</p>
              )}
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
              {order.refund_amount ? ` — ${formatMoney(order.refund_amount)}` : ''}
            </p>
            {order.refund_reason && <p className="text-sm text-purple-700">{order.refund_reason}</p>}
          </div>
        )}

        {/* Print log — collapsed by default. The disclosure header summarizes
            failures (red) or attempt count (grey) without spamming the panel
            with per-attempt rows; tap to expand the full list. */}
        {printLogs.length > 0 && (() => {
          const failed = printLogs.filter(log => log.status !== 'success').length
          return (
            <div className="space-y-1">
              <button
                onClick={() => setPrintLogExpanded(v => !v)}
                className={`flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide ${failed > 0 ? 'text-red-600' : 'text-gray-500'}`}
              >
                Print log ({failed > 0
                  ? `${failed} failed attempt${failed > 1 ? 's' : ''}`
                  : `${printLogs.length} attempt${printLogs.length > 1 ? 's' : ''}`})
                <span>{printLogExpanded ? '▲' : '▼'}</span>
              </button>
              {printLogExpanded && printLogs.map(log => (
                <div key={log.id} className="flex items-center gap-2 text-sm">
                  <span className={log.status === 'success' ? 'text-green-600' : 'text-red-500'}>
                    {log.status === 'success' ? '✓' : '✗'}
                  </span>
                  <span className="text-gray-600">
                    Attempt {log.attempt_number} — {formatTime(log.created_at)}
                    {log.status !== 'success' && log.error_message ? ` · ${log.error_message}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )
        })()}

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
              <button onClick={() => setShowReprint(false)} className="flex-1 h-12 rounded-xl border-2 border-gray-400 bg-white font-semibold">No</button>
              <button onClick={handleReprint} disabled={printing} className="flex-1 h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-60">{printing ? 'Printing…' : 'Yes'}</button>
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
                <p className={`text-sm text-center rounded-lg px-3 py-3 font-semibold ${notice.cls}`}>{notice.text}</p>
              ) : null
            })()}
            {/* B2b/Part C: dispatched uber_direct cancel texts the customer
                "delivery canceled" — warn + show the number to call first.
                Only when a live Uber delivery is being released; in_house /
                undispatched cancels render exactly as before. */}
            {cancelFeeInfo?.dispatched && (
              <>
                <p className="text-sm text-center text-red-800">Uber will text the customer "delivery canceled."</p>
                {order.customer_phone && (
                  <div className="text-center">
                    <p className="text-sm text-red-800">Call {order.customer_name} first:</p>
                    <p className="text-2xl font-bold text-red-900 tracking-wide">{formatPhone(order.customer_phone)}</p>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-3">
              <button onClick={() => setShowCancelConfirm(false)} className="flex-1 h-12 rounded-xl border-2 border-gray-400 bg-white font-semibold">No</button>
              <button
                onClick={() => updateStatus('cancelled')}
                disabled={updating}
                className="flex-1 h-12 rounded-xl bg-red-600 text-white font-semibold disabled:opacity-50"
              >
                {cancelFeeInfo?.dispatched ? "I've called — Cancel & Refund" : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        )}

        {/* Status options */}
        {showStatusOptions && !showCancelConfirm && !showDeliverConfirm && !showRefundConfirm && (
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
                  // Step 4: an already-booked order (uber_delivery_id set,
                  // booked at placement) files straight to Scheduled — no
                  // prep modal, no re-dispatch. Otherwise: uber_direct opens
                  // the prep modal to dispatch; in_house just moves to
                  // scheduled (M9a behavior, unchanged).
                  if (order.uber_delivery_id) {
                    updateStatus('scheduled')
                  } else if (order.delivery_fulfillment_method === 'uber_direct') {
                    setShowStatusOptions(false)
                    if (order.scheduled_for) {
                      dispatchToUber()
                    } else {
                      setShowPrepTimeModal(true)
                    }
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
            {(order.status === 'in_progress' || order.status === 'scheduled' || order.status === 'self_delivering') && (
              <button
                onClick={() => updateStatus('complete')}
                disabled={updating}
                className="w-full h-12 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                {order.status === 'self_delivering' ? 'Mark Delivered' : 'Mark Complete'}
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
                  className={`h-12 rounded-xl border-2 text-lg font-bold transition-colors ${
                    selectedPrepMinutes === min
                      ? 'border-blue-700 bg-blue-600 text-white'
                      : 'border-blue-600 bg-blue-50 text-blue-900 active:bg-blue-100'
                  }`}
                >
                  {min} min
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-blue-900 font-semibold">Custom:</span>
              <input
                type="number"
                min="5"
                max="120"
                value={selectedPrepMinutes ?? ''}
                onChange={e => setSelectedPrepMinutes(Number(e.target.value) || null)}
                className="flex-1 h-12 px-3 border-2 border-blue-600 rounded-lg text-base text-blue-900 font-bold"
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
        {!showReprint && !showStatusOptions && !showCancelConfirm && !showDeliverConfirm && !showRefundConfirm && !showAdjustForm && !showPrepTimeModal && !showPriceChangeModal && (
          order.delivery_fulfillment_method === 'uber_direct' && order.status === 'new' && order.uber_delivery_id ? (
            /* Step 4: this uber_direct order was already booked with Uber at
               placement (status kept 'new' so it chimed/printed). Accept must
               NOT re-open the prep modal or re-dispatch — it just files the
               order to the Scheduled tab. Idempotency in createUberDelivery is
               a backstop; this branch avoids the dispatch UI entirely. */
            <div className="space-y-3">
              <button
                onClick={() => updateStatus('scheduled')}
                disabled={updating}
                className="w-full h-14 rounded-xl bg-amber-500 text-white font-bold text-base disabled:opacity-50"
              >
                Accept (Move to Scheduled)
              </button>
              {canDeliverInHouse && (
                <button
                  onClick={() => setShowDeliverConfirm(true)}
                  className="w-full h-12 rounded-xl border-2 border-gray-300 font-bold text-sm"
                >
                  Deliver In-House
                </button>
              )}
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
          ) : order.delivery_fulfillment_method === 'uber_direct' && order.status === 'new' ? (
            /* M10: Direct one-tap dispatch flow for new uber_direct orders.
               Skips the UPDATE STATUS intermediate step — primary CTA opens
               the prep modal directly. Cancel preserved as a text link below
               so the operator can still refund without going through Update
               Status. Existing in_progress / complete / cancelled paths fall
               into the else branch below. */
            <div className="space-y-3">
              {order.scheduled_for ? (
                <button
                  onClick={() => dispatchToUber()}
                  disabled={dispatching}
                  className="w-full h-14 rounded-xl bg-amber-500 text-white font-bold text-base disabled:opacity-50"
                >
                  Accept (Move to Scheduled)
                </button>
              ) : (
                <button
                  onClick={() => setShowPrepTimeModal(true)}
                  className="w-full h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base"
                >
                  Set Pickup Time & Mark in Progress
                </button>
              )}
              {canDeliverInHouse && (
                <button
                  onClick={() => setShowDeliverConfirm(true)}
                  className="w-full h-12 rounded-xl border-2 border-gray-300 font-bold text-sm"
                >
                  Deliver In-House
                </button>
              )}
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
            <div className="space-y-3">
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
                ) : order.status === 'self_delivering' ? (
                  <button
                    onClick={() => updateStatus('complete')}
                    disabled={updating}
                    className="flex-1 h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base disabled:opacity-50"
                  >
                    Mark Delivered
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
              {order.status === 'self_delivering' && (
                <button
                  onClick={openCancelConfirm}
                  disabled={fetchingFee}
                  className="w-full text-center text-sm text-red-600 hover:text-red-800 py-1 disabled:opacity-50"
                >
                  {fetchingFee ? 'Checking…' : 'Cancel & Refund Order'}
                </button>
              )}
              {canDeliverInHouse && (
                <button
                  onClick={() => setShowDeliverConfirm(true)}
                  className="w-full h-12 rounded-xl border-2 border-gray-300 font-bold text-sm"
                >
                  Deliver In-House
                </button>
              )}
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

  // Keep an open detail view in sync with the 10s poll so it auto-escalates
  // (e.g. stuck stage 2 → 3) without the operator re-opening it. The orders
  // array gets a fresh row each poll; sync selectedOrder to it by id. Guarded
  // by reference inequality so this doesn't loop, and we keep the existing
  // selection if the order temporarily drops out of the fetched set.
  useEffect(() => {
    if (!selectedOrder) return
    const fresh = orders.find(o => o.id === selectedOrder.id)
    if (fresh && fresh !== selectedOrder) {
      setSelectedOrder(fresh)
    }
  }, [orders, selectedOrder])

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
    // Stuck-pending ack: tapping a stage >= 2 tile silences the chime. Stamp
    // it fresh each tap (re-acking at stage 3 records a post-boundary time, so
    // isStuckUnacked stays false; a stage-2 ack predates the stage-3 boundary
    // and will re-fire — D4). DB-backed so it survives a Fully Kiosk reload.
    if (getStuckStage(order, Date.now()) >= 2) {
      const stuckAt = new Date().toISOString()
      setOrders(prev => prev.map(o => o.id === order.id ? { ...o, stuck_acknowledged_at: stuckAt } : o))
      const { error } = await supabase
        .from('orders')
        .update({ stuck_acknowledged_at: stuckAt })
        .eq('id', order.id)
      if (error) console.error('[StuckAck] write failed', error)
    }
  }

  async function handleRetryPrint(order) {
    if (!restaurant?.printer_ip) return
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('*, order_item_toppings(*)')
      .eq('order_id', order.id)
      .order('created_at')

    const result = await printOrder(restaurant.printer_ip, { ...order, items: orderItems || [] }, { name: restaurant.name, address: restaurant.address, phone: restaurant.phone, receipt_font: restaurant?.receipt_font ?? 'standard' })

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
      // Design B: a self-delivering order with a future scheduled pickup stays in
      // the Scheduled tab until its time passes; otherwise it's active In Progress.
      if (subTab === 'scheduled') return o.status === 'scheduled' || isScheduledSelfDeliver(o)
      if (subTab === 'in_progress') return o.status === 'in_progress' || (o.status === 'self_delivering' && !isScheduledSelfDeliver(o))
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

  // Live "is Uber Direct the active method right now?" — pure read of restaurant
  // state, recomputed each render. The 10s poll re-renders OrdersTab, so this
  // refreshes at schedule window boundaries (same cadence as escalation).
  const uberActive = restaurant ? isUberActiveNow(restaurant) : false

  return (
    <div className="h-full flex flex-col">
      {/* Delivery toggle */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-100">
        {/* Left: delivery status + context-aware descriptor / Uber badge */}
        <span className="flex items-baseline gap-2">
          <span className={`text-sm font-medium ${restaurant.delivery_available ? 'text-gray-900' : 'text-gray-400'}`}>
            Delivery: {restaurant.delivery_available ? 'ON' : 'OFF'}
            {!restaurant.delivery_available && ', Not Accepting Deliveries'}
          </span>
          {restaurant.delivery_available && uberActive && (
            <span className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-[#16A34A]">Uber: Active</span>
              <span
                className="inline-block w-2 h-2 rounded-full bg-[#16A34A] animate-pulse"
                style={{ boxShadow: '0 0 0 3px rgba(22, 163, 74, 0.25)' }}
              />
            </span>
          )}
        </span>
        {/* Right: toggle */}
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
            {tab.key !== 'complete' && (() => {
              const now = Date.now()
              // Count predicate = same status→tab mapping as filteredOrders.
              const tabOrders = orders.filter(o =>
                tab.key === 'in_progress'
                  ? (o.status === 'in_progress' || (o.status === 'self_delivering' && !isScheduledSelfDeliver(o)))
                  : tab.key === 'scheduled'
                    ? (o.status === 'scheduled' || isScheduledSelfDeliver(o))
                    : o.status === tab.key
              )
              if (tabOrders.length === 0) return null
              // Per-tab urgency → badge color. Default neutral grey.
              let color = 'bg-gray-200 text-gray-700'
              if (tab.key === 'new') {
                color = 'bg-red-500 text-white'
              } else if (tab.key === 'in_progress') {
                if (tabOrders.some(o => getStuckStage(o, now) === 3)) {
                  color = 'bg-red-500 text-white'
                } else if (tabOrders.some(o => getStuckStage(o, now) === 2)) {
                  color = 'bg-amber-400 text-black'
                }
              }
              // Scheduled: always grey (no urgency state).
              return (
                <span className={`ml-2 text-xs rounded-full px-2 py-0.5 ${color}`}>
                  {tabOrders.length}
                </span>
              )
            })()}
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
                        <OrderCard key={order.id} order={order} onTap={handleOrderTap} onRetryPrint={restaurant?.printer_ip ? handleRetryPrint : null} printTrigger={restaurant?.print_trigger} />
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
            <OrderCard key={order.id} order={order} onTap={handleOrderTap} onRetryPrint={restaurant?.printer_ip ? handleRetryPrint : null} printTrigger={restaurant?.print_trigger} />
          ))
        )}
      </div>
    </div>
  )
}
