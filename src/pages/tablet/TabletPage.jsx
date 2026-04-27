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
  const failCount = useRef(0)

  useEffect(() => {
    const goOnline = () => {
      console.log('[Connectivity] Window online event — clearing banner')
      failCount.current = 0
      setIsOnline(true)
    }
    const goOffline = () => {
      console.log('[Connectivity] Window offline event — showing banner')
      setIsOnline(false)
    }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    const pingUrl = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`
    const ping = async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetch(pingUrl, { method: 'GET', signal: controller.signal, cache: 'no-store' })
        clearTimeout(timeout)
        console.log('[Connectivity] Ping', res.ok ? 'OK' : `failed (${res.status})`, '— fails:', res.ok ? 0 : failCount.current + 1)
        if (res.ok) { failCount.current = 0; setIsOnline(true) }
        else { failCount.current++; if (failCount.current >= 3) { console.log('[Connectivity] 3 consecutive failures — showing banner'); setIsOnline(false) } }
      } catch (err) {
        clearTimeout(timeout)
        failCount.current++
        console.log('[Connectivity] Ping error:', err.name === 'AbortError' ? 'timeout' : err.message, '— fails:', failCount.current)
        if (failCount.current >= 3) { console.log('[Connectivity] 3 consecutive failures — showing banner'); setIsOnline(false) }
      }
    }
    ping()
    const interval = setInterval(ping, 30000)

    return () => { clearInterval(interval); window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline) }
  }, [])

  // Dynamic PWA manifest via Vercel serverless function — scoped to this restaurant's slug
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]')
    const originalHref = link?.getAttribute('href')
    if (link) link.setAttribute('href', `/api/tablet-manifest?slug=${slug}`)
    return () => { if (link && originalHref) link.setAttribute('href', originalHref) }
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

  // Order polling, chime, auto-print — runs regardless of active tab
  const { orders, setOrders, loading: ordersLoading, stopChime, fetchOrders } = useOrderPolling(restaurant, hours)

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
          <h1 className="text-lg font-bold text-gray-900">{restaurant.name}</h1>
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
        {activeTab === 'orders' && <OrdersTab restaurant={restaurant} setRestaurant={setRestaurant} orders={orders} setOrders={setOrders} ordersLoading={ordersLoading} stopChime={stopChime} fetchOrders={fetchOrders} />}
        {activeTab === 'menu' && <MenuTab restaurant={restaurant} />}
        {activeTab === 'promotions' && <PromotionsTab restaurant={restaurant} />}
        {activeTab === 'settings' && <SettingsTab restaurant={restaurant} setRestaurant={setRestaurant} />}
      </main>

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
