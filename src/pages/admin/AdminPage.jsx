import { useState, useEffect } from 'react'
import { useAdminAuth } from '../../hooks/useAdminAuth'
import DirectBiteLogo from '../../components/DirectBiteLogo'
import AdminLogin from './AdminLogin'
import OrdersTab from './OrdersTab'
import RestaurantsTab from './RestaurantsTab'
import RevenueTab from './RevenueTab'
import MenuManagementTab from './MenuManagementTab'
import OnboardingTab from './OnboardingTab'

const TABS = [
  { key: 'orders', label: 'Orders', short: 'Orders', icon: OrdersIcon },
  { key: 'restaurants', label: 'Restaurants', short: 'Stores', icon: RestaurantsIcon },
  { key: 'revenue', label: 'Revenue', short: 'Revenue', icon: RevenueIcon },
  { key: 'menu', label: 'Menu Management', short: 'Menu', icon: MenuIcon },
  { key: 'onboarding', label: 'Onboarding', short: 'New', icon: OnboardingIcon },
]

export default function AdminPage() {
  const { session, loading, error, login, logout } = useAdminAuth()
  const [activeTab, setActiveTab] = useState('orders')

  // PWA manifest + apple-touch-icon for /admin. Injected at mount so it
  // doesn't apply to other routes (per the index.html note about iOS
  // caching static manifest tags).
  useEffect(() => {
    const manifest = document.createElement('link')
    manifest.rel = 'manifest'
    manifest.href = '/admin-manifest.webmanifest'
    document.head.appendChild(manifest)
    const appleIcon = document.createElement('link')
    appleIcon.rel = 'apple-touch-icon'
    appleIcon.href = '/icon-192.svg'
    document.head.appendChild(appleIcon)
    return () => {
      manifest.remove()
      appleIcon.remove()
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!session) {
    return <AdminLogin onLogin={login} error={error} />
  }

  return (
    <div className="h-screen flex flex-col md:flex-row bg-gray-50">
      {/* Sidebar — desktop only */}
      <aside className="hidden md:flex w-56 bg-white border-r border-gray-200 flex-col shrink-0">
        <div className="px-5 py-4 border-b border-gray-200">
          <DirectBiteLogo color="dark" height={24} />
          <p className="text-xs text-gray-400 mt-1">Admin Panel</p>
        </div>
        <nav className="flex-1 py-3">
          {TABS.map(tab => {
            const Icon = tab.icon
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-[#16A34A] bg-green-50 border-r-2 border-[#16A34A]'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Icon active={isActive} />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header
          className="bg-white border-b border-gray-200 flex items-center justify-between px-4 md:px-6 shrink-0"
          style={{ height: 'calc(3.5rem + env(safe-area-inset-top))', paddingTop: 'env(safe-area-inset-top)' }}
        >
          <DirectBiteLogo color="dark" height={20} />
          <div className="flex items-center gap-4">
            <span className="hidden md:inline text-sm text-gray-500">{session.user.email}</span>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-gray-600 transition-colors min-h-[44px] px-2">
              Sign Out
            </button>
          </div>
        </header>

        {/* Tab content */}
        <main className="flex-1 overflow-hidden">
          {activeTab === 'orders' && <OrdersTab />}
          {activeTab === 'restaurants' && <RestaurantsTab />}
          {activeTab === 'revenue' && <RevenueTab />}
          {activeTab === 'menu' && <MenuManagementTab />}
          {activeTab === 'onboarding' && <OnboardingTab />}
        </main>

        {/* Mobile bottom nav */}
        <nav
          className="md:hidden flex items-stretch bg-white border-t border-gray-200 shrink-0"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          {TABS.map(tab => {
            const Icon = tab.icon
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px] text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                  isActive ? 'text-[#16A34A]' : 'text-gray-500'
                }`}
              >
                <Icon active={isActive} />
                {tab.short}
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}

// ── Sidebar icons ──
function OrdersIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  )
}

function RestaurantsIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  )
}

function RevenueIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function MenuIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  )
}

function OnboardingIcon({ active }) {
  return (
    <svg className={`w-5 h-5 ${active ? 'text-[#16A34A]' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
