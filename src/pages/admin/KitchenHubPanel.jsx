import { useState, useEffect, useCallback } from 'react'
import QRCode from 'qrcode'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'

// Admin "Delivery apps (KitchenHub)" section. Everything goes through the
// kh-admin edge function; every destructive action has a confirm step.
// provider_ids are KitchenHub's; list_providers returns the canonical list.
const PROVIDERS = [
  { id: 'doordash', label: 'DoorDash' },
  { id: 'ubereats', label: 'Uber Eats' },
  { id: 'grubhub', label: 'Grubhub' },
]
const PAUSE_OPTIONS = [
  [15 * 60, '15 min'],
  [30 * 60, '30 min'],
  [60 * 60, '1 hour'],
  ['', 'Until resumed'],
]

async function callKhAdmin(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kh-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  })
  return res.json().catch(() => ({ ok: false, error: 'bad_response', http: res.status }))
}

function describeError(r) {
  const kh = r?.kitchenhub == null ? '' : ` · ${typeof r.kitchenhub === 'string' ? r.kitchenhub : JSON.stringify(r.kitchenhub)}`
  return `${r?.error || 'error'}${r?.step ? ` (${r.step})` : ''}${r?.http ? ` · HTTP ${r.http}` : ''}${r?.detail ? ` · ${r.detail}` : ''}${kh}`
}

const isNotFound = err => err?.http === 404

// Read-only browser of every KitchenHub location on the account (checklist:
// list locations, list stores in a location). Closed by default.
function AllLocations({ ownLocationId }) {
  const [open, setOpen] = useState(false)
  const [locations, setLocations] = useState(null)
  const [stores, setStores] = useState({}) // location id → 'loading' | array | { error }
  const [error, setError] = useState(null)

  async function toggle() {
    if (open) { setOpen(false); return }
    setOpen(true); setError(null); setLocations(null); setStores({})
    const r = await callKhAdmin('list_locations')
    if (!r.ok) setError(describeError(r))
    else setLocations(r.locations || [])
  }

  async function showStores(id) {
    setStores(s => ({ ...s, [id]: 'loading' }))
    const r = await callKhAdmin('list_stores', { location_id: id })
    setStores(s => ({ ...s, [id]: r.ok ? (r.stores || []) : { error: describeError(r) } }))
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={toggle} className="text-xs font-semibold text-gray-500 hover:text-gray-700">
        {open ? 'Hide all KitchenHub locations' : 'Show all KitchenHub locations'}
      </button>
      {open && (
        <div className="space-y-2">
          {error && <p className="text-xs text-red-700 bg-red-50 rounded p-2 break-words">{error}</p>}
          {!error && locations === null && <p className="text-xs text-gray-400">Loading…</p>}
          {locations?.length === 0 && <p className="text-xs text-gray-400">No locations</p>}
          {locations?.map(l => {
            const s = stores[l.id]
            return (
              <div key={l.id} className="border border-gray-200 rounded-lg p-2 text-xs space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{l.location_name}</span>
                  {l.id === ownLocationId && (
                    <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800 font-semibold">this restaurant</span>
                  )}
                </div>
                <p className="text-gray-600">
                  {[l.location_street, l.location_city, l.location_state, l.location_zipcode].filter(Boolean).join(', ')}
                </p>
                <p className="text-gray-400 break-all">id {l.id} · {l.location_status || 'status —'}</p>
                {s === undefined ? (
                  <button type="button" onClick={() => showStores(l.id)} className="font-semibold text-gray-500 hover:text-gray-700">
                    Show stores
                  </button>
                ) : s === 'loading' ? (
                  <p className="text-gray-400">Loading stores…</p>
                ) : s.error ? (
                  <p className="text-red-700 break-words">{s.error}</p>
                ) : s.length === 0 ? (
                  <p className="text-gray-400">No stores</p>
                ) : (
                  <ul className="pl-3 space-y-0.5">
                    {s.map(st => (
                      <li key={st.id} className="break-all">{st.name || st.store_name} <span className="text-gray-400">· {st.id}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Pill({ value, good }) {
  if (!value) return <span className="text-xs text-gray-400">—</span>
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${value === good ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
      {value}
    </span>
  )
}

export default function KitchenHubPanel({ restaurant }) {
  const [info, setInfo] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [confirm, setConfirm] = useState(null) // { text, run }
  const [connect, setConnect] = useState(null) // { label, url, qr }
  const [pauseFor, setPauseFor] = useState(30 * 60)

  const load = useCallback(async () => {
    setError(null)
    const r = await callKhAdmin('get', { restaurant_id: restaurant.id })
    if (!r.ok) { setError(describeError(r)); return }
    setInfo(r)
    if (r.provisioned) {
      const p = await callKhAdmin('list_providers', { restaurant_id: restaurant.id })
      if (p.ok) setAccounts(p.accounts || [])
      else setError(describeError(p))
    } else {
      setAccounts([])
      setConnect(null)
    }
  }, [restaurant.id])

  useEffect(() => {
    setInfo(null); setAccounts([]); setConnect(null); setConfirm(null)
    load()
  }, [load])

  // Any action closes an open connect box (startConnect reopens it with the
  // new link after its own run completes).
  async function run(key, action, payload = {}) {
    setBusy(key); setError(null); setConnect(null)
    try {
      const r = await callKhAdmin(action, { restaurant_id: restaurant.id, ...payload })
      if (!r.ok) setError(describeError(r))
      else await load()
      return r
    } finally {
      setBusy(null)
    }
  }

  async function startConnect(p) {
    const r = await run(`connect-${p.id}`, 'connect_provider', { provider_id: p.id })
    if (r?.ok && r.url) {
      const qr = await QRCode.toDataURL(r.url, { width: 220, margin: 1 }).catch(() => null)
      setConnect({ label: p.label, url: r.url, qr })
    }
  }

  const ask = (text, fn) => setConfirm({ text, run: fn })
  const btn = 'h-8 px-3 rounded-lg border text-xs font-semibold disabled:opacity-50'
  // "On" only when both flags agree; a mismatch shows OFF and the toggle sets both.
  const ordersOn = info?.provisioned && info.mapping?.enabled === true && info.dsp_orders_enabled === true
  const flagsMismatch = info?.provisioned && (info.mapping?.enabled === true) !== (info.dsp_orders_enabled === true)

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Delivery apps (KitchenHub)</h4>
      {error && <p className="text-xs text-red-700 bg-red-50 rounded p-2 break-words">{error}</p>}

      {!info ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : !info.provisioned ? (
        <button
          onClick={() => run('provision', 'provision')}
          disabled={!!busy}
          className="w-full h-9 rounded-lg bg-[#16A34A] text-white text-sm font-semibold disabled:opacity-50"
        >
          {busy === 'provision' ? 'Enabling…' : 'Enable delivery apps'}
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => ask(
              ordersOn
                ? 'Turning OFF stops DSP orders appearing on the tablet — do this outside service hours.'
                : 'Turn ON DSP orders on the tablet? Delivery-app orders will chime, show and print on this restaurant’s tablet.',
              () => run('set-enabled', 'set_enabled', { enabled: !ordersOn })
            )}
            className={`w-full h-9 rounded-lg text-sm font-semibold border transition-colors disabled:opacity-50 ${
              ordersOn
                ? 'bg-[#16A34A] text-white border-[#16A34A] hover:bg-[#15803D]'
                : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {busy === 'set-enabled' ? 'Saving…' : `Orders on tablet: ${ordersOn ? 'ON' : 'OFF'}`}
          </button>
          {flagsMismatch && (
            <p className="text-xs text-amber-700">Routing and tablet flags differ; toggling sets both.</p>
          )}

          <div className="text-sm space-y-1 bg-gray-50 rounded-lg p-3">
            <p className="font-semibold">Location</p>
            {info.location ? (
              <>
                <p>{info.location.location_name}</p>
                <p className="text-gray-600">
                  {[info.location.location_street, info.location.location_city, info.location.location_state, info.location.location_zipcode].filter(Boolean).join(', ')}
                </p>
                <p className="text-xs text-gray-400 break-all">id {info.location.id} · {info.location.location_status || 'status —'}</p>
              </>
            ) : isNotFound(info.location_error) ? (
              <p className="text-xs text-gray-500">No location (deleted)</p>
            ) : (
              <p className="text-xs text-red-600 break-words">{info.location_error ? JSON.stringify(info.location_error) : 'not found'}</p>
            )}
            <p className="font-semibold pt-2">Store</p>
            {info.store ? (
              <>
                <p>{info.store.store_name}</p>
                <p className="text-xs text-gray-400 break-all">id {info.store.id} · routing {info.mapping?.enabled ? 'enabled' : 'disabled'}</p>
              </>
            ) : isNotFound(info.store_error) ? (
              <p className="text-xs text-gray-500">No store (deleted)</p>
            ) : (
              <p className="text-xs text-red-600 break-words">{info.store_error ? JSON.stringify(info.store_error) : 'not found'}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button className={`${btn} border-gray-300`} disabled={!!busy} onClick={() => run('sync', 'update_location')}>
              {busy === 'sync' ? 'Syncing…' : 'Sync name & address'}
            </button>
            <button className={`${btn} border-red-300 text-red-600`} disabled={!!busy || !info.store}
              onClick={() => ask('Delete the KitchenHub store? Connected providers stop sending orders.', () => run('delete-store', 'delete_store'))}>
              Delete store
            </button>
            <button className={`${btn} border-red-300 text-red-600`} disabled={!!busy || !!info.store}
              onClick={() => ask('Delete the KitchenHub location and our mapping?', () => run('delete-location', 'delete_location'))}>
              Delete location
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Providers</p>
              <label className="text-xs text-gray-500 flex items-center gap-1">
                Pause for
                <select value={pauseFor} onChange={e => setPauseFor(e.target.value === '' ? '' : Number(e.target.value))}
                  className="border border-gray-300 rounded px-1 py-0.5 text-xs">
                  {PAUSE_OPTIONS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            {PROVIDERS.map(p => {
              const acct = accounts.find(a => a.provider_id === p.id)
              const connected = acct?.connection === 'connected'
              const id = acct?.integration_account_id
              return (
                <div key={p.id} className="border border-gray-200 rounded-lg p-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{p.label}</span>
                    <span className="flex gap-1">
                      <Pill value={acct?.connection} good="connected" />
                      {connected && <Pill value={acct?.online} good="online" />}
                    </span>
                  </div>
                  {acct?.offline_reason && <p className="text-xs text-gray-500">{acct.offline_reason}</p>}
                  <div className="flex flex-wrap gap-2">
                    {!connected && (
                      <button className={`${btn} border-[#16A34A] text-[#16A34A]`} disabled={!!busy} onClick={() => startConnect(p)}>
                        {busy === `connect-${p.id}` ? 'Creating link…' : 'Connect'}
                      </button>
                    )}
                    {connected && acct?.online === 'online' && (
                      <button className={`${btn} border-gray-300`} disabled={!!busy}
                        onClick={() => run(`pause-${p.id}`, 'pause_provider', { integration_account_id: id, ...(pauseFor === '' ? {} : { pause_seconds: pauseFor }) })}>
                        {busy === `pause-${p.id}` ? 'Pausing…' : 'Pause'}
                      </button>
                    )}
                    {connected && acct?.online !== 'online' && (
                      <button className={`${btn} border-gray-300`} disabled={!!busy}
                        onClick={() => run(`resume-${p.id}`, 'resume_provider', { integration_account_id: id })}>
                        {busy === `resume-${p.id}` ? 'Resuming…' : 'Resume'}
                      </button>
                    )}
                    {acct && (
                      <button className={`${btn} border-red-300 text-red-600`} disabled={!!busy}
                        onClick={() => ask(`Disconnect ${p.label}? Orders from ${p.label} stop until it is reconnected.`,
                          () => run(`disconnect-${p.id}`, 'disconnect_provider', { integration_account_id: id }))}>
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {confirm && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
          <p className="text-sm text-red-800">{confirm.text}</p>
          <div className="flex gap-2">
            <button className={`${btn} border-gray-300 bg-white flex-1`} onClick={() => setConfirm(null)}>Cancel</button>
            <button className={`${btn} border-red-600 bg-red-600 text-white flex-1`} disabled={!!busy}
              onClick={async () => { const c = confirm; setConfirm(null); await c.run() }}>
              Confirm
            </button>
          </div>
        </div>
      )}

      {connect && (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <p className="text-sm font-semibold">Connect {connect.label}</p>
          <p className="text-xs text-gray-500">Send this link to the restaurant owner (or have them scan the code) to authorize {connect.label}.</p>
          <p className="text-xs break-all bg-gray-50 rounded p-2">{connect.url}</p>
          <div className="flex gap-2">
            <button className={`${btn} border-gray-300`}
              onClick={() => navigator.clipboard.writeText(connect.url).then(() => toast.success('Link copied'), () => toast.error('Copy failed'))}>
              Copy link
            </button>
            <button className={`${btn} border-gray-300`} onClick={() => setConnect(null)}>Close</button>
          </div>
          {connect.qr && <img src={connect.qr} alt={`${connect.label} connection QR code`} className="w-44 h-44" />}
        </div>
      )}

      <AllLocations ownLocationId={info?.mapping?.kh_location_id ?? null} />
    </div>
  )
}
