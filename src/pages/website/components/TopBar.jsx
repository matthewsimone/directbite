import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import HoursModal from './HoursModal'
import OrderLink from './OrderLink'
import { formatDisplayAddress } from '../utils/address'
import { isMainDomain } from '../../../lib/customDomain'
import { useLinkBase } from '../LinkBaseContext'

const HERO_SHADOW = '[text-shadow:0_1px_2px_rgba(0,0,0,0.5)]'

function formatPhone(raw) {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw
}

function StatusPill({ isOpen, scrolled }) {
  let cls
  if (scrolled) {
    cls = isOpen ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
  } else {
    cls = isOpen ? 'bg-white/20 text-white' : 'bg-red-500/70 text-white'
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold transition-colors duration-300 ${cls}`}
    >
      {isOpen ? 'OPEN' : 'CLOSED'}
    </span>
  )
}

function MobileDrawer({ open, onClose, restaurant, status, onOpenHours }) {
  const linkBase = useLinkBase()
  const base = linkBase !== null ? linkBase : (isMainDomain() ? `/${restaurant.slug}` : '')
  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const phoneFormatted = formatPhone(restaurant.phone)
  const phoneTel = restaurant.phone ? restaurant.phone.replace(/\D/g, '') : null

  // Rendered at document.body via portal so the drawer escapes the
  // header's stacking context (z-30) and can sit above PromoBar (z-40).
  return createPortal(
    <div
      className="fixed inset-0 bg-white z-[60] md:hidden flex flex-col overflow-y-auto"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      {/* Top row — name/status left, close right */}
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-base truncate">{restaurant.name}</span>
          <StatusPill isOpen={status.isOpen} scrolled={true} />
        </div>
        <button
          onClick={onClose}
          aria-label="Close menu"
          className="text-gray-700 text-3xl leading-none w-10 h-10 flex items-center justify-center -mr-2"
        >
          &times;
        </button>
      </div>

      {/* Nav items — large, prominent */}
      <nav className="px-6 pt-8 pb-2">
        <OrderLink
          slug={restaurant.slug}
          onClick={onClose}
          className="block py-3 text-2xl font-bold uppercase tracking-wide text-gray-900"
        >
          Order
        </OrderLink>
        <Link
          to={`${base}/menu`}
          onClick={onClose}
          className="block py-3 text-2xl font-bold uppercase tracking-wide text-gray-900"
        >
          Menu
        </Link>
        {Array.isArray(restaurant.website_links) && restaurant.website_links.length > 0 &&
          restaurant.website_links.map(link => (
            <Link
              key={link.path}
              to={`${base}/${link.path}`}
              onClick={onClose}
              className="block py-3 text-2xl font-bold uppercase tracking-wide text-gray-900"
            >
              {link.label}
            </Link>
          ))}
        <button
          onClick={() => { onClose(); onOpenHours() }}
          className="block w-full text-left py-3 text-2xl font-bold uppercase tracking-wide text-gray-900"
        >
          Hours
        </button>
        {restaurant.about_section_visible !== false && (
          <a
            href="#about"
            onClick={onClose}
            className="block py-3 text-2xl font-bold uppercase tracking-wide text-gray-900"
          >
            About
          </a>
        )}
      </nav>

      {/* Divider */}
      <div className="mx-6 border-t border-gray-200 my-6" />

      {/* Restaurant info — sits in natural flow, not pinned to bottom */}
      <div className="px-6 pb-8 space-y-3 text-base text-gray-700">
        {restaurant.address && (
          <p className="whitespace-pre-line">{formatDisplayAddress(restaurant.address)}</p>
        )}
        {phoneFormatted && (
          <a
            href={`tel:${phoneTel}`}
            className="block font-semibold"
            style={{ color: 'var(--brand-color)' }}
          >
            {phoneFormatted}
          </a>
        )}
        <p className="text-sm text-gray-500 font-medium">{status.statusText}</p>
      </div>
    </div>,
    document.body
  )
}

export default function TopBar({ restaurant, status, hours, onDrawerOpenChange, solid = false }) {
  const linkBase = useLinkBase()
  const base = linkBase !== null ? linkBase : (isMainDomain() ? `/${restaurant.slug}` : '')
  const [drawerOpen, setDrawerOpenState] = useState(false)
  const [hoursModalOpen, setHoursModalOpen] = useState(false)
  const [scrolled, setScrolled] = useState(() =>
    typeof window !== 'undefined' && window.scrollY > 100
  )

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 100)
    }
    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  function setDrawerOpen(next) {
    setDrawerOpenState(next)
    if (onDrawerOpenChange) onDrawerOpenChange(next)
  }

  function openHoursModal() {
    setHoursModalOpen(true)
  }

  const solidBar = scrolled || solid
  const textCls = solidBar ? 'text-gray-900' : `text-white ${HERO_SHADOW}`
  const mutedCls = solidBar ? 'text-gray-500' : `text-white/90 ${HERO_SHADOW}`
  const linkCls = `font-semibold transition-colors duration-300 hover:text-[var(--brand-color)] ${textCls}`

  return (
    <header
      className={`sticky top-0 z-30 transition-all duration-300 ${
        solidBar ? 'bg-white shadow-sm' : 'bg-transparent'
      }`}
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="max-w-[1280px] mx-auto px-4 md:px-8 py-3 md:py-4 flex items-center justify-between gap-4">
        {/* LEFT */}
        <div className="flex items-center gap-3 min-w-0">
          <span className={`font-bold text-base md:text-lg truncate transition-colors duration-300 ${textCls}`}>
            {restaurant.name}
          </span>
          <StatusPill isOpen={status.isOpen} scrolled={solidBar} />
          {/* Hours summary — desktop only. Mobile keeps just the name +
              status pill so long restaurant names fit on one line; the
              full hours are reachable via the hamburger drawer. */}
          <span className={`hidden md:inline text-sm truncate transition-colors duration-300 ${mutedCls}`}>
            {status.statusText.replace(/^OPEN\s/, '').replace(/^CLOSED · /, '')}
          </span>
        </div>

        {/* RIGHT — desktop */}
        <div className="hidden md:flex items-center gap-6 text-sm">
          {restaurant.address && (
            <span className={`truncate max-w-md transition-colors duration-300 ${mutedCls}`}>
              {formatDisplayAddress(restaurant.address)}
            </span>
          )}
          <div className="flex items-center gap-5">
            <Link to={`${base}/menu`} className={linkCls}>
              Menu
            </Link>
            {Array.isArray(restaurant.website_links) && restaurant.website_links.length > 0 &&
              restaurant.website_links.map(link => (
                <Link
                  key={link.path}
                  to={`${base}/${link.path}`}
                  className={linkCls}
                >
                  {link.label}
                </Link>
              ))}
            <button onClick={openHoursModal} className={linkCls}>
              Hours
            </button>
            {restaurant.about_section_visible !== false && (
              <a href="#about" className={linkCls}>
                About
              </a>
            )}
          </div>
        </div>

        {/* RIGHT — mobile hamburger */}
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className={`md:hidden w-10 h-10 flex items-center justify-center transition-colors duration-300 ${
            solidBar ? 'text-gray-900' : 'text-white'
          }`}
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
