import { useEffect, useRef, useState } from 'react'
import { parseAddress, formatDisplayAddress } from '../utils/address'

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

export default function Location({ restaurant, title = 'Our location', subtext }) {
  const { street, city, state, line2 } = parseAddress(restaurant.address)
  const cityState = city && state ? `${city}, ${state}` : null
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  const mapSrc = apiKey && restaurant.address
    ? `https://www.google.com/maps/embed/v1/place?key=${apiKey}&q=${encodeURIComponent(restaurant.address)}`
    : null
  const phoneFormatted = formatPhone(restaurant.phone)
  const phoneTel = restaurant.phone ? restaurant.phone.replace(/\D/g, '') : null

  // Defer the Maps iframe until the section approaches the viewport. The
  // embed pulls ~390 KiB and ~300ms of main-thread work — not worth paying
  // for users who never scroll past Reviews. `loading="lazy"` alone is a
  // hint the browser ignores in practice (PSI's Lighthouse fetches it
  // anyway), so we gate render on IntersectionObserver instead.
  const mapContainerRef = useRef(null)
  const [shouldLoadMap, setShouldLoadMap] = useState(false)

  useEffect(() => {
    if (!mapSrc || shouldLoadMap) return
    const node = mapContainerRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoadMap(true)
      return
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoadMap(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px 0px' }
    )
    io.observe(node)
    return () => io.disconnect()
  }, [mapSrc, shouldLoadMap])

  return (
    <section className="bg-white py-10 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <h2 className={`text-3xl md:text-4xl font-bold text-gray-900 ${subtext ? 'mb-2' : 'mb-6 md:mb-8'}`}>
          {title}
        </h2>
        {subtext && (
          <p className="text-base text-gray-600 mb-6 md:mb-8 max-w-2xl">{subtext}</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
          <div
            ref={mapContainerRef}
            className="rounded-2xl overflow-hidden bg-gray-100 h-[250px] md:h-[400px]"
          >
            {mapSrc && shouldLoadMap ? (
              <iframe
                title={`Map of ${restaurant.name}`}
                src={mapSrc}
                width="100%"
                height="100%"
                frameBorder="0"
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            ) : !mapSrc ? (
              <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
                Map unavailable
              </div>
            ) : null}
          </div>

          <div className="space-y-6 md:py-2">
            <div>
              <p className="text-xl md:text-2xl font-bold text-gray-900">{restaurant.name}</p>
              {cityState && (
                <p className="text-base text-gray-600 mt-1">{cityState}</p>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Address</h3>
              {street ? (
                <>
                  <p className="text-base text-gray-800">{street}</p>
                  {line2 && <p className="text-base text-gray-800">{line2}</p>}
                </>
              ) : (
                <p className="text-base text-gray-800">{formatDisplayAddress(restaurant.address) || '—'}</p>
              )}
            </div>

            {phoneFormatted && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Contacts</h3>
                <a
                  href={`tel:${phoneTel}`}
                  className="text-base font-medium hover:underline"
                  style={{ color: 'var(--brand-color)' }}
                >
                  {phoneFormatted}
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
