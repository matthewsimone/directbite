import { providerDisplay, dspOrderNumber, DSP_ESCALATION_MINUTES } from '../../utils/dspProvider'
import { formatScheduledLabel } from '../../utils/scheduling'

// DSP (KitchenHub) order tile. Mirrors OrderCard's container + un-acked
// flash so DSP and Ordr tiles read as one queue. Display only.

export function formatMoney(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v)
}

function itemCount(items) {
  if (!Array.isArray(items)) return 0
  return items.reduce((sum, i) => sum + (Number(i?.quantity) || 1), 0)
}

// placed_at is the provider's placement time; created_at is our ingest time.
function formatAge(o) {
  const t = new Date(o.placed_at || o.created_at).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ${mins % 60}m ago` : `${Math.floor(hrs / 24)}d ago`
}

export default function ExternalOrderCard({ order, onTap }) {
  const provider = providerDisplay(order)
  const isUnacked = order.status === 'new' && !order.acknowledged_at
  // Same treatment as OrderCard's isEscalating, on the DSP window: tapped but
  // still not accepted for >= DSP_ESCALATION_MINUTES (same window as
  // hasEscalation in useOrderPolling). Mutually exclusive with isUnacked.
  const isEscalating =
    order.status === 'new' &&
    order.acknowledged_at != null &&
    (Date.now() - new Date(order.acknowledged_at).getTime()) >= DSP_ESCALATION_MINUTES * 60 * 1000
  const count = itemCount(order.items)
  const total = formatMoney(order.total)
  const stateClass = isUnacked ? 'animate-flash-green'
    : isEscalating ? 'animate-flash-yellow'
    : 'bg-white'

  return (
    <div className={`w-full text-left rounded-xl border border-gray-200 border-l-4 ${provider.border} shadow-sm hover:shadow-md transition-shadow ${stateClass}`}>
      <button onClick={() => onTap(order)} className="w-full text-left p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-2 py-0.5 rounded text-xs font-bold tracking-wide whitespace-nowrap ${provider.cls}`}>
            {provider.label}
          </span>
          {order.status === 'cancelled' && (
            <span className="px-2 py-0.5 rounded-full bg-red-600 text-white text-xs font-bold whitespace-nowrap">
              CANCELLED
            </span>
          )}
          {/* Same pill as OrderCard's scheduled badge (OrdersTab.jsx). */}
          {order.scheduled_for && (
            <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-300 text-black text-xs font-semibold whitespace-nowrap">
              Scheduled {formatScheduledLabel(order.scheduled_for)}
            </span>
          )}
        </div>
        {order.customer_name && (
          <div className="text-sm text-gray-500 mb-1 truncate">{order.customer_name}</div>
        )}
        <div className="flex justify-between items-center text-gray-600 text-sm">
          <span className="font-medium text-gray-900">#{dspOrderNumber(order) ?? '—'}</span>
          <span>{formatAge(order)}</span>
        </div>
        <div className="flex justify-between items-center text-gray-600 text-sm mt-1">
          <span>{count} item{count === 1 ? '' : 's'}</span>
          {total && <span className="font-semibold text-gray-900">{total}</span>}
        </div>
      </button>
    </div>
  )
}
