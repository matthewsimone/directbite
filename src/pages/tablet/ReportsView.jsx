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

// Format a Stripe unix-seconds timestamp as an NY date (payout arrival dates
// and charge created times both arrive as unix seconds from the function).
function formatUnixDay(unixSeconds, withTime = false) {
  if (unixSeconds == null) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(new Date(unixSeconds * 1000))
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
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const [view, setView] = useState('payouts') // 'payouts' | 'activity'
  const [detailOpen, setDetailOpen] = useState(false)
  const requestIdRef = useRef(0)

  // Resolve the picker selection to NY date keys (YYYY-MM-DD). These are what
  // the edge function expects for start/end.
  const { startKey, endKey } = useMemo(
    () => getRangeForPreset(preset, {
      customStart: appliedCustomStart,
      customEnd: appliedCustomEnd,
    }),
    [preset, appliedCustomStart, appliedCustomEnd]
  )

  // Fetch settlement data from the edge function whenever the applied range
  // changes (preset click or custom Apply) or on retry.
  useEffect(() => {
    if (!restaurant?.id) return
    const myId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const { data: { session }, error: refreshError } = await supabase.auth.refreshSession()
        if (refreshError || !session) {
          throw new Error('Session expired — please log in again.')
        }
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-settlement-report`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              restaurant_id: restaurant.id,
              start: startKey,
              end: endKey,
            }),
          }
        )
        const json = await res.json()
        if (requestIdRef.current !== myId) return
        if (!res.ok) throw new Error(json.error || 'Failed to load report')
        setData(json)
        setLoading(false)
      } catch (err) {
        if (requestIdRef.current !== myId) return
        console.error('[ReportsView] settlement fetch failed', err)
        setError(err.message || 'Failed to load report')
        setLoading(false)
      }
    })()
  }, [restaurant?.id, startKey, endKey, retryCount])

  const customInvalid = preset === 'custom' && customStart > customEnd

  function applyCustom() {
    if (customInvalid) return
    setAppliedCustomStart(customStart)
    setAppliedCustomEnd(customEnd)
  }

  // Payout id → payout meta (arrival_date, status) for the payout cards.
  const payoutById = useMemo(() => {
    const map = {}
    for (const p of data?.payouts || []) map[p.id] = p
    return map
  }, [data])

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

      {/* View toggle */}
      {!loading && !error && data && (
        <div className="shrink-0 px-4 pt-4">
          <div className="inline-flex p-1 bg-gray-100 rounded-xl">
            <button
              onClick={() => setView('payouts')}
              className={`px-5 h-9 rounded-lg text-sm font-semibold transition-colors ${
                view === 'payouts' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'
              }`}
            >
              Payouts
            </button>
            <button
              onClick={() => setView('activity')}
              className={`px-5 h-9 rounded-lg text-sm font-semibold transition-colors ${
                view === 'activity' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'
              }`}
            >
              Activity
            </button>
          </div>
        </div>
      )}

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
        ) : !data ? null : view === 'payouts' ? (
          <PayoutsView data={data} payoutById={payoutById} />
        ) : (
          <ActivityView data={data} detailOpen={detailOpen} setDetailOpen={setDetailOpen} />
        )}
      </div>
    </div>
  )
}

// ===== PAYOUTS VIEW — "what hit your bank" =====
function PayoutsView({ data, payoutById }) {
  const groups = data.payout_groups || []
  const pending = data.pending || { pending_count: 0, pending_net: 0 }

  return (
    <div className="max-w-md mx-auto space-y-3">
      {groups.length === 0 && (
        <p className="text-center text-gray-400 py-8">No payouts settled in this range.</p>
      )}

      {groups.map(g => {
        const meta = payoutById[g.payout_id]
        return (
          <div key={g.payout_id} className="border border-gray-200 rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-2xl font-bold text-gray-900">
                  {formatCurrency(g.payout_amount / 100)}
                </p>
                <p className="mt-1 text-sm text-gray-500">
                  Arrives {formatUnixDay(meta?.arrival_date)}
                  {meta?.status && meta.status !== 'paid' ? ` · ${meta.status}` : ''}
                </p>
                <p className="text-sm text-gray-500">{g.count} transactions</p>
              </div>
              {g.ties ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 px-2 py-1 rounded-full">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  Reconciled
                </span>
              ) : (
                <span className="shrink-0 inline-flex items-center text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-1 rounded-full">
                  Partial (boundary)
                </span>
              )}
            </div>
          </div>
        )
      })}

      {pending.pending_count > 0 && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
          <p className="text-sm font-semibold text-gray-700">Settling into your next payout</p>
          <p className="mt-1 text-lg font-bold text-gray-900">
            {pending.pending_count} {pending.pending_count === 1 ? 'order' : 'orders'} ·{' '}
            {formatCurrency(pending.pending_net / 100)}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            These have been charged but haven't settled to your bank yet.
          </p>
        </div>
      )}
    </div>
  )
}

// ===== ACTIVITY VIEW — "all charges in this date range" =====
function ActivityView({ data, detailOpen, setDetailOpen }) {
  const a = data.activity || {}
  const charges = data.charges || []

  return (
    <div className="max-w-md mx-auto">
      {/* Statement */}
      <div className="space-y-1">
        <StatementRow label="Gross Charged (customers paid)" value={formatCurrency((a.gross_charged || 0) / 100)} />
        <StatementRow
          label="Stripe Processing Fees (actual)"
          value={`−${formatCurrency((a.stripe_fees_actual || 0) / 100)}`}
          muted
        />
        <StatementRow
          label="DirectBite Service Fee"
          value={`−${formatCurrency((a.directbite_fees || 0) / 100)}`}
          muted
        />
        <StatementRow
          label={`Refunds (${a.refund_count || 0})`}
          value={formatCurrency((a.refunds_amount || 0) / 100)}
          muted
        />
        <div className="border-t border-gray-300 pt-4 mt-4 flex justify-between items-baseline">
          <span className="text-lg font-bold">Net Activity</span>
          <span className="text-2xl font-bold">{formatCurrency((a.net_activity || 0) / 100)}</span>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Net Activity = what will be deposited for charges in this range. Deposits settle
          ~2 days after each order, so a range's net may span more than one bank payout —
          see the Payouts tab for exact deposits.
        </p>
      </div>

      {/* Transaction detail (collapsible) */}
      <div className="mt-6">
        <button
          onClick={() => setDetailOpen(o => !o)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-700"
        >
          <svg
            className={`w-4 h-4 transition-transform ${detailOpen ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Transaction detail ({charges.length})
        </button>

        {detailOpen && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-200">
                  <th className="py-2 pr-2 font-medium">Charge</th>
                  <th className="py-2 px-2 font-medium text-right">Gross</th>
                  <th className="py-2 px-2 font-medium text-right">Stripe</th>
                  <th className="py-2 px-2 font-medium text-right">Service</th>
                  <th className="py-2 px-2 font-medium text-right">Net</th>
                  <th className="py-2 px-2 font-medium">Date</th>
                  <th className="py-2 pl-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {charges.map(c => {
                  const highFee = c.gross > 0 && c.stripe_fee / c.gross > 0.04
                  return (
                    <tr key={c.charge_id} className="border-b border-gray-100">
                      <td className="py-2 pr-2 font-mono text-gray-600">
                        …{String(c.charge_id).slice(-8)}
                        {highFee && (
                          <span className="ml-1 inline-block text-[10px] font-semibold text-amber-700 bg-amber-50 px-1 py-0.5 rounded">
                            foreign/premium card
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right">{formatCurrency(c.gross / 100)}</td>
                      <td className="py-2 px-2 text-right text-gray-500">−{formatCurrency(c.stripe_fee / 100)}</td>
                      <td className="py-2 px-2 text-right text-gray-500">−{formatCurrency(c.app_fee / 100)}</td>
                      <td className="py-2 px-2 text-right font-medium">{formatCurrency(c.net / 100)}</td>
                      <td className="py-2 px-2 whitespace-nowrap text-gray-600">{formatUnixDay(c.created)}</td>
                      <td className="py-2 pl-2 text-gray-600">{c.status}</td>
                    </tr>
                  )
                })}
                {charges.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-gray-400">
                      No charges in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function StatementRow({ label, value, muted }) {
  return (
    <div className="flex justify-between text-base py-1">
      <span className="text-gray-600">{label}</span>
      <span className={`font-medium ${muted ? 'text-gray-500' : 'text-gray-900'}`}>{value}</span>
    </div>
  )
}
