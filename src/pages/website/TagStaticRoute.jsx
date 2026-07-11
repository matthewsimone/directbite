import { useEffect } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useMenu } from '../../hooks/useMenu'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import { isMainDomain, MAIN_DOMAIN } from '../../lib/customDomain'
import TagStatic from './TagStatic'
import TAG_KEYWORDS from '../../data/tag-keywords.json'
import { resolveGeneratedTags, siblingTagsFor, withItemSizes } from './utils/tagMatch'

// Client-side wrapper for /{slug}/tags/{tagSlug} (in-app nav). Mirrors
// PlaceStaticRoute's prop-vs-fetch seam, then feeds the pure TagStatic.
// The prerendered dist/{slug}/tags/{tagSlug}/index.html is the crawler /
// direct-hit path; both render the same TagStatic. Tag membership + item
// sets come from the SAME tagMatch.js the prerender uses, so they can't
// drift.
export default function TagStaticRoute({ restaurant: propRestaurant, hours: propHours }) {
  const { slug: paramSlug, tagSlug } = useParams()
  const hook = useRestaurant(propRestaurant ? null : paramSlug)
  const restaurant = propRestaurant || hook.restaurant
  const hours = propHours || hook.hours
  const loading = propRestaurant ? false : hook.loading
  const error = propRestaurant ? null : hook.error

  const { categories, items, getSizesForItem, loading: menuLoading } = useMenu(restaurant?.id)

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
          <p className="mt-2 text-sm text-gray-500">We couldn’t find a restaurant for this page.</p>
        </div>
      </div>
    )
  }

  if (!restaurant.website_enabled && isMainDomain()) {
    return <Navigate to={`/${restaurant.slug}`} replace />
  }
  if (!restaurant.website_enabled) return null

  // ---- Tag resolution via the SHARED matcher (same as prerender) ----
  const generated = resolveGeneratedTags({
    allowlist: TAG_KEYWORDS.tags,
    categories,
    items,
  })
  const current = generated.find((g) => g.def.slug === tagSlug)

  // 404: this tag doesn't generate for this restaurant (not in allowlist,
  // or fails the >=3 gate). Never render an empty tag page.
  if (!current) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Menu page not found</h1>
          <p className="mt-2 text-sm text-gray-500">We don’t have a page for this yet.</p>
          <a href={`/${restaurant.slug}`} className="mt-4 inline-block font-semibold text-[#16A34A] hover:underline">
            Back to {restaurant.name} →
          </a>
        </div>
      </div>
    )
  }

  const siblingTags = siblingTagsFor(generated, tagSlug)
  const tagItems = withItemSizes(current.items, getSizesForItem)

  return (
    <TagStatic
      restaurant={restaurant}
      hours={hours}
      tag={{ slug: current.def.slug, label: current.def.label }}
      siblingTags={siblingTags}
      tagItems={tagItems}
    />
  )
}
