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

export default function Location({ restaurant }) {
  const { street, city, state, line2 } = parseAddress(restaurant.address)
  const cityState = city && state ? `${city}, ${state}` : null
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  const mapSrc = apiKey && restaurant.address
    ? `https://www.google.com/maps/embed/v1/place?key=${apiKey}&q=${encodeURIComponent(restaurant.address)}`
    : null
  const phoneFormatted = formatPhone(restaurant.phone)
  const phoneTel = restaurant.phone ? restaurant.phone.replace(/\D/g, '') : null

  return (
    <section className="bg-white py-10 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6 md:mb-8">
          Our location
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
          <div className="rounded-2xl overflow-hidden bg-gray-100 h-[250px] md:h-[400px]">
            {mapSrc ? (
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
            ) : (
              <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
                Map unavailable
              </div>
            )}
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
