// Prerender-safe static /{slug}/tags/{tag} SEO landing page.
// Same discipline as PlaceStatic: no cart, no ItemModal, no useMenu,
// no window/document/localStorage — fully window-free (Featured is the
// shared FeaturedGrid whose cards are OrderLink <a> tags). No JSON-LD
// here — the prerender injects it (ItemList of the tag's items).
//
// Dish-only framing (NO town injection): tag pages own dish-intent
// queries ("{dish} near me"); /places owns location-intent ("{cuisine}
// in {town}"). Keeping them disjoint avoids self-cannibalization.
//
// TopBar open/closed status uses the identical hydration-safe
// placeholder + effect-tick pattern as PlaceStatic/MenuStatic.

import { useState, useEffect } from 'react'
import TopBar from './components/TopBar'
import Footer from './components/Footer'
import Location from './components/Location'
import Hero from './components/Hero'
import { FeaturedGrid } from './components/FeaturedMenu'
import MenuItemCard from '../../components/MenuItemCard'
import { getOrderUrl } from '../../lib/customDomain'
import PromoBar from './components/PromoBar'
import StickyMobileCTA from './components/StickyMobileCTA'
import { usePromotion } from '../../hooks/usePromotion'
import { getStatus } from './utils/hours'
import { isMainDomain } from '../../lib/customDomain'
import { useLinkBase } from './LinkBaseContext'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function TagStatic({ restaurant, hours, tag, siblingTags, tagItems }) {
  const slug = restaurant.slug
  const lowestPriceOf = (it) => {
    const s = it.item_sizes || []
    return s.length ? Math.min(...s.map((x) => Number(x.price))) : null
  }
  // Carousel shows imaged items only, bounded (the full set lives in the
  // text list below). FeaturedGrid is a visual highlight, not the content.
  const CAROUSEL_MAX = 8
  const imagedItems = (tagItems || []).filter((it) => it.image_url).slice(0, CAROUSEL_MAX)
  const linkBase = useLinkBase()
  const base = linkBase !== null ? linkBase : (isMainDomain() ? `/${slug}` : '')

  // Hydration-safe open/closed status (server + first client render emit
  // the static CLOSED placeholder; the live value settles post-hydrate).
  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })
  useEffect(() => {
    function tick() { setStatus(getStatus(hours || [], new Date())) }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  // Promo — effect-based (initial null); during renderToString the effect
  // doesn't run, so no time-sensitive promo is baked into the static file.
  const { promotion } = usePromotion(restaurant?.id)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR
  const label = tag.label
  const labelLower = label.toLowerCase()
  const siblings = (siblingTags || []).slice(0, 15)

  return (
    <div className="min-h-dvh bg-white pb-32 md:pb-0" style={{ '--brand-color': brandColor }}>
      <PromoBar promotion={promotion} />
      <TopBar restaurant={restaurant} status={status} hours={hours} onDrawerOpenChange={setDrawerOpen} />

      {/* Branded hero — dish keyword in the H1, no town injection */}
      <Hero
        restaurant={restaurant}
        eyebrow={`Fresh ${label} at ${restaurant.name}`}
        title={label}
      />

      {/* Featured — carousel of the tag's IMAGED items only (FeaturedGrid
          assumes photos). Text spine below carries the imageless items. */}
      {imagedItems.length > 0 && (
        <FeaturedGrid items={imagedItems} slug={restaurant.slug} />
      )}

      {/* About — dish keyword in the first sentence */}
      <section className="max-w-[1100px] mx-auto px-6 sm:px-8 pt-8 pb-10">
        <p className="text-base text-gray-700 leading-relaxed">
          {`Looking for ${labelLower}? ${restaurant.name} makes ${labelLower} fresh daily — order directly online for pickup or delivery.`}
        </p>
      </section>

      {/* Full item list — the content spine (indexable text: name,
          description, price). Renders regardless of photos; MenuItemCard
          shows an image only when the item has one. onClick is inert at
          prerender (React never fires handlers server-side) and wires to
          the ordering deep-link after hydration, exactly like MenuStatic. */}
      {(tagItems || []).length > 0 && (
        <section className="max-w-[1100px] mx-auto px-6 sm:px-8 pb-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {tagItems.map((item) => (
              <MenuItemCard
                key={item.id}
                item={item}
                lowestPrice={lowestPriceOf(item)}
                onClick={() => {
                  window.location.href = getOrderUrl(slug, `?item=${item.id}`)
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Map — reuse Location with dish-localized copy */}
      <Location
        restaurant={restaurant}
        title={`Craving ${labelLower}? Order online now!`}
        subtext={`Order ${labelLower} from ${restaurant.name} for pickup or delivery.`}
      />

      {/* Internal link hub — sibling tags + always a path to the full menu */}
      <section className="max-w-[1100px] mx-auto px-6 sm:px-8 py-10">
        <div className="flex items-baseline justify-between gap-4 mb-3 flex-wrap">
          <h2 className="text-lg font-bold text-gray-900">More from the menu</h2>
          <a
            href={`${base}/menu`}
            className="text-sm font-semibold hover:underline"
            style={{ color: brandColor }}
          >
            See full menu →
          </a>
        </div>
        {siblings.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {siblings.map((s) => (
              <a
                key={s.slug}
                href={`${base}/tags/${s.slug}`}
                className="inline-flex items-center px-3 py-1.5 rounded-full bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
              >
                {s.label}
              </a>
            ))}
          </div>
        )}
      </section>

      {!drawerOpen && <StickyMobileCTA restaurant={restaurant} />}
      <Footer restaurant={restaurant} hours={hours} />
    </div>
  )
}
