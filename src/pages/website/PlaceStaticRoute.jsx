import { useEffect } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useMenu } from '../../hooks/useMenu'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import { isMainDomain, MAIN_DOMAIN } from '../../lib/customDomain'
import { MAX_RADIUS_MILES, haversineMiles, findNearestTowns } from '../../lib/geoTowns'
import { parseAddress } from './utils/address'
import PlaceStatic from './PlaceStatic'
import NJ_TOWNS from '../../data/nj-towns.json'

const SIBLING_LIMIT = 12

const slugify = (s) => (s || '').toLowerCase().replace(/\s+/g, '-')

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

  const { categories, items, loading: menuLoading, getLowestPrice } = useMenu(restaurant?.id)

  useRestaurantBranding(restaurant, 'website')

  // Website add-on not enabled — bounce to ordering (cross-origin on a custom domain).
  useEffect(() => {
    if (!restaurant) return
    if (restaurant.website_enabled) return
    if (!isMainDomain()) {
      window.location.replace(`https://${MAIN_DOMAIN}/${restaurant.slug}`)
    }
  }, [restaurant])

  if (loading || menuLoading) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !restaurant) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Restaurant not found</h1>
          <p className="mt-2 text-sm text-gray-500">{error || 'No restaurant matches this URL.'}</p>
        </div>
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

  const lowestPrices = {}
  for (const item of items) {
    lowestPrices[item.id] = getLowestPrice(item.id)
  }

  return (
    <PlaceStatic
      restaurant={restaurant}
      hours={hours}
      town={{ ...town, distanceMiles: Number.isFinite(townDistance) ? Math.round(townDistance * 100) / 100 : null }}
      siblingTowns={siblingTowns}
      categories={categories}
      items={items}
      lowestPrices={lowestPrices}
    />
  )
}
