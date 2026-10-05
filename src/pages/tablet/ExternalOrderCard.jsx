import { providerDisplay } from '../../utils/dspProvider'

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
  const count = itemCount(order.items)
  const total = formatMoney(order.total)

  return (
    <div className={`w-full text-left rounded-xl border border-gray-200 border-l-4 ${provider.border} shadow-sm hover:shadow-md transition-shadow ${isUnacked ? 'animate-flash-green' : 'bg-white'}`}>
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
        </div>
        {order.customer_name && (
          <div className="text-sm text-gray-500 mb-1 truncate">{order.customer_name}</div>
        )}
        <div className="flex justify-between items-center text-gray-600 text-sm">
          <span className="font-medium text-gray-900">#{order.order_number ?? order.daily_number ?? '—'}</span>
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
