import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { formatMoney } from './ExternalOrderCard'
import { providerDisplay, dspOrderNumber } from '../../utils/dspProvider'
import { printExternalOrder } from '../../utils/epsonPrint'
import { writeExternalPrintResult } from '../../utils/externalPrintStatus'

// DSP order detail. Full-screen overlay matching OrderDetail's frame.
// Actions go to KitchenHub through the kh-order-action edge function:
//   new                  → Confirm N min (accept with prep time) / MORE OPTIONS
//                          (prep-time ladder + Cancel Order with confirm)
//   accepted             → MARK READY (KitchenHub 'complete')
//   completed/cancelled  → REPRINT and Back only

// Prep time is cooking time for every DSP order — the courier owns delivery —
// so pickup and delivery orders both use the pickup ladder and default.
// Keep in sync with PICKUP_LADDER in OrdersTab.jsx (Ordr ready-time bar).
const PICKUP_LADDER = [10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 90]

// KitchenHub Charges keys, in display order. Values pass through as given.
const CHARGE_LABELS = [
  ['subtotal', 'Subtotal'],
  ['discount', 'Discount'],
  ['free_options_discount', 'Free options discount'],
  ['tax', 'Tax'],
  ['delivery_fee', 'Delivery fee'],
  ['service_fee', 'Service fee'],
  ['processing_fee', 'Processing fee'],
  ['tips', 'Tips'],
  ['restaurant_tip_amount', 'Restaurant tip'],
  ['adjustment', 'Adjustment'],
  ['commission', 'Commission'],
  ['tax_payout', 'Tax payout'],
  ['payout', 'Payout'],
]

const STATUS_PILL = {
  new: 'bg-yellow-100 text-yellow-800',
  accepted: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
}

// Status each action moves the order to — local patch applies only when the
// server reports this exact status back.
const TARGET = { accept: 'accepted', complete: 'completed', cancel: 'cancelled' }

function formatTime(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatClock(ms) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms))
}

// Local mirror of the server write so the tile + detail update before the
// next poll; the poll and realtime reconcile right after.
function localStamps(action, prepTime) {
  const now = new Date().toISOString()
  if (action === 'accept') return { accepted_at: now, prep_time_minutes: prepTime }
  if (action === 'complete') return { completed_at: now }
  return { cancelled_at: now, cancelled_by: 'restaurant' }
}

function actionErrorMessage(result, providerName) {
  switch (result?.error) {
    case 'conflict':
      return `${providerName} already has this order as ${result.status}. The tablet has been updated.`
    case 'invalid_status':
      return `This order is already ${result.status}.`
    case 'not_main_account':
      return result.message
    case 'store_not_enabled':
      return 'DSP order actions are not enabled for this store.'
    case 'kitchenhub_error':
      return `${providerName} did not accept the update${result.http ? ` (HTTP ${result.http})` : ''}. Try again, or use the ${providerName} tablet.`
    case 'forbidden':
      return 'This order belongs to a different restaurant.'
    case 'missing_auth':
    case 'invalid_auth':
      return 'Session expired. Please log in again.'
    default:
      return 'Update failed. Please try again.'
  }
}

function OptionLines({ options, depth }) {
  if (!Array.isArray(options) || options.length === 0) return null
  return options.map((op, i) => (
    <div key={i}>
      <p className="text-sm text-gray-600" style={{ paddingLeft: `${1.5 + depth}rem` }}>
        {op?.modifier_name ? `${op.modifier_name}: ` : ''}
        {Number(op?.quantity) > 1 ? `${op.quantity}x ` : ''}
        {op?.name}
      </p>
      <OptionLines options={op?.options} depth={depth + 1} />
    </div>
  ))
}

function Row({ label, value, className = '' }) {
  return (
    <div className={`flex justify-between text-sm ${className}`}>
      <span className="text-gray-500">{label}</span>
      <span>{value}</span>
    </div>
  )
}

export default function ExternalOrderDetail({ order, restaurant, onBack, setExternalOrders, fetchOrders }) {
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState(null)
  const [acting, setActing] = useState(null) // null | 'accept' | 'complete' | 'cancel'
  const [actionError, setActionError] = useState(null)
  const [showOptions, setShowOptions] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  // Ticks only while the ladder is open so each row's clock time stays honest.
  const [nowTick, setNowTick] = useState(() => Date.now())
  const hasPrinter = !!restaurant?.printer_ip
  const provider = providerDisplay(order)
  const defaultPrepMinutes = restaurant?.estimated_pickup_minutes || 30

  useEffect(() => {
    if (!showOptions) return
    const t = setInterval(() => setNowTick(Date.now()), 15000)
    return () => clearInterval(t)
  }, [showOptions])

  // A webhook (or another tablet) can move the order while a sheet is open;
  // the accept/cancel sheets only make sense for 'new'.
  useEffect(() => {
    if (order.status !== 'new') {
      setShowOptions(false)
      setShowCancelConfirm(false)
    }
  }, [order.status])

  async function handleReprint() {
    if (!hasPrinter || printing) return
    setPrinting(true)
    setPrintError(null)
    try {
      const attempt = (order.print_attempts || 0) + 1
      const result = await printExternalOrder(restaurant.printer_ip, order, { name: restaurant.name }, 1)
      // Mirrors the Ordr reprint: in 'in_progress' print mode an untaken order
      // must stay 'pending' or its on-accept auto-print would be skipped.
      const awaitingTake = restaurant?.print_trigger === 'in_progress' && order.status === 'new'
      if (!awaitingTake) await writeExternalPrintResult(order.id, result, attempt)
      if (!result.success) setPrintError(result.message)
    } finally {
      setPrinting(false)
    }
  }

  async function runAction(action, prepTime) {
    if (acting) return
    setActing(action)
    setActionError(null)
    try {
      const { data: { session }, error: refreshError } = await supabase.auth.refreshSession()
      if (refreshError || !session) {
        setActionError('Session expired. Please log in again.')
        return
      }
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kh-order-action`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            external_order_id: order.id,
            action,
            ...(action === 'accept' ? { prep_time: prepTime } : {}),
          }),
        }
      )
      const result = await res.json().catch(() => null)
      if (result?.ok) {
        const stamps = result.status === TARGET[action] ? localStamps(action, prepTime) : {}
        setExternalOrders(prev => prev.map(o => o.id === order.id ? { ...o, status: result.status, ...stamps } : o))
        setShowOptions(false)
        setShowCancelConfirm(false)
        fetchOrders()
        return
      }
      // conflict / invalid_status carry KitchenHub's (or our) current status.
      if (result?.status) {
        setExternalOrders(prev => prev.map(o => o.id === order.id ? { ...o, status: result.status } : o))
      }
      setActionError(actionErrorMessage(result, provider.name))
    } catch (err) {
      console.error('[ExtAction] request failed', err)
      setActionError('Request failed. Please try again.')
    } finally {
      setActing(null)
    }
  }

  const reprintButton = (className, compact) => (
    <button onClick={handleReprint} disabled={!hasPrinter || printing || !!acting} className={className}>
      {!hasPrinter ? 'NO PRINTER' : printing ? (compact ? '…' : 'PRINTING…') : 'REPRINT'}
    </button>
  )

  const items = Array.isArray(order.items) ? order.items : []
  const charges = order.charges && typeof order.charges === 'object' ? order.charges : {}
  const otherFees = charges.other_fee && typeof charges.other_fee === 'object' ? Object.entries(charges.other_fee) : []
  const type = [order.order_type, order.delivery_type].filter(Boolean).join(' · ')
  const total = formatMoney(charges.total ?? order.total)

  return (
    <div className="fixed inset-0 flex flex-col bg-white overflow-hidden z-20">
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
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs font-bold tracking-wide ${provider.cls}`}>{provider.label}</span>
            <h2 className="text-xl font-bold">#{dspOrderNumber(order) ?? '—'}</h2>
            {order.paid === false && (
              <span className="px-2 py-0.5 rounded text-xs font-bold tracking-wide bg-amber-400 text-black">UNPAID</span>
            )}
          </div>
          <p className="text-sm text-gray-500">{formatTime(order.placed_at || order.created_at)}</p>
        </div>
        <span className={`ml-auto px-3 py-1 rounded-full text-xs font-semibold uppercase ${STATUS_PILL[order.status] || 'bg-gray-100 text-gray-700'}`}>
          {order.status}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-6" style={{ WebkitOverflowScrolling: 'touch' }}>
        {type && (
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Type</h3>
            <p className="text-base font-medium uppercase">{type}</p>
          </div>
        )}

        {order.scheduled_for && (
          <div className="bg-amber-100 border border-amber-300 rounded-xl px-4 py-3">
            <p className="text-base font-semibold text-amber-900">Scheduled for: {formatTime(order.scheduled_for)}</p>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Customer</h3>
          <p className="text-lg font-medium">{order.customer_name || '—'}</p>
          {order.customer_phone && <p className="text-lg text-gray-700">{order.customer_phone}</p>}
        </div>

        {order.notes && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-amber-800 uppercase tracking-wide mb-1">Notes</h3>
            <p className="text-base text-amber-900 font-medium">{order.notes}</p>
          </div>
        )}

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Items</h3>
          {items.map((item, i) => (
            <div key={i} className="space-y-1">
              <p className="font-bold text-base">{Number(item?.quantity) || 1}x {item?.name}</p>
              <OptionLines options={item?.options} depth={0} />
              {item?.instructions && (
                <p className="pl-6 text-sm italic text-gray-400">{item.instructions}</p>
              )}
            </div>
          ))}
        </div>

        <div className="space-y-1 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Provider charges</h3>
          {CHARGE_LABELS.map(([key, label]) => {
            const v = formatMoney(charges[key])
            return v ? <Row key={key} label={label} value={v} /> : null
          })}
          {otherFees.map(([k, v]) => {
            const fv = formatMoney(v)
            return fv ? <Row key={`other-${k}`} label={k} value={fv} /> : null
          })}
          {total && (
            <div className="flex justify-between font-bold text-lg pt-1 border-t border-gray-100 mt-1">
              <span>Total</span>
              <span>{total}</span>
            </div>
          )}
          {order.payment_method && <Row label="Payment" value={order.payment_method} />}
        </div>
      </div>

      <div className="shrink-0 px-4 pt-4 border-t border-gray-200 bg-white space-y-2" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))' }}>
        {printError && <p className="text-sm text-red-600 text-center">Reprint failed: {printError}</p>}
        {actionError && <p className="text-sm text-red-600 text-center">{actionError}</p>}

        {showCancelConfirm ? (
          <div className="bg-red-50 p-4 rounded-xl space-y-3">
            <p className="text-center font-medium text-red-800">
              Cancel this {provider.name} order? {provider.name} will notify the customer.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowCancelConfirm(false)}
                disabled={!!acting}
                className="flex-1 h-12 rounded-xl border-2 border-gray-400 bg-white font-semibold disabled:opacity-50"
              >
                No
              </button>
              <button
                onClick={() => runAction('cancel')}
                disabled={!!acting}
                className="flex-1 h-12 rounded-xl bg-red-600 text-white font-semibold disabled:opacity-50"
              >
                {acting === 'cancel' ? 'CANCELLING…' : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        ) : showOptions ? (
          <div className="bg-gray-50 p-4 rounded-xl space-y-3">
            <p className="font-semibold text-gray-800">Ready in</p>
            <div className="max-h-[18rem] overflow-y-auto space-y-2 -mx-1 px-1">
              {PICKUP_LADDER.map(min => (
                <button
                  key={min}
                  onClick={() => runAction('accept', min)}
                  disabled={!!acting}
                  className="w-full h-14 rounded-xl border-2 border-gray-300 bg-white active:bg-gray-100 disabled:opacity-50 flex items-center justify-between px-5"
                >
                  <span className="text-base font-bold text-gray-900">{min} min</span>
                  <span className="text-sm text-gray-500">{formatClock(nowTick + min * 60000)}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowCancelConfirm(true)}
              disabled={!!acting}
              className="w-full h-12 rounded-xl bg-red-600 text-white font-semibold disabled:opacity-50"
            >
              Cancel Order
            </button>
            <button
              onClick={() => setShowOptions(false)}
              disabled={!!acting}
              className="w-full h-12 rounded-xl border border-gray-300 font-semibold disabled:opacity-50"
            >
              Back
            </button>
          </div>
        ) : order.status === 'new' ? (
          <div className="flex gap-3">
            {reprintButton('basis-[18%] h-14 rounded-xl border-2 border-gray-300 font-bold text-xs disabled:opacity-60', true)}
            <button
              onClick={() => { setNowTick(Date.now()); setShowOptions(true) }}
              disabled={!!acting}
              className="basis-[32%] h-14 rounded-xl border-2 border-gray-300 font-bold text-sm disabled:opacity-50"
            >
              MORE OPTIONS
            </button>
            <button
              onClick={() => runAction('accept', defaultPrepMinutes)}
              disabled={!!acting}
              className="basis-[50%] h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base disabled:opacity-50"
            >
              {acting === 'accept' ? 'CONFIRMING…' : `Confirm ${defaultPrepMinutes} min`}
            </button>
          </div>
        ) : order.status === 'accepted' ? (
          <div className="flex gap-3">
            {reprintButton('flex-1 h-14 rounded-xl border-2 border-gray-300 font-bold text-base disabled:opacity-60', false)}
            <button
              onClick={() => runAction('complete')}
              disabled={!!acting}
              className="flex-1 h-14 rounded-xl bg-[#16A34A] text-white font-bold text-base disabled:opacity-50"
            >
              {acting === 'complete' ? 'MARKING…' : 'MARK READY'}
            </button>
          </div>
        ) : (
          <div className="flex gap-3">
            {reprintButton('flex-1 h-14 rounded-xl border-2 border-gray-300 font-bold text-base disabled:opacity-60', false)}
            <button onClick={onBack} className="flex-1 h-14 rounded-xl border-2 border-gray-300 font-bold text-base">
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
