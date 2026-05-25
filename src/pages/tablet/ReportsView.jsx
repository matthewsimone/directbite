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
// Returns the integer cents; caller divides by 100 once at the end.
function sumCentsInt(arr, getDollarsFn) {
  let cents = 0
  for (const item of arr) {
    cents += Math.round(Number(getDollarsFn(item)) * 100)
  }
  return cents
}

// "May 18 – May 25" for cross-day ranges, "May 25" for single-day. Year
// included only when start year differs from end year (covers Custom
// ranges spanning a year boundary).
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

export default function ReportsView({ restaurant, onBack }) {
  const initialKey = getNyDateKey(new Date())
  const [preset, setPreset] = useState('today')
  const [customStart, setCustomStart] = useState(initialKey)
  const [customEnd, setCustomEnd] = useState(initialKey)
  // Applied bounds only change when the user presses Apply; this prevents
  // a refetch on every keystroke in the date inputs.
  const [appliedCustomStart, setAppliedCustomStart] = useState(initialKey)
  const [appliedCustomEnd, setAppliedCustomEnd] = useState(initialKey)
  const [orders, setOrders] = useState([])
  const [adjustments, setAdjustments] = useState([])
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
    Promise.all([
      supabase
        .from('orders')
        .select('status, subtotal, tax_amount, tip_amount, delivery_fee, created_at')
        .eq('restaurant_id', restaurant.id)
        .gte('created_at', queryStartIso)
        .lte('created_at', queryEndIso),
      supabase
        .from('adjustment_requests')
        .select('type, amount, created_at')
        .eq('restaurant_id', restaurant.id)
        .eq('status', 'approved')
        .gte('created_at', queryStartIso)
        .lte('created_at', queryEndIso),
    ])
      .then(([oRes, aRes]) => {
        if (requestIdRef.current !== myId) return
        if (oRes.error) throw oRes.error
        if (aRes.error) throw aRes.error
        setOrders(oRes.data || [])
        setAdjustments(aRes.data || [])
        setLoading(false)
      })
      .catch(err => {
        if (requestIdRef.current !== myId) return
        console.error('[ReportsView] fetch failed', err)
        setError(err.message || 'Failed to load report')
        setLoading(false)
      })
  }, [restaurant?.id, queryStartIso, queryEndIso, retryCount])

  const totals = useMemo(() => {
    // Post-filter to the precise NY-day window. The query envelope is
    // intentionally wider (DST safety); getNyDateKey gives us the
    // trustworthy day membership check.
    const inRange = (createdAt) => {
      const key = getNyDateKey(new Date(createdAt))
      return key >= startKey && key <= endKey
    }
    const ordersInRange = orders.filter(o => inRange(o.created_at))
    const nonCancelled = ordersInRange.filter(o => o.status !== 'cancelled')
    const cancelled = ordersInRange.filter(o => o.status === 'cancelled')
    const adjInRange = adjustments.filter(a => inRange(a.created_at))
    const charges = adjInRange.filter(a => a.type === 'charge')
    const refunds = adjInRange.filter(a => a.type === 'refund')

    const salesCents = sumCentsInt(nonCancelled, o => o.subtotal)
    const tipsCents = sumCentsInt(nonCancelled, o => o.tip_amount)
    const deliveryCents = sumCentsInt(nonCancelled, o => o.delivery_fee)
    const taxCents = sumCentsInt(nonCancelled, o => o.tax_amount)
    const plusAdjCents = sumCentsInt(charges, a => a.amount)
    const minusAdjCents = sumCentsInt(refunds, a => a.amount)
    const grossCents = salesCents + tipsCents + deliveryCents + taxCents

    return {
      sales: salesCents / 100,
      tips: tipsCents / 100,
      delivery: deliveryCents / 100,
      tax: taxCents / 100,
      plusAdj: plusAdjCents / 100,
      minusAdj: minusAdjCents / 100,
      cancelCount: cancelled.length,
      orderCount: nonCancelled.length,
      gross: grossCents / 100,
    }
  }, [orders, adjustments, startKey, endKey])

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
        <h2 className="text-xl font-bold">Sales Report</h2>
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
        ) : (
          <div className="max-w-md mx-auto space-y-1">
            <Row label="Total Sales" value={formatCurrency(totals.sales)} />
            <Row label="Total Tips Collected" value={formatCurrency(totals.tips)} />
            <Row label="Total Delivery Charges Collected" value={formatCurrency(totals.delivery)} />
            <Row label="Total Tax Collected" value={formatCurrency(totals.tax)} />
            <Row label="Total + Adjustments" value={formatCurrency(totals.plusAdj)} />
            <Row label="Total − Adjustments" value={formatCurrency(totals.minusAdj)} />
            <Row label="Cancel Order Count" value={String(totals.cancelCount)} />
            <Row label="Total Order Count" value={String(totals.orderCount)} />
            <div className="border-t border-gray-300 pt-4 mt-4 flex justify-between items-baseline">
              <span className="text-lg font-bold">Gross Total</span>
              <span className="text-2xl font-bold">{formatCurrency(totals.gross)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between text-base py-1">
      <span className="text-gray-600">{label}</span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  )
}
