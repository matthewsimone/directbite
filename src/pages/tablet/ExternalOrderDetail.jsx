import { useState } from 'react'
import { formatMoney } from './ExternalOrderCard'
import { providerDisplay } from '../../utils/dspProvider'
import { printExternalOrder } from '../../utils/epsonPrint'
import { writeExternalPrintResult } from '../../utils/externalPrintStatus'

// DSP order detail. Full-screen overlay matching OrderDetail's frame.
// Actions: REPRINT and Back. Accept/Ready/Cancel come with KitchenHub write-back.

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

function formatTime(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
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

export default function ExternalOrderDetail({ order, restaurant, onBack }) {
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState(null)
  const hasPrinter = !!restaurant?.printer_ip

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

  const provider = providerDisplay(order)
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
            <h2 className="text-xl font-bold">#{order.order_number ?? order.daily_number ?? '—'}</h2>
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
        <div className="flex gap-3">
          <button
            onClick={handleReprint}
            disabled={!hasPrinter || printing}
            className="flex-1 h-14 rounded-xl border-2 border-gray-300 font-bold text-base disabled:opacity-60"
          >
            {!hasPrinter ? 'NO PRINTER' : printing ? 'PRINTING…' : 'REPRINT'}
          </button>
          <button onClick={onBack} className="flex-1 h-14 rounded-xl border-2 border-gray-300 font-bold text-base">
            Back
          </button>
        </div>
      </div>
    </div>
  )
}
