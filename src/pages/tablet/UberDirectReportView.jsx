import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { formatCurrency } from '../../utils/format'
import { getNyDateKey, getRangeForPreset } from '../../utils/scheduling'

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'lastMonth', label: 'Last Month' },
  { key: 'custom', label: 'Custom Range' },
]

// Sum a list of dollar-valued items as integer cents to avoid float drift.
// Returns integer cents; caller divides by 100 once at the end. Mirrors
// ReportsView. NOTE: feed DOLLAR values only — uber_cancellation_fee_cents is
// already cents and is summed raw, never through this helper.
function sumCentsInt(arr, getDollarsFn) {
  let cents = 0
  for (const item of arr) {
    cents += Math.round(Number(getDollarsFn(item)) * 100)
  }
  return cents
}

// "May 18 – May 25" for cross-day ranges, "May 25" for single-day. Year
// included only when start year differs from end year. Copied from ReportsView.
function formatRangeLabel(startKey, endKey) {
  const [sy, sm, sd] = startKey.split('-').map(Number)
  const [ey, em, ed] = endKey.split('-').map(Number)
  const crossYear = sy !== ey
  const opts = {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    ...(crossYear ? { year: 'numeric' } : {}),
  }
  const fmt = new Intl.DateTimeFormat('en-US', opts)
  const sDate = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0))
  const eDate = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0))
  if (startKey === endKey) return fmt.format(sDate)
  return `${fmt.format(sDate)} – ${fmt.format(eDate)}`
}

// Short date for the per-order drill-down rows (NY time).
function formatRowDate(createdAt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(createdAt))
}

export default function UberDirectReportView({ restaurant, onBack }) {
  const isPlatform = (restaurant?.uber_billing_mode ?? 'self') === 'platform'
  const initialKey = getNyDateKey(new Date())
  const [preset, setPreset] = useState('today')
  const [customStart, setCustomStart] = useState(initialKey)
  const [customEnd, setCustomEnd] = useState(initialKey)
  // Applied bounds only change on Apply, so date-input keystrokes don't refetch.
  const [appliedCustomStart, setAppliedCustomStart] = useState(initialKey)
  const [appliedCustomEnd, setAppliedCustomEnd] = useState(initialKey)
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const requestIdRef = useRef(0)

  const { startKey, endKey, queryStartIso, queryEndIso } = useMemo(
    () => getRangeForPreset(preset, {
      customStart: appliedCustomStart,
      customEnd: appliedCustomEnd,
    }),
    [preset, appliedCustomStart, appliedCustomEnd]
  )

  useEffect(() => {
    if (!restaurant?.id) return
    const myId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    supabase
      .from('orders')
      .select(
        'id, order_number, status, delivery_fulfillment_method, subtotal, total_amount, delivery_fee, tip_amount, uber_quoted_fee, uber_actual_fee, uber_cancellation_fee_cents, created_at'
      )
      .eq('restaurant_id', restaurant.id)
      .gte('created_at', queryStartIso)
      .lte('created_at', queryEndIso)
      .then(res => {
        if (requestIdRef.current !== myId) return
        if (res.error) throw res.error
        setOrders(res.data || [])
        setLoading(false)
      })
      .catch(err => {
        if (requestIdRef.current !== myId) return
        console.error('[UberDirectReportView] fetch failed', err)
        setError(err.message || 'Failed to load report')
        setLoading(false)
      })
  }, [restaurant?.id, queryStartIso, queryEndIso, retryCount])

  const totals = useMemo(() => {
    // Post-filter to the precise NY-day window (query envelope is wider for
    // DST safety; getNyDateKey gives trustworthy day membership), then to
    // uber_direct only.
    const inRange = (createdAt) => {
      const key = getNyDateKey(new Date(createdAt))
      return key >= startKey && key <= endKey
    }
    const uberOrders = orders
      .filter(o => inRange(o.created_at))
      .filter(o => o.delivery_fulfillment_method === 'uber_direct')

    const completed = uberOrders.filter(o => o.status === 'complete')
    const cancelled = uberOrders.filter(o => o.status === 'cancelled')

    // Effective Uber fee (DOLLARS): actual, fallback to quoted when actual is
    // null (pre-capture orders), else 0.
    const effUberFee = (o) =>
      o.uber_actual_fee != null ? Number(o.uber_actual_fee)
        : o.uber_quoted_fee != null ? Number(o.uber_quoted_fee)
          : 0

    // Delivery sales (completed) + order count
    const deliverySalesCents = sumCentsInt(completed, o => o.subtotal)
    const orderCount = completed.length

    // Customer-paid delivery fees (completed)
    const customerDeliveryCents = sumCentsInt(completed, o => o.delivery_fee)

    // Restaurant out-of-pocket = Σ (effUberFee − delivery_fee), completed.
    // Signed (allow negative): if the customer paid more than the Uber fee the
    // restaurant profited on delivery markup — we don't clamp.
    const outOfPocketCents = sumCentsInt(
      completed, o => effUberFee(o) - Number(o.delivery_fee || 0)
    )

    // Cancellation fees (cancelled) — uber_cancellation_fee_cents is CENTS,
    // sum raw (NOT through sumCentsInt).
    const cancellationCents = cancelled.reduce(
      (s, o) => s + (Number(o.uber_cancellation_fee_cents) || 0), 0
    )

    // Total Uber Charges (headline) = Σ effUberFee (completed)
    //   + Σ cancellation fees (cancelled). Intentionally spans complete +
    //   cancelled, unlike the sales/fee lines which are completed-only.
    const totalUberChargesCents =
      sumCentsInt(completed, o => effUberFee(o)) + cancellationCents

    // Net after delivery cost = delivery sales − out-of-pocket − cancellation
    const netCents = deliverySalesCents - outOfPocketCents - cancellationCents

    // Quoted-vs-actual variance: both present AND differ by >1¢.
    const variancePairs = completed.filter(o =>
      o.uber_actual_fee != null && o.uber_quoted_fee != null &&
      Math.abs(Number(o.uber_actual_fee) - Number(o.uber_quoted_fee)) > 0.01
    )
    const varianceCount = variancePairs.length
    const varianceAbsCents = sumCentsInt(
      variancePairs, o => Math.abs(Number(o.uber_actual_fee) - Number(o.uber_quoted_fee))
    )

    // Pre-capture flag: completed uber orders with no actual fee (quoted est).
    const missingActualCount = completed.filter(o => o.uber_actual_fee == null).length

    // Per-order drill-down rows (newest first). absorbed = effUberFee − paid.
    const rows = [...uberOrders]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(o => ({
        id: o.id,
        orderNumber: o.order_number,
        date: formatRowDate(o.created_at),
        status: o.status,
        customerPaid: Number(o.delivery_fee || 0),
        uberActual: o.uber_actual_fee != null ? Number(o.uber_actual_fee) : null,
        isEstimate: o.uber_actual_fee == null,
        absorbed: effUberFee(o) - Number(o.delivery_fee || 0),
        cancellationFee: (Number(o.uber_cancellation_fee_cents) || 0) / 100,
      }))

    // -------- Platform-billing figures (additive; self mode ignores these) --------
    // Mirrors _shared/uberCreateDelivery.ts (tip fronted to Uber, capped at $5)
    // and create-payment-intent's platform application fee. Spans completed +
    // cancelled — like totalUberCharges above — so cancellation fees count as a
    // platform charge. All in integer cents (caller divides by 100 at render).
    let platformTotalChargesCents = 0
    let platformCustomerCoveredCents = 0
    let platformVarianceCount = 0
    let platformVarianceTotalCents = 0
    for (const o of uberOrders) {
      const frontedTipCents = Math.min(Math.round(Number(o.tip_amount || 0) * 100), 500)
      const quotedCents = Math.round(Number(o.uber_quoted_fee || 0) * 100)
      const actualCents = o.uber_actual_fee != null
        ? Math.round(Number(o.uber_actual_fee) * 100)
        : null
      const collectedForUberCents = quotedCents + frontedTipCents
      const paidToUberCents = o.status === 'cancelled'
        ? (Number(o.uber_cancellation_fee_cents) || 0)
        : (actualCents != null ? actualCents : quotedCents) + frontedTipCents
      const variance = paidToUberCents - collectedForUberCents
      platformTotalChargesCents += paidToUberCents
      platformCustomerCoveredCents += Math.round(Number(o.delivery_fee || 0) * 100)
      if (Math.abs(variance) > 1) {
        platformVarianceCount++
        platformVarianceTotalCents += variance
      }
    }
    const platformYouCoveredCents = platformTotalChargesCents - platformCustomerCoveredCents

    return {
      deliverySales: deliverySalesCents / 100,
      orderCount,
      customerDelivery: customerDeliveryCents / 100,
      outOfPocket: outOfPocketCents / 100,
      totalUberCharges: totalUberChargesCents / 100,
      cancellationFees: cancellationCents / 100,
      net: netCents / 100,
      varianceCount,
      varianceAbs: varianceAbsCents / 100,
      missingActualCount,
      rows,
      // Platform-mode aggregates (cents). Self mode never reads these.
      platformTotalCharges: platformTotalChargesCents,
      platformCustomerCovered: platformCustomerCoveredCents,
      platformYouCovered: platformYouCoveredCents,
      platformVarianceCount,
      platformVarianceTotalCents,
    }
  }, [orders, startKey, endKey])

  const customInvalid = preset === 'custom' && customStart > customEnd

  function applyCustom() {
    if (customInvalid) return
    setAppliedCustomStart(customStart)
    setAppliedCustomEnd(customEnd)
  }

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
        <h2 className="text-xl font-bold">UberDirect Report</h2>
      </div>

      {/* Date range selector */}
      <div className="shrink-0 p-4 border-b border-gray-200 space-y-3">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`px-4 h-10 rounded-full text-sm font-medium transition-colors ${
                preset === p.key
                  ? 'bg-[#16A34A] text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="space-y-2">
            <div className="flex gap-2 items-center">
              <input
                type="date"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                className="flex-1 h-11 px-3 border border-gray-300 rounded-xl text-base"
              />
              <span className="text-gray-400">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                className="flex-1 h-11 px-3 border border-gray-300 rounded-xl text-base"
              />
              <button
                onClick={applyCustom}
                disabled={customInvalid}
                className="h-11 px-4 rounded-xl bg-[#16A34A] text-white font-semibold disabled:opacity-50"
              >
                Apply
              </button>
            </div>
            {customInvalid && (
              <p className="text-xs text-red-500">End date must be on or after start date.</p>
            )}
          </div>
        )}
        <p className="text-xs text-gray-500">Showing: {formatRangeLabel(startKey, endKey)}</p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="text-center text-gray-400 mt-8">Loading...</p>
        ) : error ? (
          <div className="max-w-md mx-auto bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
            <p className="text-red-700 text-sm">Failed to load report: {error}</p>
            <button
              onClick={() => setRetryCount(c => c + 1)}
              className="w-full h-11 rounded-xl bg-red-600 text-white font-semibold"
            >
              Retry
            </button>
          </div>
        ) : totals.rows.length === 0 ? (
          <p className="text-center text-gray-400 mt-8">No UberDirect orders in this range</p>
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Headline */}
            {isPlatform ? (
              <div className="bg-gray-900 text-white rounded-2xl p-5">
                <p className="text-sm font-medium text-gray-300">Total Charges</p>
                <p className="text-4xl font-bold mt-1">{formatCurrency(totals.platformTotalCharges / 100)}</p>
                {totals.missingActualCount > 0 && (
                  <p className="text-xs text-amber-300 mt-2">
                    ⚠ {totals.missingActualCount} order{totals.missingActualCount === 1 ? '' : 's'} use quoted estimate (no actual fee yet)
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-gray-900 text-white rounded-2xl p-5">
                <p className="text-sm font-medium text-gray-300">Total Uber Charges</p>
                <p className="text-4xl font-bold mt-1">{formatCurrency(totals.totalUberCharges)}</p>
                <p className="text-sm text-gray-300 mt-2">
                  ↳ incl. cancellation fees {formatCurrency(totals.cancellationFees)}
                </p>
                {totals.missingActualCount > 0 && (
                  <p className="text-xs text-amber-300 mt-2">
                    ⚠ {totals.missingActualCount} order{totals.missingActualCount === 1 ? '' : 's'} use quoted estimate (no actual fee yet)
                  </p>
                )}
              </div>
            )}

            {/* Secondary cards */}
            {isPlatform ? (
              <div className="grid grid-cols-2 gap-3">
                <Card title="UberDirect Orders" value={totals.orderCount} />
                <Card title="Total Charges" value={formatCurrency(totals.platformTotalCharges / 100)} />
                <Card title="Covered by Customer" value={formatCurrency(totals.platformCustomerCovered / 100)} />
                <Card title="You Covered" value={formatCurrency(totals.platformYouCovered / 100)} />
                <Card title="Variances" value={totals.platformVarianceCount} />
                <Card title="Variance Total" value={formatCurrency(totals.platformVarianceTotalCents / 100)} />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Card title="Delivery Sales" value={formatCurrency(totals.deliverySales)} sub={`${totals.orderCount} order${totals.orderCount === 1 ? '' : 's'}`} />
                <Card title="Customer-Paid Delivery Fees" value={formatCurrency(totals.customerDelivery)} />
                <Card title="Restaurant Out-of-Pocket" value={formatCurrency(totals.outOfPocket)} />
                <Card title="Net After Delivery Cost" value={formatCurrency(totals.net)} />
                <Card
                  title="Quoted ↔ Actual Variance"
                  value={`${totals.varianceCount} order${totals.varianceCount === 1 ? '' : 's'}`}
                  sub={`Σ |Δ| ${formatCurrency(totals.varianceAbs)}`}
                />
              </div>
            )}

            {/* Per-order drill-down */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2 mt-2">
                Orders
              </h3>
              <div className="space-y-1">
                {totals.rows.map(r => (
                  <div key={r.id} className="flex justify-between items-baseline text-sm border-b border-gray-100 py-2">
                    <div className="min-w-0">
                      <span className="font-semibold text-gray-900">#{r.orderNumber}</span>
                      <span className="text-gray-400 ml-2">{r.date}</span>
                      <span className={`ml-2 text-xs ${r.status === 'cancelled' ? 'text-red-600' : 'text-gray-500'}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="shrink-0 text-right text-gray-700">
                      {r.status === 'cancelled' ? (
                        <span>
                          {r.cancellationFee > 0
                            ? `cancel fee ${formatCurrency(r.cancellationFee)}`
                            : 'canceled — no fee'}
                        </span>
                      ) : (
                        <span>
                          paid {formatCurrency(r.customerPaid)}
                          {' · '}
                          Uber {r.uberActual != null ? formatCurrency(r.uberActual) : '—'}
                          {r.isEstimate && <span className="text-amber-600"> ~est</span>}
                          {' · '}
                          absorbed {formatCurrency(r.absorbed)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ title, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500">{title}</p>
      <p className="text-xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}
