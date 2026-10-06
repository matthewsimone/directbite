import { providerIcon, dspOrderNumber, DSP_ESCALATION_MINUTES } from '../../utils/dspProvider'
import { formatScheduledLabel } from '../../utils/scheduling'
import AppIcon from './AppIcon'

// DSP (KitchenHub) order tile: provider app icon on the left, then order
// type / customer / order # + clock time. Keeps OrderCard's un-acked flash and
// the DSP escalation flash so DSP and Ordr tiles read as one queue.

// Money as "$x.xx"; negatives as "-$x.xx" (not "$-x.xx"). Null when absent.
export function formatMoney(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`
}

// Same clock format as OrderCard's formatTime (tablet local time).
function formatClock(dateStr) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

export default function ExternalOrderCard({ order, onTap }) {
  const icon = providerIcon(order)
  const isDelivery = String(order.order_type || '').toLowerCase().includes('delivery')
  const isUnacked = order.status === 'new' && !order.acknowledged_at
  // Same treatment as OrderCard's isEscalating, on the DSP window: tapped but
  // still not accepted for >= DSP_ESCALATION_MINUTES (same window as
  // hasEscalation in useOrderPolling). Mutually exclusive with isUnacked.
  const isEscalating =
    order.status === 'new' &&
    order.acknowledged_at != null &&
    (Date.now() - new Date(order.acknowledged_at).getTime()) >= DSP_ESCALATION_MINUTES * 60 * 1000
  const stateClass = isUnacked ? 'animate-flash-green'
    : isEscalating ? 'animate-flash-yellow'
    : 'bg-white'

  return (
    <div className={`w-full text-left rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow ${stateClass}`}>
      <button onClick={() => onTap(order)} className="w-full text-left p-4">
        <div className="flex items-start gap-3">
          <AppIcon src={icon.src} initials={icon.initials} alt={icon.name} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-bold text-sm tracking-wide uppercase">{isDelivery ? 'DELIVERY' : 'PICKUP'}</span>
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
              <span>{formatClock(order.placed_at || order.created_at)}</span>
            </div>
          </div>
        </div>
      </button>
    </div>
  )
}
