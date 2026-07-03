// Prerender-safe static /{slug}/places/{town} SEO landing page.
//
// Prop-fed, same discipline as MenuStatic: no cart, no ItemModal, no
// useMenu/scroll-spy, and no window/document/localStorage AT RENDER TIME (the
// only window ref is inside a Featured-item click handler, never invoked during
// renderToString). No JSON-LD here — the prerender script injects it separately.
//
// TopBar's open/closed status uses the identical hydration-safe placeholder +
// effect-tick pattern as MenuStatic/HomePage.

import { useState, useEffect } from 'react'
import MenuItemCard from '../../components/MenuItemCard'
import TopBar from './components/TopBar'
import Footer from './components/Footer'
import Location from './components/Location'
import { getStatus } from './utils/hours'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function PlacePage({ restaurant, hours, town, siblingTowns, categories, items, lowestPrices }) {
  const slug = restaurant.slug
  const cuisine = restaurant.cuisine || 'Pizza'

  // Hydration-safe open/closed status (server + first client render emit the
  // static CLOSED placeholder; the live value settles on the post-hydrate tick).
  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })
  useEffect(() => {
    function tick() { setStatus(getStatus(hours || [], new Date())) }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR

  // First 6 items, ordered by category sort_order then item sort_order. Sorted
  // here (not relying on fetch order) so the component stays purely prop-fed.
  const catOrder = new Map((categories || []).map((c) => [c.id, c.sort_order ?? 0]))
  const showItems = [...(items || [])]
    .sort((a, b) => {
      const ca = catOrder.get(a.category_id) ?? 0
      const cb = catOrder.get(b.category_id) ?? 0
      if (ca !== cb) return ca - cb
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
    .slice(0, 6)

  const siblings = (siblingTowns || []).slice(0, 15)

  return (
    <div className="min-h-dvh bg-white" style={{ '--brand-color': brandColor }}>
      <TopBar restaurant={restaurant} status={status} hours={hours} solid />

      {/* 2. Keyword hero — text-only, soft background */}
      <section className="bg-gray-50 border-b border-gray-200">
        <div className="max-w-[1100px] mx-auto px-6 sm:px-8 py-12">
          <p className="text-sm font-semibold uppercase tracking-wide text-[#16A34A]">
            Best {cuisine} around {town.name}, NJ
          </p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-extrabold text-gray-900">
            {cuisine} Delivery to {town.name}
          </h1>
          <a
            href={`/${slug}`}
            className="mt-5 inline-flex items-center h-11 px-6 rounded-xl bg-[#16A34A] text-white font-semibold hover:bg-[#15803D] transition-colors"
          >
            Order Online
          </a>
        </div>
      </section>

      {/* 3. Featured items — first 6 */}
      {showItems.length > 0 && (
        <section className="max-w-[1100px] mx-auto px-6 sm:px-8 py-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3">Featured</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {showItems.map((item) => (
              <MenuItemCard
                key={item.id}
                item={item}
                lowestPrice={lowestPrices[item.id]}
                onClick={() => {
                  window.location.href = `/${slug}?item=${item.id}`
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* 4. About — town in the first sentence */}
      <section className="max-w-[1100px] mx-auto px-6 sm:px-8 pb-10">
        <p className="text-base text-gray-700 leading-relaxed">
          Craving {cuisine} in {town.name}? {restaurant.name} delivers to {town.name} and
          surrounding {town.county} County — hand-made, fresh daily, ready when you are.
        </p>
      </section>

      {/* 5. Map — reuse Location with localized title/subtext */}
      <Location
        restaurant={restaurant}
        title={`Craving ${cuisine}? Order pickup or delivery now!`}
        subtext={`We offer pickup and delivery to ${town.name}! Get ${cuisine} delivered in ~30 mins.`}
      />

      {/* 6. Internal link hub — nearby sibling towns (per-restaurant scope) */}
      {siblings.length > 0 && (
        <section className="max-w-[1100px] mx-auto px-6 sm:px-8 py-10">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Also serving nearby</h2>
          <div className="flex flex-wrap gap-2">
            {siblings.map((s) => (
              <a
                key={s.slug}
                href={`/${slug}/places/${s.slug}`}
                className="inline-flex items-center px-3 py-1.5 rounded-full bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
              >
                {cuisine} in {s.name}
              </a>
            ))}
          </div>
        </section>
      )}

      <Footer restaurant={restaurant} hours={hours} />
    </div>
  )
}
