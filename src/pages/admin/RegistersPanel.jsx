import { useState, useEffect, useCallback } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../../lib/supabase'

// Admin "POS registers" section (ordr-pos DEVICE-AUTH §6). Everything goes
// through the pos-admin-devices edge function with the admin's JWT; no table
// access from the browser. An enrollment code is shown ONCE: it lives only in
// this component's state while the modal is open — never logged, never
// persisted — and is dropped when the modal closes.

async function callPosAdmin(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  let res
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/pos-admin-devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ action, ...payload }),
    })
  } catch {
    return { ok: false, status: 0, error: { code: 'network_error', message: 'Could not reach the server.' } }
  }
  const body = await res.json().catch(() => null)
  if (res.ok && body && !body.error) return { ok: true, status: res.status, body }
  return {
    ok: false,
    status: res.status,
    error: body?.error ?? { code: `http_${res.status}`, message: 'Unexpected response from the server.' },
  }
}

function describeError(r) {
  if (r.status === 401 || r.status === 403) return 'Admin session expired — sign out and sign in again.'
  return `${r.error?.code ?? 'error'}: ${r.error?.message ?? 'unknown error'}`
}

function relative(iso) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function age(seconds) {
  if (seconds == null) return '—'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

// The function returns full IPs; show a masked form (IPv4 /24, IPv6 first 3 groups).
function maskIp(ip) {
  if (!ip) return '—'
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.x'
  return ip.split(':').slice(0, 3).join(':') + ':…'
}

function StatusPill({ status }) {
  const active = status === 'active'
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>
      {status}
    </span>
  )
}

// Shows the one-time code BIG + its QR + a live countdown. Closing drops it.
function CodeModal({ code, onClose }) {
  const [qr, setQr] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    QRCode.toDataURL(code.qr, { width: 240, margin: 1 }).then(url => { if (alive) setQr(url) }).catch(() => { if (alive) setQr(null) })
    return () => { alive = false }
  }, [code.qr])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const left = Math.max(0, Math.floor((Date.parse(code.expires_at) - now) / 1000))
  const expired = left === 0
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-4 text-center">
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {code.reenroll ? 'Re-enroll register' : 'New register'} · prefix {code.prefix}
          </p>
          <p className="text-sm text-gray-700 mt-1">{code.label}</p>
        </div>
        <p className={`font-mono font-bold tracking-widest select-all ${expired ? 'text-gray-300 line-through' : 'text-gray-900'}`} style={{ fontSize: '2.25rem' }}>
          {code.code}
        </p>
        {qr && !expired && <img src={qr} alt="Enrollment QR code" className="mx-auto w-60 h-60" />}
        <p className={`text-sm font-semibold ${expired ? 'text-red-600' : left < 300 ? 'text-amber-600' : 'text-gray-600'}`}>
          {expired ? 'Expired — create a new code' : `Expires in ${mm}:${ss}`}
        </p>
        <p className="text-xs text-amber-800 bg-amber-50 rounded-lg p-2">
          Shown once. Closing this hides the code. Enter it (or scan the QR) on the register.
        </p>
        <button type="button" onClick={onClose} className="w-full h-10 rounded-lg bg-gray-900 text-white text-sm font-semibold">
          Close
        </button>
      </div>
    </div>
  )
}

function RevokeModal({ device, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit() {
    if (!reason.trim()) return
    setBusy(true); setError(null)
    const r = await callPosAdmin('revoke', { device_id: device.device_id, restaurant_id: device.restaurant_id, reason: reason.trim() })
    setBusy(false)
    if (!r.ok) { setError(describeError(r)); return }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3">
        <h3 className="font-bold text-lg">Revoke register {device.prefix}?</h3>
        <p className="text-sm text-gray-600">
          “{device.label}” stops syncing at once and locks new orders. It can only come back with a Re-enroll code.
        </p>
        <label className="block text-sm font-medium text-gray-700">
          Reason (required)
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            placeholder="e.g. tablet stolen, replaced hardware"
          />
        </label>
        {error && <p className="text-xs text-red-700 bg-red-50 rounded p-2 break-words">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="flex-1 h-10 rounded-lg border border-gray-300 text-sm font-semibold">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy || !reason.trim()} className="flex-1 h-10 rounded-lg bg-red-600 text-white text-sm font-semibold disabled:opacity-50">
            {busy ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function RegistersPanel({ restaurant }) {
  const [devices, setDevices] = useState(null)
  const [lockedIps, setLockedIps] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [label, setLabel] = useState('')
  const [code, setCode] = useState(null) // { code, qr, prefix, label, expires_at, reenroll } — never persisted
  const [revoking, setRevoking] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const [list, locked] = await Promise.all([
      callPosAdmin('list', { restaurant_id: restaurant.id }),
      callPosAdmin('locked_ips'),
    ])
    if (!list.ok) { setError(describeError(list)); setDevices([]); return }
    setDevices(list.body.devices ?? [])
    setLockedIps(locked.ok ? (locked.body.locked_ips ?? []) : [])
  }, [restaurant.id])

  useEffect(() => {
    setDevices(null); setLockedIps([]); setCode(null); setRevoking(null); setLabel('')
    load()
  }, [load])

  async function createCode(key, action, payload) {
    setBusy(key); setError(null)
    try {
      const r = await callPosAdmin(action, { restaurant_id: restaurant.id, ...payload })
      if (!r.ok) { setError(describeError(r)); return }
      const b = r.body
      setCode({ code: b.code, qr: b.qr, prefix: b.prefix, label: b.label, expires_at: b.expires_at, reenroll: !!b.reenroll_device_id })
      setLabel('')
    } finally {
      setBusy(null)
    }
  }

  function closeCode() {
    setCode(null)
    load()
  }

  const btn = 'h-8 px-3 rounded-lg border text-xs font-semibold disabled:opacity-50'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">POS registers</h4>
        <button type="button" onClick={load} disabled={!!busy} className="text-xs font-semibold text-gray-500 hover:text-gray-700">
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-red-700 bg-red-50 rounded p-2 break-words">{error}</p>}

      <div className="flex gap-2">
        <input
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          maxLength={60}
          placeholder="Label, e.g. Front counter"
          className="flex-1 h-8 border border-gray-300 rounded-lg px-2 text-sm"
        />
        <button
          type="button"
          className={`${btn} border-[#16A34A] text-[#16A34A]`}
          disabled={!!busy}
          onClick={() => createCode('add', 'create_enrollment', { label: label.trim() || undefined })}
        >
          {busy === 'add' ? 'Creating…' : 'Add register'}
        </button>
      </div>

      {devices === null ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-xs text-gray-400">No registers yet.</p>
      ) : (
        <ul className="space-y-2">
          {devices.map(d => (
            <li key={d.device_id} className="border border-gray-200 rounded-lg p-2 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-sm w-7">{d.prefix}</span>
                <span className="font-semibold text-sm flex-1 truncate">{d.label}</span>
                <StatusPill status={d.status} />
              </div>
              <p className="text-gray-600">
                {d.hardware_model || 'unknown model'} · app {d.app_version || '—'} · seen {relative(d.last_seen_at)} · token {age(d.token_age_seconds)}
              </p>
              {d.status === 'revoked' && d.revoked_reason && (
                <p className="text-red-700">Revoked {relative(d.revoked_at)}: {d.revoked_reason}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className={`${btn} border-gray-300`}
                  disabled={!!busy}
                  onClick={() => createCode(`re-${d.device_id}`, 'create_reenrollment', { device_id: d.device_id })}
                >
                  {busy === `re-${d.device_id}` ? 'Creating…' : 'Re-enroll'}
                </button>
                {d.status === 'active' && (
                  <button
                    type="button"
                    className={`${btn} border-red-300 text-red-600`}
                    disabled={!!busy}
                    onClick={() => setRevoking({ ...d, restaurant_id: restaurant.id })}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {lockedIps.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Locked IPs (registration)</p>
          <ul className="text-xs text-gray-600 space-y-0.5">
            {lockedIps.map(l => (
              <li key={l.ip}>
                {maskIp(l.ip)} · {l.failures_15m} in 15 min / {l.failures_24h} in 24 h · unlocks in {Math.ceil(l.retry_after_seconds / 60)} min
              </li>
            ))}
          </ul>
        </div>
      )}

      {code && <CodeModal code={code} onClose={closeCode} />}
      {revoking && (
        <RevokeModal
          device={revoking}
          onCancel={() => setRevoking(null)}
          onDone={() => { setRevoking(null); load() }}
        />
      )}
    </div>
  )
}
