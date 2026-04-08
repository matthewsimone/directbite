import { useState } from 'react'
import { useAdminAuth } from '../../hooks/useAdminAuth'
import AdminLogin from './AdminLogin'
import OrdersTab from './OrdersTab'
import RestaurantsTab from './RestaurantsTab'
import RevenueTab from './RevenueTab'
import MenuManagementTab from './MenuManagementTab'
import OnboardingTab from './OnboardingTab'

const TABS = [
  { key: 'orders', label: 'Orders', icon: OrdersIcon },
  { key: 'restaurants', label: 'Restaurants', icon: RestaurantsIcon },
  { key: 'revenue', label: 'Revenue', icon: RevenueIcon },
  { key: 'menu', label: 'Menu Management', icon: MenuIcon },
  { key: 'onboarding', label: 'Onboarding', icon: OnboardingIcon },
]

export default function AdminPage() {
  const { session, loading, error, login, logout } = useAdminAuth()
  const [activeTab, setActiveTab] = useState('orders')

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
    <div className="h-screen flex bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="px-5 py-4 border-b border-gray-200">
          <h1 className="text-lg font-bold">
            <span className="text-gray-900">Direct</span><span className="text-[#16A34A]">Bite</span>
          </h1>
          <p className="text-xs text-gray-400">Admin Panel</p>
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
        <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0">
          <h2 className="font-semibold text-gray-900">DirectBite Admin</h2>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{session.user.email}</span>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
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
