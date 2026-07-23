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

// cents → "$X.XX"
const fmt = (cents) => formatCurrency((cents || 0) / 100)

// Sign-aware cost: a positive cost is money out (−), a negative cost is a gain.
function signedCost(cents) {
  if (cents > 0) return `−${fmt(cents)}`
  if (cents < 0) return `+${fmt(Math.abs(cents))} in your favor`
  return fmt(0)
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
  const fmtr = new Intl.DateTimeFormat('en-US', opts)
  const sDate = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0))
  const eDate = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0))
  if (startKey === endKey) return fmtr.format(sDate)
  return `${fmtr.format(sDate)} – ${fmtr.format(eDate)}`
}

// Format a Stripe unix-seconds timestamp as an NY date (payout arrival dates,
// per-payout sales windows, and charge created times all arrive as unix secs).
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
  const [view, setView] = useState('activity') // 'activity' | 'payouts'
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

      {/* View toggle — Activity first, Payouts second */}
      {!loading && !error && data && (
        <div className="shrink-0 px-4 pt-4">
          <div className="inline-flex p-1 bg-gray-100 rounded-xl">
            <button
              onClick={() => setView('activity')}
              className={`px-5 h-9 rounded-lg text-sm font-semibold transition-colors ${
                view === 'activity' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'
              }`}
            >
              Activity
            </button>
            <button
              onClick={() => setView('payouts')}
              className={`px-5 h-9 rounded-lg text-sm font-semibold transition-colors ${
                view === 'payouts' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'
              }`}
            >
              Payouts
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
        ) : !data ? null : view === 'activity' ? (
          <ActivityView data={data} detailOpen={detailOpen} setDetailOpen={setDetailOpen} />
        ) : (
          <PayoutsView data={data} />
        )}
      </div>
    </div>
  )
}

// ===== ACTIVITY VIEW — "all charges in this date range" =====
function ActivityView({ data, detailOpen, setDetailOpen }) {
  const a = data.activity || {}
  const b = data.breakdown || {}
  const charges = data.charges || []
  const collected =
    (b.food_cents || 0) + (b.tax_cents || 0) + (b.tips_cents || 0) + (b.delivery_cents || 0)

  return (
    <div className="max-w-md mx-auto space-y-6">
      {/* SALES */}
      <section>
        <SectionLabel>Sales (what customers ordered)</SectionLabel>
        <StatementRow label="Food" value={fmt(b.food_cents)} />
        <StatementRow label="Tax" value={fmt(b.tax_cents)} />
        <StatementRow label="Tips" value={fmt(b.tips_cents)} />
        <StatementRow label="Delivery Charges" value={fmt(b.delivery_cents)} />
        <SubtotalRow label="Collected from customers" value={fmt(collected)} />
        <StatementRow
          label="DirectBite (added at checkout)"
          value={`+${fmt(a.directbite_fees)}`}
          muted
        />
        {(b.recoup_cents || 0) > 0 && (
          <StatementRow
            label={b.recoup_rate
              ? `Service Fee Recoup (${String(Number((b.recoup_rate * 100).toFixed(4)))}%)`
              : 'Service Fee Recoup'}
            value={`+${fmt(b.recoup_cents)}`}
            muted
          />
        )}
        <SubtotalRow label="Gross Charged" value={fmt(a.gross_charged)} />
      </section>

      {/* FEES & REFUNDS */}
      <section>
        <SectionLabel>Fees &amp; Refunds</SectionLabel>
        <StatementRow
          label="Stripe Processing (actual)"
          value={`−${fmt(a.stripe_fees_actual)}`}
          muted
        />
        <StatementRow
          label={`Refunds (${a.refund_count || 0})`}
          value={fmt(a.refunds_amount)}
          muted
        />
        <div className="border-t border-gray-300 pt-4 mt-4 flex justify-between items-baseline">
          <span className="text-lg font-bold">Net Activity</span>
          <span className="text-2xl font-bold">{fmt(a.net_activity)}</span>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Money from orders in this range. Deposits settle later — see Payouts for exact
          bank deposits.
        </p>
      </section>

      {/* 3RD-PARTY DELIVERY — only when there were Uber Direct orders */}
      {b.ud_count > 0 && (
        <section>
          <SectionLabel>3rd-Party Delivery (Uber Direct)</SectionLabel>
          <StatementRow label="Deliveries" value={String(b.ud_count)} />
          <StatementRow label="Uber Charged" value={`−${fmt(b.ud_uber_charged_cents)}`} muted />
          <StatementRow label="Covered by customer" value={`+${fmt(b.ud_customer_paid_cents)}`} muted />
          <SubtotalRow label="Your net delivery cost" value={signedCost(b.ud_net_cost_cents)} />
          <StatementRow label="Tips to drivers (paid through Uber)" value={fmt(b.ud_tips_to_driver_cents)} muted />
          {b.ud_tip_kept_cents > 0 && (
            <StatementRow label="Tips kept (over $5 cap)" value={`+${fmt(b.ud_tip_kept_cents)}`} muted />
          )}
        </section>
      )}

      {/* ORDERS */}
      <section>
        <SectionLabel>Orders</SectionLabel>
        <StatementRow label="Completed" value={String(b.completed_count || 0)} />
        <StatementRow label="Cancelled" value={String(b.cancelled_count || 0)} />
      </section>

      {/* Transaction detail (collapsible) */}
      <div>
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
                  // Strip Stripe's 30¢ flat fee, then flag only orders ≥ $15
                  // whose true rate exceeds ~3.5% (a normal 2.9% card — incl.
                  // small test orders — must NOT flag).
                  const highFee = c.gross >= 1500 && (c.stripe_fee - 30) / c.gross > 0.035
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
                      <td className="py-2 px-2 text-right">{fmt(c.gross)}</td>
                      <td className="py-2 px-2 text-right text-gray-500">−{fmt(c.stripe_fee)}</td>
                      <td className="py-2 px-2 text-right text-gray-500">−{fmt(c.app_fee)}</td>
                      <td className="py-2 px-2 text-right font-medium">{fmt(c.net)}</td>
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

// ===== PAYOUTS VIEW — "what hit your bank" =====
function PayoutsView({ data }) {
  const groups = data.payout_groups || []
  const pending = data.pending || { pending_count: 0, pending_net: 0 }

  return (
    <div className="max-w-md mx-auto space-y-3">
      {groups.length === 0 && (
        <p className="text-center text-gray-400 py-8">No payouts settled in this range.</p>
      )}

      {groups.map(g => (
        <div key={g.payout_id} className="border border-gray-200 rounded-xl p-4">
          <p className="text-2xl font-bold text-gray-900">{fmt(g.payout_amount)}</p>
          <p className="mt-1 text-sm text-gray-500">Deposited {formatUnixDay(g.deposited)}</p>
          <p className="text-sm text-gray-500">
            Sales from {formatUnixDay(g.sales_start)} – {formatUnixDay(g.sales_end)}
          </p>
          <p className="text-sm text-gray-500">{g.count} orders</p>
        </div>
      ))}

      {pending.pending_count > 0 && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
          <p className="text-sm font-semibold text-gray-700">Not yet deposited</p>
          <p className="mt-1 text-lg font-bold text-gray-900">
            {pending.pending_count} {pending.pending_count === 1 ? 'order' : 'orders'} ·{' '}
            {fmt(pending.pending_net)}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Charged in this range but still settling — these land in an upcoming deposit.
          </p>
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{children}</p>
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

function SubtotalRow({ label, value }) {
  return (
    <div className="flex justify-between text-base py-2 mt-1 border-t border-gray-200">
      <span className="font-semibold text-gray-900">{label}</span>
      <span className="font-bold text-gray-900">{value}</span>
    </div>
  )
}
