import { Fragment } from 'react'
import DirectBiteLogo from '../../../components/DirectBiteLogo'
import OrderLink from './OrderLink'
import { formatTime } from '../utils/hours'
import { formatDisplayAddress } from '../utils/address'

const DAY_ROWS = [
  { idx: 1, label: 'Mon' },
  { idx: 2, label: 'Tue' },
  { idx: 3, label: 'Wed' },
  { idx: 4, label: 'Thu' },
  { idx: 5, label: 'Fri' },
  { idx: 6, label: 'Sat' },
  { idx: 0, label: 'Sun' },
]

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

function InstagramIcon() {
  return (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.336 3.608 1.311.975.975 1.249 2.242 1.311 3.608.058 1.265.069 1.645.069 4.849s-.011 3.584-.069 4.849c-.062 1.366-.336 2.633-1.311 3.608-.975.975-2.242 1.249-3.608 1.311-1.265.058-1.645.069-4.85.069s-3.584-.011-4.849-.069c-1.366-.062-2.633-.336-3.608-1.311-.975-.975-1.249-2.242-1.311-3.608C2.175 15.747 2.163 15.367 2.163 12s.012-3.584.07-4.849c.062-1.366.336-2.633 1.311-3.608C4.519 2.568 5.786 2.295 7.152 2.233 8.417 2.175 8.797 2.163 12 2.163zM12 0C8.741 0 8.332.014 7.052.072 5.775.13 4.602.397 3.625 1.374c-.977.977-1.244 2.15-1.302 3.428C2.265 6.082 2.25 6.491 2.25 9.75v4.5c0 3.259.014 3.668.072 4.948.058 1.277.325 2.45 1.302 3.427.977.977 2.15 1.244 3.428 1.302C8.332 23.986 8.741 24 12 24s3.668-.014 4.948-.072c1.278-.058 2.451-.325 3.428-1.302.977-.977 1.244-2.15 1.302-3.428.058-1.28.072-1.689.072-4.948V9.75c0-3.259-.014-3.668-.072-4.948-.058-1.278-.325-2.451-1.302-3.428C19.4.397 18.227.13 16.948.072 15.668.014 15.259 0 12 0z"/>
      <path d="M12 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zM18.406 4.155a1.44 1.44 0 11-2.881 0 1.44 1.44 0 012.881 0z"/>
    </svg>
  )
}

function FacebookIcon() {
  return (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  )
}

function HoursList({ hours }) {
  const today = new Date().getDay()
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-0.5 text-sm leading-tight">
      {DAY_ROWS.map(({ idx, label }) => {
        const h = (hours || []).find(hr => hr.day_of_week === idx)
        const closed = !h?.is_open || !h.open_time || !h.close_time
        const isToday = idx === today
        const tone = isToday ? 'font-bold text-green-700' : 'text-gray-600'
        return (
          <Fragment key={idx}>
            <span className={tone}>{label}</span>
            <span className={tone}>
              {closed ? 'Closed' : `${formatTime(h.open_time)}-${formatTime(h.close_time)}`}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

export default function Footer({ restaurant, hours }) {
  const phoneFormatted = formatPhone(restaurant.phone)
  const phoneTel = restaurant.phone ? restaurant.phone.replace(/\D/g, '') : null
  const year = new Date().getFullYear()

  return (
    <footer className="bg-gray-50 border-t border-gray-200 py-12 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          {/* NAP */}
          <div>
            <p className="font-bold text-lg text-gray-900">{restaurant.name}</p>
            {restaurant.address && (
              <p className="mt-2 text-sm text-gray-600 whitespace-pre-line">{formatDisplayAddress(restaurant.address)}</p>
            )}
            {phoneFormatted && (
              <a
                href={`tel:${phoneTel}`}
                className="mt-2 inline-block text-sm font-medium hover:underline"
                style={{ color: 'var(--brand-color)' }}
              >
                {phoneFormatted}
              </a>
            )}
          </div>

          {/* Hours — centered on mobile so day/time pair sits as a group;
              left-aligned on desktop to match the surrounding columns. */}
          <div className="flex flex-col items-center md:items-start">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Hours</h3>
            <HoursList hours={hours} />
          </div>

          {/* Social + CTA */}
          <div className="flex flex-col md:items-end">
            {(restaurant.instagram_url || restaurant.facebook_url) && (
              <div className="flex items-center gap-4 mb-5 text-gray-700">
                {restaurant.instagram_url && (
                  <a href={restaurant.instagram_url} target="_blank" rel="noopener noreferrer" aria-label="Instagram"
                    className="hover:opacity-80">
                    <InstagramIcon />
                  </a>
                )}
                {restaurant.facebook_url && (
                  <a href={restaurant.facebook_url} target="_blank" rel="noopener noreferrer" aria-label="Facebook"
                    className="hover:opacity-80">
                    <FacebookIcon />
                  </a>
                )}
              </div>
            )}
            <OrderLink
              slug={restaurant.slug}
              className="inline-block w-full md:w-auto text-center px-7 py-3 rounded-full font-semibold text-white hover:opacity-90 transition-opacity"
              style={{ backgroundColor: 'var(--brand-color)' }}
            >
              Order Online
            </OrderLink>
          </div>
        </div>

        <div className="border-t border-gray-200 mt-12 pt-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4 text-sm text-gray-500">
          <p>© {year} {restaurant.name}. All rights reserved.</p>
          <div className="flex flex-col items-start md:items-end gap-1">
            <span className="text-xs">Powered by:</span>
            <DirectBiteLogo color="dark" height={20} />
          </div>
        </div>
      </div>
    </footer>
  )
}
