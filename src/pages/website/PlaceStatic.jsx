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
import FaqSection from './components/FaqSection'
import { usePromotion } from '../../hooks/usePromotion'
import { getStatus, formatWeekHours } from './utils/hours'
import { parseAddress } from './utils/address'
import { buildRestaurantFaq } from './utils/faqContent'
import { buildFaqSchema } from './utils/schema'
import { isMainDomain } from '../../lib/customDomain'
import { useLinkBase } from './LinkBaseContext'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function PlaceStatic({ restaurant, hours, town, siblingTowns, featuredItems, tagLinks }) {
  const slug = restaurant.slug
  const cuisine = restaurant.cuisine || 'Pizza'
  const linkBase = useLinkBase()
  const base = linkBase !== null ? linkBase : (isMainDomain() ? `/${slug}` : '')

  // Honest framing: only claim "delivery to {town}" when the town falls inside
  // the restaurant's configured in-house delivery radius. Otherwise use "near"
  // language — which is also the default when no radius is set (boundary = 0).
  const deliveryBoundary = Number(restaurant.delivery_max_radius_miles) || 0
  const delivers = town.distanceMiles != null && town.distanceMiles <= deliveryBoundary

  // Home town: this page IS the restaurant's own town. Derive the home slug the
  // SAME way the prerender does (parsed address city → slug) and compare to the
  // page's town. Framing priority: home > delivers > near (mirrors placeSeo).
  const { city: ownCity } = parseAddress(restaurant.address)
  const ownCitySlug = (ownCity || '').toLowerCase().replace(/\s+/g, '-')
  const isHome = town.slug === ownCitySlug

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

  // The FAQ carries the sibling-town links that used to live in a chip block,
  // and the schema below is built from the SAME qas array the section renders —
  // visible text and JSON-LD cannot drift apart.
  const townLinks = siblings.map((s) => ({
    label: s.name,
    href: `${base}/places/${s.slug}`,
  }))
  const faqQas = buildRestaurantFaq(restaurant, {
    hoursText: formatWeekHours(hours),
    town,
    delivers,
    tagLinks,
    townLinks,
  })
  const faqData = buildFaqSchema(faqQas)

  return (
    <div className="min-h-dvh bg-white pb-32 md:pb-0" style={{ '--brand-color': brandColor }}>
      <PromoBar promotion={promotion} />
      <TopBar restaurant={restaurant} status={status} hours={hours} onDrawerOpenChange={setDrawerOpen} />

      {/* 2. Branded hero — photo background + keyword copy (matches homepage) */}
      <Hero
        restaurant={restaurant}
        eyebrow={
          isHome ? `Your local ${cuisine} in ${town.name}, NJ`
          : delivers ? `Best ${cuisine} around ${town.name}, NJ`
          : `Best ${cuisine} near ${town.name}, NJ`
        }
        title={
          isHome ? `Best ${cuisine} in ${town.name}`
          : delivers ? `${cuisine} Delivery to ${town.name}`
          : `Best ${cuisine} near ${town.name}`
        }
      />

      {/* 3. Featured — homepage-style image carousel (shared FeaturedGrid) */}
      <FeaturedGrid items={featuredItems} slug={restaurant.slug} />

      {/* 4. About — town in the first sentence */}
      <section className="max-w-[1100px] mx-auto px-6 sm:px-8 pt-8 pb-10">
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

      {/* 6. FAQ — visible Q&A that also carries the sibling-town links
          (replaces the old "Also serving nearby" chip block). Backs the
          FAQPage JSON-LD emitted at the end of this component. */}
      <FaqSection qas={faqQas} />

      {!drawerOpen && <StickyMobileCTA restaurant={restaurant} />}

      <Footer restaurant={restaurant} hours={hours} />

      {faqData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqData).replace(/</g, '\\u003c') }}
        />
      )}
    </div>
  )
}
