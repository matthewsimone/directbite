import { useEffect, useState } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useRestaurant } from '../../hooks/useRestaurant'
import { usePromotion } from '../../hooks/usePromotion'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import PromoBar from './components/PromoBar'
import TopBar from './components/TopBar'
import Hero from './components/Hero'
import About from './components/About'
import FeaturedMenu from './components/FeaturedMenu'
import Gallery from './components/Gallery'
import Reviews from './components/Reviews'
import Location from './components/Location'
import Footer from './components/Footer'
import StickyMobileCTA from './components/StickyMobileCTA'
import { getStatus, formatWeekHours } from './utils/hours'
import { parseAddress } from './utils/address'
import { canonicalHost } from './utils/seoHead'
import { isMainDomain, MAIN_DOMAIN } from '../../lib/customDomain'
import { buildFaqSchema } from './utils/schema'
import { buildRestaurantFaq } from './utils/faqContent'

const SCHEMA_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function buildSchemaJsonLd(restaurant, hours) {
  const { street, city, state, zip } = parseAddress(restaurant.address)
  const canonicalUrl = restaurant.custom_domain
    ? `https://${canonicalHost(restaurant)}`
    : `https://${MAIN_DOMAIN}/${restaurant.slug}/home`
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: restaurant.name,
    description: restaurant.tagline || restaurant.about_text || '',
    image: restaurant.hero_image_url || undefined,
    telephone: restaurant.phone || undefined,
    url: canonicalUrl,
    menu: restaurant.custom_domain
      ? `https://${canonicalHost(restaurant)}/menu`
      : `https://${MAIN_DOMAIN}/${restaurant.slug}/menu`,
    priceRange: '$$',
    servesCuisine: restaurant.cuisine || 'Pizza',
  }

  if (city && state) {
    data.address = {
      '@type': 'PostalAddress',
      streetAddress: street || undefined,
      addressLocality: city,
      addressRegion: state,
      postalCode: zip || undefined,
    }
  }

  if (restaurant.latitude != null && restaurant.longitude != null) {
    data.geo = {
      '@type': 'GeoCoordinates',
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
    }
  }

  const openHours = (hours || [])
    .filter(h => h.is_open && h.open_time && h.close_time)
    .map(h => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: SCHEMA_DAY_NAMES[h.day_of_week],
      opens: h.open_time.slice(0, 5),
      closes: h.close_time.slice(0, 5),
    }))
  if (openHours.length > 0) data.openingHoursSpecification = openHours

  const sameAs = [restaurant.instagram_url, restaurant.facebook_url].filter(Boolean)
  if (sameAs.length > 0) data.sameAs = sameAs

  return data
}

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function HomePage({ restaurant: propRestaurant, hours: propHours }) {
  // Custom domain context: parent (CustomDomainShell) provides restaurant + hours.
  // Main domain context: read slug from URL and fetch via useRestaurant.
  const { slug: paramSlug } = useParams()
  const hook = useRestaurant(propRestaurant ? null : paramSlug)
  const restaurant = propRestaurant || hook.restaurant
  const hours = propHours || hook.hours
  const loading = propRestaurant ? false : hook.loading
  const error = propRestaurant ? null : hook.error
  const { promotion } = usePromotion(restaurant?.id)
  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Recompute open/closed every 60s so the banner stays current.
  useEffect(() => {
    function tick() {
      setStatus(getStatus(hours, new Date()))
    }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  // iOS Safari bfcache + hash-nav viewport recomputation fix.
  // After bfcache restore (back-nav from a custom-domain "Order Online"
  // jump to directbite.co) or hash-nav return (back from "#about"),
  // env(safe-area-inset-top) is sometimes computed against stale
  // viewport metrics, which clips PromoBar under the notch. Reading a
  // layout property forces iOS to re-measure. Listen unconditionally
  // (not gated on event.persisted) since hash-nav back doesn't mark the
  // event as persisted but exhibits the same symptom.
  useEffect(() => {
    function forceReflow() {
      // eslint-disable-next-line no-unused-expressions
      document.body.offsetHeight
    }
    window.addEventListener('pageshow', forceReflow)
    return () => window.removeEventListener('pageshow', forceReflow)
  }, [])

  // Swap document title, PWA app-name meta tags, favicon, and manifest
  // hrefs to the restaurant's per-domain API endpoints. Restored on
  // unmount so admin/tablet/landing keep DirectBite defaults.
  useRestaurantBranding(restaurant, 'website')

  // Website add-on not enabled — bounce to ordering page. Cross-origin
  // when on a custom domain (Navigate would stay on the wrong host).
  useEffect(() => {
    if (!restaurant) return
    if (restaurant.website_enabled) return
    if (!isMainDomain()) {
      window.location.replace(`https://${MAIN_DOMAIN}/${restaurant.slug}`)
    }
  }, [restaurant])

  if (loading) {
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

  // Website add-on not enabled — main-domain SPA redirect.
  if (!restaurant.website_enabled && isMainDomain()) {
    return <Navigate to={`/${restaurant.slug}`} replace />
  }
  // Custom domain + disabled: render nothing while window.location.replace runs above.
  if (!restaurant.website_enabled) return null

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR

  const galleryUrls = restaurant.gallery_urls || []
  const reviews = restaurant.reviews || []
  const schemaData = buildSchemaJsonLd(restaurant, hours)
  const faqData = buildFaqSchema(
    buildRestaurantFaq(restaurant, {
      hoursText: formatWeekHours(hours),
      categoriesText: '',
    })
  )

  return (
    <div
      className="min-h-dvh bg-white pb-32 md:pb-0"
      style={{ '--brand-color': brandColor }}
    >
      <PromoBar promotion={promotion} />
      <TopBar restaurant={restaurant} status={status} hours={hours} onDrawerOpenChange={setDrawerOpen} />
      <Hero restaurant={restaurant} />
      {restaurant.featured_menu_section_visible && (
        <FeaturedMenu restaurant={restaurant} />
      )}
      {restaurant.about_section_visible && restaurant.about_text && (
        <About restaurant={restaurant} />
      )}
      {restaurant.gallery_section_visible && galleryUrls.length > 0 && (
        <Gallery urls={galleryUrls} />
      )}
      {restaurant.reviews_section_visible && reviews.length > 0 && (
        <Reviews reviews={reviews} />
      )}
      <Location restaurant={restaurant} />
      <Footer restaurant={restaurant} hours={hours} />
      {!drawerOpen && <StickyMobileCTA restaurant={restaurant} />}

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemaData) }}
      />
      {faqData && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqData).replace(/</g, '\\u003c') }}
        />
      )}
    </div>
  )
}
