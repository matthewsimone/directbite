import { useEffect, useState } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useMenu } from '../../hooks/useMenu'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import { isMainDomain, MAIN_DOMAIN } from '../../lib/customDomain'
import { MAX_RADIUS_MILES, haversineMiles, findNearestTowns } from '../../lib/geoTowns'
import { parseAddress } from './utils/address'
import { resolveGeneratedTags } from './utils/tagMatch'
import { useLinkBase } from './LinkBaseContext'
import PlaceStatic from './PlaceStatic'
import NJ_TOWNS from '../../data/nj-towns.json'
import TAG_KEYWORDS from '../../data/tag-keywords.json'

const SIBLING_LIMIT = 12

const slugify = (s) => (s || '').toLowerCase().replace(/\s+/g, '-')

// Tag links the prerender embedded in <head> — same payload and slug gate as
// HomePage's copy. Covers the window before useMenu resolves, so the FAQ's
// /tags anchors survive hydration instead of blinking out. Guarded for
// renderToString, which has no document.
function readFaqLinks(slug) {
  if (typeof document === 'undefined') return {}
  const el = document.getElementById('faq-links')
  if (!el) return {}
  try {
    const data = JSON.parse(el.textContent) || {}
    return data.slug === slug ? data : {}
  } catch { return {} }
}

// Client-side wrapper for the /{slug}/places/{townSlug} route (in-app nav).
// Mirrors MenuStaticRoute's prop-vs-fetch seam, then feeds the pure PlaceStatic.
// The prerendered dist/{slug}/places/{townSlug}/index.html is the crawler /
// direct-hit path; both render the same PlaceStatic component.
export default function PlaceStaticRoute({ restaurant: propRestaurant, hours: propHours }) {
  const { slug: paramSlug, townSlug } = useParams()
  const hook = useRestaurant(propRestaurant ? null : paramSlug)
  const restaurant = propRestaurant || hook.restaurant
  const hours = propHours || hook.hours
  const loading = propRestaurant ? false : hook.loading
  const error = propRestaurant ? null : hook.error
  const failed = propRestaurant ? false : hook.failed

  const { categories, items, loading: menuLoading, failed: menuFailed, retry: menuRetry } = useMenu(restaurant?.id)

  // Same link prefix PlaceStatic derives internally, so the FAQ's /tags hrefs
  // match the prerendered ones on both custom domains and directbite.co.
  const linkBase = useLinkBase()

  useRestaurantBranding(restaurant, 'website')

  // Featured items for the Featured carousel — a dedicated fetch (useMenu's
  // items don't carry item_sizes nested, which the card needs for pricing).
  // Matches the homepage FeaturedMenu query exactly so both render identically.
  const [featuredItems, setFeaturedItems] = useState([])
  useEffect(() => {
    if (!restaurant?.id) return
    let cancelled = false
    async function fetchFeatured() {
      const { data } = await supabase
        .from('menu_items')
        .select('*, item_sizes(*)')
        .eq('restaurant_id', restaurant.id)
        .eq('featured_on_website', true)
        .order('featured_order')
        .limit(8)
      if (!cancelled) setFeaturedItems((data || []).filter((i) => i.image_url))
    }
    fetchFeatured()
    return () => { cancelled = true }
  }, [restaurant?.id])

  // Website add-on not enabled — bounce to ordering (cross-origin on a custom domain).
  useEffect(() => {
    if (!restaurant) return
    if (restaurant.website_enabled) return
    if (!isMainDomain()) {
      window.location.replace(`https://${MAIN_DOMAIN}/${restaurant.slug}`)
    }
  }, [restaurant])

  // Network stall hit the 10s hard deadline — offer a retry instead of an
  // endless spinner. Takes priority over the loading spinner below.
  // menuFailed is deliberately NOT included: place pages don't depend on menu
  // data (it feeds only the FAQ's tag links, which fall back to the embedded
  // payload), so a menu timeout must not replace a page that can render.
  if (failed) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Couldn't load</h1>
          <p className="mt-2 text-sm text-gray-500">Your connection looks unstable.</p>
          <button onClick={() => { hook.retry?.(); menuRetry?.() }} className="mt-4 h-11 px-5 rounded-xl bg-[#16A34A] text-white font-semibold">
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Definitive not-found — hoisted ABOVE the spinner. A restaurant fetch ERROR
  // leaves restaurant null, and useMenu(undefined) early-returns with menuLoading
  // stuck true; without this above the spinner the page would strand forever.
  if (error || (!loading && !restaurant)) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Restaurant not found</h1>
          <p className="mt-2 text-sm text-gray-500">{error || 'No restaurant matches this URL.'}</p>
        </div>
      </div>
    )
  }

  // Menu data feeds ONLY the FAQ's tag links (and those fall back to the
  // embedded payload below), so this page never waits on useMenu — gating on
  // menuLoading would replace the prerendered page with a spinner on hydrate.
  if (loading) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!restaurant.website_enabled && isMainDomain()) {
    return <Navigate to={`/${restaurant.slug}`} replace />
  }
  if (!restaurant.website_enabled) return null

  // ---- Town resolution + radius check ----
  const town = NJ_TOWNS.find((t) => t.slug === townSlug)
  const restLat = Number(restaurant.latitude)
  const restLng = Number(restaurant.longitude)
  const hasCoords = Number.isFinite(restLat) && Number.isFinite(restLng)
  const townDistance = town && hasCoords
    ? haversineMiles(restLat, restLng, town.lat, town.lng)
    : Infinity

  // 404: town slug not in the gazetteer, OR (when we have coords) out of radius.
  if (!town || (hasCoords && townDistance > MAX_RADIUS_MILES)) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Location page not found</h1>
          <p className="mt-2 text-sm text-gray-500">
            We don’t have a page for this area.
          </p>
          <a href={`/${restaurant.slug}`} className="mt-4 inline-block font-semibold text-[#16A34A] hover:underline">
            Back to {restaurant.name} →
          </a>
        </div>
      </div>
    )
  }

  // Restaurant's own town (self-exclusion) + county (tiebreaker), derived from
  // the parsed address city matched against the gazetteer.
  const ownCitySlug = slugify(parseAddress(restaurant.address).city)
  const ownCounty = NJ_TOWNS.find((t) => t.slug === ownCitySlug)?.county

  const siblingTowns = hasCoords
    ? findNearestTowns({ lat: restLat, lng: restLng, county: ownCounty }, NJ_TOWNS, { limit: 20 })
        .filter((t) => t.slug !== townSlug && t.slug !== ownCitySlug)
        .slice(0, SIBLING_LIMIT)
    : []

  // Tag links for the FAQ — resolved from the menu the same way the prerender
  // does. No seo_pages kill-switch filter here (the client has no access to
  // that table); with zero override rows both sides produce the same list.
  const base = linkBase !== null ? linkBase : (isMainDomain() ? `/${restaurant.slug}` : '')
  const generated = resolveGeneratedTags({ allowlist: TAG_KEYWORDS.tags, categories, items })
  const resolvedTagLinks = generated.map((g) => ({ label: g.def.label, href: `${base}/tags/${g.def.slug}` }))
  const embedded = readFaqLinks(restaurant.slug)
  const tagLinks = resolvedTagLinks.length > 0 ? resolvedTagLinks : (embedded.tagLinks || [])

  return (
    <PlaceStatic
      restaurant={restaurant}
      hours={hours}
      town={{ ...town, distanceMiles: Number.isFinite(townDistance) ? Math.round(townDistance * 100) / 100 : null }}
      siblingTowns={siblingTowns}
      featuredItems={featuredItems}
      tagLinks={tagLinks}
    />
  )
}
