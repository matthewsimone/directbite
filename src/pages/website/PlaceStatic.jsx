// Prerender-safe static /{slug}/places/{town} SEO landing page.
//
// Prop-fed, same discipline as MenuStatic: no cart, no ItemModal, no
// useMenu/scroll-spy, and no window/document/localStorage anywhere — fully
// window-free (Featured is the shared FeaturedGrid, whose cards are OrderLink
// <a> tags, not click handlers). No JSON-LD here — the prerender injects it.
//
// TopBar's open/closed status uses the identical hydration-safe placeholder +
// effect-tick pattern as MenuStatic/HomePage.

import { useState, useEffect } from 'react'
import TopBar from './components/TopBar'
import Footer from './components/Footer'
import Location from './components/Location'
import Hero from './components/Hero'
import { FeaturedGrid } from './components/FeaturedMenu'
import PromoBar from './components/PromoBar'
import StickyMobileCTA from './components/StickyMobileCTA'
import { usePromotion } from '../../hooks/usePromotion'
import { getStatus } from './utils/hours'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function PlaceStatic({ restaurant, hours, town, siblingTowns, categories, items, lowestPrices, featuredItems }) {
  const slug = restaurant.slug
  const cuisine = restaurant.cuisine || 'Pizza'

  // Honest framing: only claim "delivery to {town}" when the town falls inside
  // the restaurant's configured in-house delivery radius. Otherwise use "near"
  // language — which is also the default when no radius is set (boundary = 0).
  const deliveryBoundary = Number(restaurant.delivery_max_radius_miles) || 0
  const delivers = town.distanceMiles != null && town.distanceMiles <= deliveryBoundary

  // Hydration-safe open/closed status (server + first client render emit the
  // static CLOSED placeholder; the live value settles on the post-hydrate tick).
  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })
  useEffect(() => {
    function tick() { setStatus(getStatus(hours || [], new Date())) }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  // Promo banner — async/effect-based hook (initial null). During renderToString
  // the effect doesn't run → promotion stays null → PromoBar renders nothing, so
  // no time-sensitive promo is baked into the static file. The live promo appears
  // client-side post-hydrate (hydration-safe: server + first client render match).
  const { promotion } = usePromotion(restaurant?.id)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR

  const siblings = (siblingTowns || []).slice(0, 15)

  return (
    <div className="min-h-dvh bg-white pb-32 md:pb-0" style={{ '--brand-color': brandColor }}>
      <PromoBar promotion={promotion} />
      <TopBar restaurant={restaurant} status={status} hours={hours} onDrawerOpenChange={setDrawerOpen} />

      {/* 2. Branded hero — photo background + keyword copy (matches homepage) */}
      <Hero
        restaurant={restaurant}
        eyebrow={delivers ? `Best ${cuisine} around ${town.name}, NJ` : `Best ${cuisine} near ${town.name}, NJ`}
        title={delivers ? `${cuisine} Delivery to ${town.name}` : `Best ${cuisine} near ${town.name}`}
        subtitle={restaurant.tagline || null}
      />

      {/* 3. Featured — homepage-style image carousel (shared FeaturedGrid) */}
      <FeaturedGrid items={featuredItems} slug={restaurant.slug} />

      {/* 4. About — town in the first sentence */}
      <section className="max-w-[1100px] mx-auto px-6 sm:px-8 pb-10">
        <p className="text-base text-gray-700 leading-relaxed">
          {delivers
            ? `Craving ${cuisine} in ${town.name}? ${restaurant.name} delivers to ${town.name} and the surrounding ${town.county} County area — hand-made, fresh daily, ready when you are.`
            : `Looking for great ${cuisine} near ${town.name}? ${restaurant.name} serves the ${town.name} area — order online for pickup or delivery, made fresh daily.`}
        </p>
      </section>

      {/* 5. Map — reuse Location with localized title/subtext */}
      <Location
        restaurant={restaurant}
        title={delivers ? `Craving ${cuisine}? Order pickup or delivery now!` : `Craving ${cuisine}? Order online now!`}
        subtext={delivers
          ? `We deliver to ${town.name}! Order online for pickup or delivery.`
          : `Serving the ${town.name} area. Order online for pickup, or check if delivery reaches you.`}
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

      {!drawerOpen && <StickyMobileCTA restaurant={restaurant} />}

      <Footer restaurant={restaurant} hours={hours} />
    </div>
  )
}
