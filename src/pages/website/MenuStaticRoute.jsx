import { useEffect } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useMenu } from '../../hooks/useMenu'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import { isMainDomain, MAIN_DOMAIN } from '../../lib/customDomain'
import MenuStatic from './MenuStatic'

// Data-fetching wrapper for the /{slug}/menu CLIENT route (in-app navigation
// from the website "Menu" link). Mirrors HomePage's prop-vs-fetch seam, then
// feeds the pure, prerender-safe MenuStatic. The prerendered
// dist/{slug}/menu/index.html stays the crawler / direct-hit path; both render
// the same MenuStatic component.
export default function MenuStaticRoute({ restaurant: propRestaurant, hours: propHours }) {
  // Custom-domain context: parent passes restaurant/hours. Main domain: read
  // slug from the URL and fetch via useRestaurant (same seam as HomePage).
  const { slug: paramSlug } = useParams()
  const hook = useRestaurant(propRestaurant ? null : paramSlug)
  const restaurant = propRestaurant || hook.restaurant
  const hours = propHours || hook.hours
  const loading = propRestaurant ? false : hook.loading
  const error = propRestaurant ? null : hook.error
  const failed = propRestaurant ? false : hook.failed

  // Client-side menu fetch — same hook the ordering page uses, so lowestPrices
  // is computed by the exact getLowestPrice the build-time replica mirrors.
  const { categories, items, loading: menuLoading, failed: menuFailed, retry: menuRetry, getLowestPrice } = useMenu(restaurant?.id)

  // Per-domain tab branding + manifest (website context), like HomePage.
  useRestaurantBranding(restaurant, 'website')

  // Website add-on not enabled — bounce to ordering. Cross-origin on a custom
  // domain (Navigate would stay on the wrong host).
  useEffect(() => {
    if (!restaurant) return
    if (restaurant.website_enabled) return
    if (!isMainDomain()) {
      window.location.replace(`https://${MAIN_DOMAIN}/${restaurant.slug}`)
    }
  }, [restaurant])

  // Network stall hit the 10s hard deadline — offer a retry instead of an
  // endless spinner. Takes priority over the loading spinner below.
  if (failed || menuFailed) {
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

  if (loading || menuLoading) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Website add-on not enabled — main-domain SPA redirect.
  if (!restaurant.website_enabled && isMainDomain()) {
    return <Navigate to={`/${restaurant.slug}`} replace />
  }
  // Custom domain + disabled: render nothing while the replace above runs.
  if (!restaurant.website_enabled) return null

  const lowestPrices = {}
  for (const item of items) {
    lowestPrices[item.id] = getLowestPrice(item.id)
  }

  return (
    <MenuStatic
      restaurant={restaurant}
      hours={hours}
      categories={categories}
      items={items}
      lowestPrices={lowestPrices}
    />
  )
}
