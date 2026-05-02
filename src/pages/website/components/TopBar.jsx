import { useState } from 'react'
import HoursModal from './HoursModal'
import OrderLink from './OrderLink'
import { formatDisplayAddress } from '../utils/address'

function StatusPill({ isOpen }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
        isOpen ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
      }`}
    >
      {isOpen ? 'OPEN' : 'CLOSED'}
    </span>
  )
}

function MobileDrawer({ open, onClose, restaurant, status, onOpenHours }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div className="absolute right-0 top-0 h-full w-[80%] max-w-sm bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="font-bold text-base">{restaurant.name}</span>
            <StatusPill isOpen={status.isOpen} />
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
          >
            &times;
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4">
          <OrderLink
            slug={restaurant.slug}
            onClick={onClose}
            className="block px-5 py-3 text-base font-semibold text-gray-900 hover:bg-gray-50"
          >
            Order
          </OrderLink>
          <button
            onClick={() => { onClose(); onOpenHours() }}
            className="w-full text-left px-5 py-3 text-base font-semibold text-gray-900 hover:bg-gray-50"
          >
            Hours
          </button>
          {restaurant.about_section_visible !== false && (
            <a
              href="#about"
              onClick={onClose}
              className="block px-5 py-3 text-base font-semibold text-gray-900 hover:bg-gray-50"
            >
              About
            </a>
          )}
        </nav>

        <div className="border-t border-gray-100 px-5 py-4 space-y-2 text-sm text-gray-600">
          <p className="font-medium text-gray-900">{status.statusText}</p>
          {restaurant.address && <p>{formatDisplayAddress(restaurant.address)}</p>}
          {restaurant.phone && (
            <a
              href={`tel:${restaurant.phone}`}
              className="font-semibold"
              style={{ color: 'var(--brand-color)' }}
            >
              {restaurant.phone}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TopBar({ restaurant, status, hours, onDrawerOpenChange }) {
  const [drawerOpen, setDrawerOpenState] = useState(false)
  const [hoursModalOpen, setHoursModalOpen] = useState(false)

  function setDrawerOpen(next) {
    setDrawerOpenState(next)
    if (onDrawerOpenChange) onDrawerOpenChange(next)
  }

  function openHoursModal() {
    setHoursModalOpen(true)
  }

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-gray-100">
      <div className="max-w-[1280px] mx-auto px-4 md:px-8 py-3 md:py-4 flex items-center justify-between gap-4">
        {/* LEFT */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-bold text-base md:text-lg truncate">{restaurant.name}</span>
          <StatusPill isOpen={status.isOpen} />
          {/* Hours summary — desktop only */}
          <span className="hidden md:inline text-sm text-gray-500 truncate">
            {status.statusText.replace(/^OPEN\s/, '').replace(/^CLOSED · /, '')}
          </span>
        </div>

        {/* RIGHT — desktop */}
        <div className="hidden md:flex items-center gap-6 text-sm">
          {restaurant.address && (
            <span className="text-gray-500 truncate max-w-md">{formatDisplayAddress(restaurant.address)}</span>
          )}
          <div className="flex items-center gap-5">
            <OrderLink slug={restaurant.slug} className="font-semibold text-gray-900 hover:text-[var(--brand-color)]">
              Menu
            </OrderLink>
            <button onClick={openHoursModal} className="font-semibold text-gray-900 hover:text-[var(--brand-color)]">
              Hours
            </button>
            {restaurant.about_section_visible !== false && (
              <a href="#about" className="font-semibold text-gray-900 hover:text-[var(--brand-color)]">
                About
              </a>
            )}
          </div>
        </div>

        {/* RIGHT — mobile hamburger */}
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="md:hidden w-10 h-10 flex items-center justify-center text-gray-900"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        restaurant={restaurant}
        status={status}
        onOpenHours={openHoursModal}
      />

      <HoursModal
        open={hoursModalOpen}
        onClose={() => setHoursModalOpen(false)}
        hours={hours}
      />
    </header>
  )
}
