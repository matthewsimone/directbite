import { providerDisplay } from './dspProvider.js'

// Severity of a dsp_provider_status row for the tablet banner.
//   critical: integration disabled/rejected; offline with no reason, a
//             system/provider pause, or an unrecognised reason (safe direction)
//   info:     integration still being set up (in_progress / waiting /
//             waiting_menu); offline with a merchant/manual pause reason
//   ok:       everything else (online, no data)
// System keywords are checked before manual ones, so "paused by system" is
// critical even though it also contains "paused by".
// Reasons are normalized first (lowercase, underscores → spaces) so
// KitchenHub's enum-style values match too: real values seen include
// "PAUSED_BY_RESTAURANT", "Store is closed" and
// "Manually stopped taking orders at 2:31 PM" (all manual → info).
const CRITICAL_CONNECTION = new Set(['disabled', 'rejected'])
const CONNECTING = new Set(['in_progress', 'waiting', 'waiting_menu'])
const SYSTEM_PAUSE = /expired|cancel|system|deactivat|fail/
const MANUAL_PAUSE = /paused by|manual|merchant|busy|paused by restaurant|store is closed|stopped taking orders/

function normalizeReason(reason) {
  return String(reason || '').toLowerCase().replace(/_/g, ' ').trim()
}

function connectionOf(row) {
  return String(row?.connection_status || '').toLowerCase()
}

export function providerSeverity(row) {
  if (!row) return 'ok'
  const connection = connectionOf(row)
  if (CRITICAL_CONNECTION.has(connection)) return 'critical'
  if (CONNECTING.has(connection)) return 'info'
  if (row.online_status === 'offline') {
    const reason = normalizeReason(row.reason)
    if (!reason || SYSTEM_PAUSE.test(reason)) return 'critical'
    if (MANUAL_PAUSE.test(reason)) return 'info'
    return 'critical'
  }
  return 'ok'
}

function formatClock(ms) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms))
}

export function providerBannerText(row, now = Date.now()) {
  const label = providerDisplay(row).label
  const connection = connectionOf(row)
  if (CRITICAL_CONNECTION.has(connection)) {
    return `${label} DISCONNECTED — orders are not coming in. Contact Ordr support.`
  }
  if (CONNECTING.has(connection)) {
    return `${label} CONNECTING — setup in progress.`
  }
  const untilMs = row.pause_until ? new Date(row.pause_until).getTime() : NaN
  const until = Number.isFinite(untilMs) && untilMs > now ? ` — paused until ${formatClock(untilMs)}` : ''
  const reason = row.reason ? `: ${row.reason}` : ''
  const tail = !until && providerSeverity(row) === 'critical' ? ' — orders are not coming in.' : ''
  return `${label} OFFLINE${until}${reason}${tail}`
}
