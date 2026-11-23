import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useCustomerAuth } from '../../hooks/useCustomerAuth'
import { useRestaurant } from '../../hooks/useRestaurant'
import { getPublicOrigin, IS_NATIVE } from '../../lib/native'
import { useNativeBack } from '../../lib/nativeBack'
import { getPushPermission, requestPushPermission } from '../../lib/nativePush'

// Native shell Account tab — profile, saved address, legal links, sign out, delete account. Routed only when IS_NATIVE.
// Internal view stack (main → info → name/email/delete, main → address/legal), Owner.com-style.
export default function SettingsPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { isLoggedIn, phone, logout, loadSavedProfile, saveProfile, deleteAccount } = useCustomerAuth()
  const { restaurant } = useRestaurant(slug)
  const restaurantName = restaurant?.name || 'this restaurant'

  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Baseline = what the server last told us; name/email = what's in the inputs.
  const [baseName, setBaseName] = useState('')
  const [baseEmail, setBaseEmail] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [apt, setApt] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [view, setView] = useState('main')
  const [version, setVersion] = useState(null)
  const [appName, setAppName] = useState(null)
  const [pushPerm, setPushPerm] = useState(null)

  useEffect(() => {
    if (!isLoggedIn) return
    let alive = true
    loadSavedProfile().then((p) => {
      if (!alive) return
      if (!p) {
        setLoadFailed(true)
        return
      }
      const n = p.display_name || ''
      const e = p.email || ''
      setBaseName(n)
      setBaseEmail(e)
      setName(n)
      setEmail(e)
      setAddress(p.delivery_address || '')
      setApt(p.delivery_apt || '')
      setLoadFailed(false)
      setLoaded(true)
    }).catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [isLoggedIn, loadSavedProfile, reloadKey])

  // App version, native only. Nothing renders if it can't be read.
  useEffect(() => {
    if (!IS_NATIVE) return
    let alive = true
    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        const i = await App.getInfo()
        if (alive) {
          setVersion(`v${i.version} (${i.build})`)
          setAppName(i.name || null)
        }
      } catch {
        // no version line
      }
    })()
    return () => { alive = false }
  }, [])

  // Notification permission, re-read whenever the app comes back to the
  // foreground (the customer may have changed it in the phone's Settings).
  useEffect(() => {
    if (!IS_NATIVE) return
    let alive = true
    function refresh() {
      if (document.visibilityState !== 'visible') return
      getPushPermission().then((p) => { if (alive) setPushPerm(p) })
    }
    refresh()
    document.addEventListener('visibilitychange', refresh)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [view])

  function handleRetry() {
    setLoadFailed(false)
    setReloadKey((k) => k + 1)
  }

  function goBack() {
    setView((v) => (v === 'name' || v === 'email' || v === 'delete' ? 'info' : 'main'))
  }

  // Opening an editor starts from the saved value, not a stale draft.
  function openEditor(which) {
    if (which === 'name') setName(baseName)
    if (which === 'email') setEmail(baseEmail)
    setView(which)
  }

  async function handleSignOut() {
    await logout()
    navigate(`/${slug}`, { replace: true })
  }

  // Same exit as Sign out. 'unauthorized' exits too — the hook has already
  // dropped the token, so staying here would show a signed-out page.
  async function handleDeleteAccount() {
    if (deleting) return
    setDeleting(true)
    const res = await deleteAccount(slug)
    if (res.ok || res.error === 'unauthorized') {
      if (res.ok) toast.success('Account deleted')
      navigate(`/${slug}`, { replace: true })
      return
    }
    setDeleting(false)
    toast.error("Couldn't delete your account. Try again.")
  }

  async function handleNotifications() {
    if (pushPerm === 'prompt') {
      const next = await requestPushPermission()
      setPushPerm(next)
      return
    }
    if (pushPerm === 'denied') {
      toast(`Turn on notifications in your phone's Settings → ${appName || restaurantName}`)
      return
    }
    if (pushPerm === 'granted') {
      toast("Notifications are on. Turn them off in your phone's Settings.")
    }
  }

  const pushSubtitle =
    pushPerm === 'granted' ? 'On'
      : pushPerm === 'denied' ? 'Off — turn on in Settings'
        : 'Off'

  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  const nameChanged = trimmedName !== baseName.trim()
  const emailChanged = trimmedEmail !== baseEmail.trim()
  const emailOk = trimmedEmail === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
  const canSaveName = loaded && nameChanged && !saving
  const canSaveEmail = loaded && emailChanged && emailOk && !saving

  // Each editor saves only its own field.
  async function handleSave(field) {
    const ok = field === 'name' ? canSaveName : canSaveEmail
    if (!ok) return
    const updates = field === 'name'
      ? { display_name: trimmedName || null }
      : { email: trimmedEmail || null }
    setSaving(true)
    const res = await saveProfile(updates)
    setSaving(false)
    if (!res) {
      toast.error("Couldn't save. Try again.")
      return
    }
    if (field === 'name') {
      const n = res.display_name ?? trimmedName
      setBaseName(n || '')
      setName(n || '')
    } else {
      const e = res.email ?? trimmedEmail
      setBaseEmail(e || '')
      setEmail(e || '')
    }
    toast.success('Saved')
    goBack()
  }

  async function handleRemoveAddress() {
    if (removing) return
    setRemoving(true)
    const res = await saveProfile({
      delivery_address: null,
      delivery_apt: null,
      delivery_lat: null,
      delivery_lng: null,
    })
    setRemoving(false)
    if (!res) {
      toast.error("Couldn't remove. Try again.")
      return
    }
    setAddress('')
    setApt('')
    toast.success('Address removed')
  }

  const origin = getPublicOrigin()
  const addressLine = address ? `${address}${apt ? `, ${apt}` : ''}` : ''

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-white ordr-tab-page">
        <div className="max-w-[720px] mx-auto px-6 pt-6">
          <h1 className="text-2xl font-bold text-gray-900">Account</h1>
          <p className="mt-4 text-gray-500">Not signed in.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white ordr-tab-page">
      {/* Remounted per view so Android back always has an entry for the current one. */}
      {view !== 'main' && <BackHandler key={view} onBack={goBack} />}
      <div className="max-w-[720px] mx-auto px-6 pt-6">
        {view === 'main' && (
          <>
            <h1 className="text-2xl font-bold text-gray-900">Account</h1>

            {loadFailed && (
              <p className="mt-4 text-sm text-gray-500">
                Couldn&apos;t load your profile.{' '}
                <button type="button" onClick={handleRetry} className="font-semibold text-gray-700 underline">
                  Retry
                </button>
              </p>
            )}

            <button
              type="button"
              onClick={() => setView('info')}
              className="mt-6 w-full rounded-2xl bg-gray-50 p-5 flex items-center gap-4 text-left"
            >
              <PersonIcon />
              <div className="flex-1 min-w-0">
                <p className={`text-lg font-bold truncate ${baseName ? 'text-gray-900' : 'text-gray-400'}`}>
                  {baseName || 'Add your name'}
                </p>
                {baseEmail && <p className="text-gray-600 truncate">{baseEmail}</p>}
              </div>
              <ChevronRight />
            </button>

            <div className="mt-4 divide-y divide-dashed divide-gray-200">
              <NavRow title="Saved address" subtitle={addressLine || 'None saved'} onClick={() => setView('address')} />
              {pushPerm && pushPerm !== 'unsupported' && (
                <NavRow title="Notifications" subtitle={pushSubtitle} onClick={handleNotifications} />
              )}
              <NavRow title="Legal" onClick={() => setView('legal')} />
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              className="w-full h-12 rounded-xl border border-gray-300 bg-white font-semibold text-gray-900 mt-8"
            >
              Sign out
            </button>

            {version && <p className="text-xs text-gray-400 mt-6">{version}</p>}
          </>
        )}

        {view === 'info' && (
          <>
            <SubHeader title="Account info" onBack={goBack} />
            <div className="mt-6 divide-y divide-dashed divide-gray-200">
              <ValueRow label="Name" value={baseName} onClick={() => openEditor('name')} />
              <ValueRow label="Email address" value={baseEmail} onClick={() => openEditor('email')} />
              <div className="py-3">
                <div className="flex items-center justify-between min-h-[2rem]">
                  <span className="text-base text-gray-900">Mobile number</span>
                  <span className="flex items-center gap-1.5 text-base text-gray-400">
                    {formatE164(phone)}
                    <LockIcon />
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">Verified — used to sign in. Can&apos;t be changed.</p>
              </div>
              <button
                type="button"
                onClick={() => setView('delete')}
                className="w-full py-3 min-h-[2rem] text-left text-base font-semibold text-red-600"
              >
                Delete account
              </button>
            </div>
          </>
        )}

        {view === 'name' && (
          <>
            <SubHeader title="Name" onBack={goBack} />
            <input
              type="text"
              autoComplete="name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!loaded}
              className="mt-6 w-full h-12 px-4 border border-gray-300 rounded-xl text-base text-gray-900 disabled:bg-gray-50"
            />
            <SaveButton onClick={() => handleSave('name')} disabled={!canSaveName} saving={saving} />
          </>
        )}

        {view === 'email' && (
          <>
            <SubHeader title="Email address" onBack={goBack} />
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!loaded}
              className="mt-6 w-full h-12 px-4 border border-gray-300 rounded-xl text-base text-gray-900 disabled:bg-gray-50"
            />
            <SaveButton onClick={() => handleSave('email')} disabled={!canSaveEmail} saving={saving} />
          </>
        )}

        {view === 'address' && (
          <>
            <SubHeader title="Saved address" onBack={goBack} />
            <div className="mt-6">
              {address ? (
                <div className="flex items-start justify-between gap-4">
                  <p className="text-base text-gray-900">{addressLine}</p>
                  <button
                    type="button"
                    onClick={handleRemoveAddress}
                    disabled={removing}
                    className="shrink-0 text-sm font-semibold text-gray-600 underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <p className="text-sm text-gray-500">Your delivery address is saved when you check out.</p>
              )}
            </div>
          </>
        )}

        {view === 'legal' && (
          <>
            <SubHeader title="Legal" onBack={goBack} />
            <div className="mt-6 divide-y divide-gray-200 border-y border-gray-200">
              <LegalRow href={`${origin}/privacy`}>Privacy Policy</LegalRow>
              <LegalRow href={`${origin}/terms`}>Terms of Service</LegalRow>
            </div>
          </>
        )}

        {view === 'delete' && (
          <>
            <SubHeader title="Delete account" onBack={goBack} />
            <h2 className="mt-6 text-lg font-bold text-gray-900">
              Delete your {restaurantName} account?
            </h2>
            <p className="mt-2 text-gray-600">
              This removes your points, rewards and saved card at {restaurantName}. This can&apos;t be undone.
            </p>
            <button
              type="button"
              onClick={handleDeleteAccount}
              disabled={deleting}
              className="w-full h-12 rounded-xl bg-red-600 font-semibold text-white mt-8 disabled:opacity-60"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              onClick={goBack}
              disabled={deleting}
              className="w-full h-12 rounded-xl border border-gray-300 bg-white font-semibold text-gray-900 mt-3"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function BackHandler({ onBack }) {
  // In-page view navigation, not an overlay: no toast clearing, no top toasts.
  useNativeBack(true, onBack, { overlay: false })
  return null
}

function SubHeader({ title, onBack }) {
  return (
    <div className="relative flex items-center justify-center h-10">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="absolute left-0 w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center"
      >
        <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <h1 className="text-xl font-bold text-gray-900">{title}</h1>
    </div>
  )
}

function NavRow({ title, subtitle, onClick }) {
  return (
    <button type="button" onClick={onClick} className="w-full h-14 flex items-center justify-between gap-4 text-left">
      <div className="min-w-0">
        <p className="text-base text-gray-900">{title}</p>
        {subtitle && <p className="text-sm text-gray-500 truncate">{subtitle}</p>}
      </div>
      <ChevronRight />
    </button>
  )
}

function ValueRow({ label, value, onClick }) {
  return (
    <button type="button" onClick={onClick} className="w-full h-14 flex items-center justify-between gap-4 text-left">
      <span className="text-base text-gray-900">{label}</span>
      <span className="flex items-center gap-2 min-w-0">
        <span className={`truncate ${value ? 'text-gray-600' : 'text-gray-400'}`}>{value || 'Add'}</span>
        <ChevronRight />
      </span>
    </button>
  )
}

function SaveButton({ onClick, disabled, saving }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-4 w-full h-12 rounded-xl text-white font-semibold disabled:opacity-50"
      style={{ backgroundColor: 'var(--brand)' }}
    >
      {saving ? 'Saving…' : 'Save'}
    </button>
  )
}

function LegalRow({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between h-12 text-base text-gray-900"
    >
      {children}
      <ChevronRight />
    </a>
  )
}

function ChevronRight() {
  return (
    <svg className="w-5 h-5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg className="w-7 h-7 shrink-0" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--brand)' }} aria-hidden="true">
      <circle cx="12" cy="7.5" r="4" />
      <path d="M4.5 20.5c0-4 3.4-6.8 7.5-6.8s7.5 2.8 7.5 6.8z" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1zm2 0h6V8a3 3 0 0 0-6 0v2z" />
    </svg>
  )
}

// "+15551234567" → "(555) 123-4567". Anything else is shown as stored.
function formatE164(e164) {
  const d = String(e164 || '').replace(/\D/g, '').slice(-10)
  if (d.length !== 10) return e164 || ''
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}
