import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { IS_NATIVE, APP_SLUG } from '../lib/native'
import { applyNativeBrand } from '../lib/nativeBrand'
import { useCustomerAuth } from '../hooks/useCustomerAuth'
import { formatPoints } from './rewardsShared'

// Native shell only. The wrapper returns before any hook runs, so on web
// this component renders nothing and does no work.
export default function NativeTabBar() {
  if (!IS_NATIVE || !APP_SLUG) return null
  return <TabBarInner slug={APP_SLUG} />
}

const TAB_ROUTES = ['', '/account', '/rewards', '/settings']

function isTextField(el) {
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

function TabBarInner({ slug }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { isLoggedIn, loadProfile } = useCustomerAuth()

  const [rest, setRest] = useState(null)
  const [points, setPoints] = useState(null)
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  // Restaurant flags + brand color, once per mount.
  useEffect(() => {
    let alive = true
    supabase
      .from('restaurants')
      .select('id, loyalty_enabled, primary_color')
      .eq('slug', slug)
      .single()
      .then(({ data }) => {
        if (!alive || !data) return
        setRest(data)
        applyNativeBrand(data.primary_color)
      })
    return () => { alive = false }
  }, [slug])

  // Points label. Re-read on every navigation so a redeem or an order lands.
  useEffect(() => {
    if (!rest || !isLoggedIn || rest.loyalty_enabled !== true) return
    let alive = true
    loadProfile(rest.id).then((p) => {
      if (!alive) return
      setPoints(p ? Number(p.points_balance) || 0 : null)
    })
    return () => { alive = false }
  }, [rest?.id, rest?.loyalty_enabled, isLoggedIn, loadProfile, location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  // Hide while the soft keyboard is likely up (a text field has focus).
  useEffect(() => {
    function onFocusIn(e) {
      if (isTextField(e.target)) setKeyboardOpen(true)
    }
    let timer = null
    function onFocusOut() {
      clearTimeout(timer)
      timer = setTimeout(() => setKeyboardOpen(isTextField(document.activeElement)), 0)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // Lets html.native CSS react to the keyboard (e.g. hide the floating cart).
  useEffect(() => {
    document.documentElement.classList.toggle('ordr-kb', keyboardOpen)
    return () => document.documentElement.classList.remove('ordr-kb')
  }, [keyboardOpen])

  const base = `/${slug}`
  const { pathname } = location
  const sub = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, '') : null
  if (sub === null || !TAB_ROUTES.includes(sub)) return null
  if (keyboardOpen) return null

  const loyalty = rest?.loyalty_enabled === true
  const shownPoints = loyalty && isLoggedIn ? points : null
  const section = new URLSearchParams(location.search).get('section')

  const tabs = [
    { key: 'menu', label: 'Menu', to: base, Icon: MenuIcon },
    loyalty && {
      key: 'rewards',
      label: shownPoints != null ? `${formatPoints(shownPoints)} pts` : 'Rewards',
      to: `${base}/account?section=rewards`,
      Icon: StarIcon,
    },
    { key: 'orders', label: 'Orders', to: `${base}/account?section=orders`, Icon: ReceiptIcon },
    { key: 'account', label: 'Account', to: `${base}/settings`, Icon: PersonIcon },
  ].filter(Boolean)

  let active = null
  if (sub === '') active = 'menu'
  else if (sub === '/settings') active = 'account'
  else if (sub === '/rewards') active = 'rewards'
  else if (sub === '/account') active = loyalty && section !== 'orders' ? 'rewards' : 'orders'

  function handleTap(tab) {
    if (tab.key === active) {
      if (tab.key === 'menu') window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    navigate(tab.to, { replace: active !== 'menu' })
  }

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 ordr-tabbar">
      <div className="mx-auto max-w-lg flex items-stretch justify-around gap-1 px-2 pt-2">
        {tabs.map((tab) => {
          const on = tab.key === active
          const { Icon } = tab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTap(tab)}
              aria-current={on ? 'page' : undefined}
              className={`flex-1 min-w-0 h-14 rounded-2xl flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${on ? 'ordr-tab-on' : 'text-gray-500'}`}
            >
              <Icon filled={on} />
              <span className="truncate max-w-full px-1">{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

// Icons: 24px grid, currentColor. Stroked when inactive, filled when active.
function iconProps(filled) {
  return filled
    ? { fill: 'currentColor', stroke: 'none' }
    : { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
}

function MenuIcon({ filled }) {
  // Fork (left) and knife (right).
  if (filled) {
    return (
      <svg className="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M4 3h1.5v4.5h1V3h1.5v4.5h1V3h1.5v5a3 3 0 0 1-2.25 2.9V21h-2.5V10.9A3 3 0 0 1 4 8z" />
        <path d="M18 3c-2.5 1.5-4 4.5-4 8v3h2.5v7H19V3.6c0-.45-.5-.75-1-.6z" />
      </svg>
    )
  }
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true" {...iconProps(false)}>
      <path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10" />
      <path d="M17 21V3c-2 1.5-3 4-3 7v3h3" />
    </svg>
  )
}

function StarIcon({ filled }) {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true" {...iconProps(filled)}>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z" />
    </svg>
  )
}

function ReceiptIcon({ filled }) {
  if (filled) {
    return (
      <svg className="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M5 3h14v18l-2.33-1.5L14.33 21 12 19.5 9.67 21 7.33 19.5 5 21V3zm4 5h6v1.8H9V8zm0 4h6v1.8H9V12z"
        />
      </svg>
    )
  }
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true" {...iconProps(false)}>
      <path d="M5 3h14v18l-2.33-1.5L14.33 21 12 19.5 9.67 21 7.33 19.5 5 21z" />
      <path d="M9 8.9h6M9 12.9h6" />
    </svg>
  )
}

function PersonIcon({ filled }) {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true" {...iconProps(filled)}>
      <circle cx="12" cy="7.5" r="4" />
      <path d="M4.5 20.5c0-4 3.4-6.8 7.5-6.8s7.5 2.8 7.5 6.8z" />
    </svg>
  )
}
