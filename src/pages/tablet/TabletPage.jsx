import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useTabletAuth } from '../../hooks/useTabletAuth'
import { useOrderPolling } from '../../hooks/useOrderPolling'
import { supabase } from '../../lib/supabase'
import TabletLogin from './TabletLogin'
import OrdersTab from './OrdersTab'
import MenuTab from './MenuTab'
import PromotionsTab from './PromotionsTab'
import SettingsTab from './SettingsTab'
import PwaInstallPrompt from '../../components/PwaInstallPrompt'

const TABS = [
  { key: 'orders', label: 'Orders', icon: OrdersIcon },
  { key: 'menu', label: 'Menu', icon: MenuIcon },
  { key: 'promotions', label: 'Promotions', icon: PromotionsIcon },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
]

export default function TabletPage() {
  const { slug } = useParams()
  const { session, restaurant, setRestaurant, loading, error, login, logout } = useTabletAuth(slug)
  const [activeTab, setActiveTab] = useState('orders')
  const [hours, setHours] = useState([])
  const [isOnline, setIsOnline] = useState(true)
  const [showDebug, setShowDebug] = useState(false)
  const failCount = useRef(0)
  const [pingStats, setPingStats] = useState({ success: 0, total: 0, lastTime: null, fails: 0 })

  // Eagerly load the Epson ePOS SDK so window.epson is ready before the
  // first order arrives. Loaded here (not in index.html) so it doesn't
  // ship on website / customer / admin routes. Idempotent — bails if
  // the SDK already loaded or another tablet mount already injected.
  useEffect(() => {
    if (window.epson || document.getElementById('epson-epos-sdk')) return
    const s = document.createElement('script')
    s.id = 'epson-epos-sdk'
    s.src = '/epos-2.27.0.js'
    s.async = true
    document.head.appendChild(s)
  }, [])

  useEffect(() => {
    const goOnline = () => {
      console.log('[ONLINE] Banner hidden — window online event')
      failCount.current = 0
      setIsOnline(true)
    }
    const goOffline = () => {
      console.log('[OFFLINE] Banner shown — window offline event')
      setIsOnline(false)
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    const pingUrl = 'https://www.google.com/generate_204'
    const ping = async () => {
      console.log('[PING] Attempting...', pingUrl)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      try {
        await fetch(pingUrl, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' })
        clearTimeout(timeout)
        console.log('[PING] Success')
        failCount.current = 0
        setPingStats(p => ({ success: p.success + 1, total: p.total + 1, lastTime: now, fails: 0 }))
        setIsOnline(true)
      } catch (err) {
        clearTimeout(timeout)
        failCount.current++
        const reason = err.name === 'AbortError' ? 'timeout (5s)' : err.message
        console.log(`[PING] Failed: ${reason} — consecutive fails: ${failCount.current}`)
        setPingStats(p => ({ ...p, total: p.total + 1, lastTime: now, fails: failCount.current }))
        if (failCount.current >= 3) { console.log(`[OFFLINE] Banner shown — ${failCount.current} consecutive failures`); setIsOnline(false) }
      }
    }
    ping()
    const interval = setInterval(ping, 30000)

    return () => { clearInterval(interval); window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline) }
  }, [])

  // Dynamic PWA manifest via Vercel serverless function — scoped to this
  // restaurant's slug. Create the link tag if it's missing (index.html no
  // longer ships a static one — iOS would otherwise cache the static
  // DirectBite manifest before our React swap could run).
  useEffect(() => {
    let link = document.querySelector('link[rel="manifest"]')
    const preExisting = !!link
    const originalHref = link?.getAttribute('href') || null
    if (!link) {
      link = document.createElement('link')
      link.rel = 'manifest'
      document.head.appendChild(link)
    }
    link.setAttribute('href', `/api/tablet-manifest?slug=${slug}`)
    return () => {
      if (preExisting) {
        if (originalHref) link.setAttribute('href', originalHref)
      } else if (link.parentNode) {
        link.parentNode.removeChild(link)
      }
    }
  }, [slug])

  // Fetch hours for open-hours polling check
  useEffect(() => {
    if (!restaurant) return

    async function fetchHours() {
      const { data } = await supabase
        .from('hours')
        .select('*')
        .eq('restaurant_id', restaurant.id)
        .order('day_of_week')

      setHours(data || [])
    }

    fetchHours()
  }, [restaurant?.id])

  // Re-fetch the restaurant when the tab becomes visible again so admin-driven
  // changes (e.g., website_enabled toggle) propagate to the tablet without a
  // manual logout/refresh. Cheaper than polling, since restaurant settings
  // rarely change.
  useEffect(() => {
    if (!restaurant?.id) return

    async function refreshRestaurant() {
      if (document.visibilityState !== 'visible') return
      const { data } = await supabase
        .from('restaurants')
        .select('*')
        .eq('id', restaurant.id)
        .single()
      if (data) setRestaurant(data)
    }

    document.addEventListener('visibilitychange', refreshRestaurant)
    return () => document.removeEventListener('visibilitychange', refreshRestaurant)
  }, [restaurant?.id, setRestaurant])

  // Order polling, chime, auto-print — runs regardless of active tab
  const { orders, setOrders, loading: ordersLoading, fetchOrders, diagnostics } = useOrderPolling(restaurant, hours)

  // D3 fix: refetch orders on visibility change so wake-from-sleep
  // doesn't wait up to 10s for the next poll.
  useEffect(() => {
    if (!restaurant?.id) return

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        console.log('[VISIBILITY] became visible — forcing order refetch')
        diagnostics.current.visibilityRefetches++
        fetchOrders()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [restaurant?.id, fetchOrders, diagnostics])

  useEffect(() => {
    if (!restaurant?.id) return

    function handleOnline() {
      console.log('[ONLINE] reconnected — forcing order refetch')
      fetchOrders()
    }

    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [restaurant?.id, fetchOrders])

  // Auth state surveillance — surface refresh failures and token rotation in logs.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('[AUTH]', event, 'expires_at=', session?.expires_at, 'has_token=', !!session?.access_token)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Force re-render of debug overlay every second so diagnostics ref values stay fresh.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!showDebug) return
    const tick = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(tick)
  }, [showDebug])

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!session || !restaurant) {
    return (
      <TabletLogin
        slug={slug}
        onLogin={async (email, password, acceptTerms) => {
          const success = await login(email, password)
          if (success && acceptTerms) {
            await supabase.from('restaurants').update({ terms_accepted_at: new Date().toISOString() }).eq('slug', slug)
          }
          return success
        }}
        error={error}
        termsAccepted={restaurant?.terms_accepted_at}
      />
    )
  }

  return (
    <div className="flex flex-col bg-gray-50" style={{ height: '100dvh' }}>
      {/* Top nav */}
      <header className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-gray-900 cursor-pointer select-none" onClick={() => setShowDebug(d => !d)}>{restaurant.name}</h1>
        </div>
        <button
          onClick={logout}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          Sign Out
        </button>
      </header>

      {/* Offline banner */}
      {!isOnline && (
        <div className="bg-red-600 text-white text-sm font-semibold text-center py-2 shrink-0">
          No internet connection — check network status
        </div>
      )}

      {/* Tabs */}
      <nav className="bg-white border-b border-gray-200 flex shrink-0">
        {TABS.map(tab => {
          const Icon = tab.icon
          const isActive = activeTab === tab.key
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-semibold transition-colors ${
                isActive
                  ? 'text-[#16A34A] border-b-2 border-[#16A34A]'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon active={isActive} />
              {tab.label}
            </button>
          )
        })}
      </nav>

      {/* Tab content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === 'orders' && <OrdersTab restaurant={restaurant} setRestaurant={setRestaurant} orders={orders} setOrders={setOrders} ordersLoading={ordersLoading} fetchOrders={fetchOrders} />}
        {activeTab === 'menu' && <MenuTab restaurant={restaurant} />}
        {activeTab === 'promotions' && <PromotionsTab restaurant={restaurant} />}
        {activeTab === 'settings' && <SettingsTab restaurant={restaurant} setRestaurant={setRestaurant} />}
      </main>

      {/* Debug overlay */}
      {showDebug && (
        <div className="fixed bottom-2 right-2 z-50 bg-gray-900/90 text-gray-200 text-[10px] font-mono px-3 py-2 rounded-lg leading-tight max-w-[380px]">
          <div>Net: online={isOnline ? 'T' : 'F'} pings={pingStats.success}/{pingStats.total} fails={pingStats.fails} last={pingStats.lastTime || '—'}</div>
          <div>Poll: {diagnostics.current.pollSuccesses}/{diagnostics.current.pollAttempts} ok · fail={diagnostics.current.pollFailures} · last={diagnostics.current.lastPollAt?.slice(11, 19) || '—'}</div>
          <div>Last ok: {diagnostics.current.lastSuccessAt?.slice(11, 19) || '—'} · returned={diagnostics.current.ordersReturnedLastPoll}</div>
          {diagnostics.current.lastErrorMessage && (
            <div className="text-red-400 truncate">Err: {diagnostics.current.lastErrorCode || '—'}: {diagnostics.current.lastErrorMessage}</div>
          )}
          <div>Audio: {diagnostics.current.audioContextState} · chimes={diagnostics.current.chimePlayed}/{diagnostics.current.chimeAttempts} · suspFails={diagnostics.current.chimeFailedSuspended}</div>
          <div>Vis refetches: {diagnostics.current.visibilityRefetches}</div>
        </div>
      )}

      {/* PWA install prompt — tablet only */}
      <PwaInstallPrompt />

      {/* Pulse animation style */}
      <style>{`
        @keyframes pulse-subtle {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.15); }
        }
        .animate-pulse-subtle {
          animation: pulse-subtle 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  )
}

// ── Tab icons ──
function OrdersIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  )
}

function MenuIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  )
}

function PromotionsIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
    </svg>
  )
}

function SettingsIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}
