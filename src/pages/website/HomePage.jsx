import { useEffect, useState } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useRestaurant } from '../../hooks/useRestaurant'
import { usePromotion } from '../../hooks/usePromotion'
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
import { getStatus } from './utils/hours'
import { parseAddress } from './utils/address'
import { isMainDomain, MAIN_DOMAIN } from '../../lib/customDomain'

const SCHEMA_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Find the bounding box of non-transparent pixels in the loaded image so
// the favicon canvas can crop away built-in whitespace and render the
// logo at the largest possible size.
function getNonTransparentBounds(img) {
  const tempCanvas = document.createElement('canvas')
  tempCanvas.width = img.width
  tempCanvas.height = img.height
  const tempCtx = tempCanvas.getContext('2d')
  tempCtx.drawImage(img, 0, 0)
  const data = tempCtx.getImageData(0, 0, img.width, img.height).data

  let minX = img.width, minY = img.height, maxX = 0, maxY = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const alpha = data[(y * img.width + x) * 4 + 3]
      if (alpha > 10) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  // Fully opaque source (JPEG, or no transparent pixels detected) — use full image
  if (maxX === 0 && maxY === 0) {
    return { x: 0, y: 0, width: img.width, height: img.height }
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

function buildSchemaJsonLd(restaurant, hours) {
  const { street, city, state, zip } = parseAddress(restaurant.address)
  const canonicalUrl = restaurant.custom_domain
    ? `https://${restaurant.custom_domain}`
    : `https://${MAIN_DOMAIN}/${restaurant.slug}/home`
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: restaurant.name,
    description: restaurant.tagline || restaurant.about_text || '',
    image: restaurant.hero_image_url || undefined,
    telephone: restaurant.phone || undefined,
    url: canonicalUrl,
    menu: `https://${MAIN_DOMAIN}/${restaurant.slug}`,
    priceRange: '$$',
    servesCuisine: 'Pizza',
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

  // Swap the browser tab icon, document title, and PWA app-name meta
  // tags to the restaurant's branding while this page is mounted.
  // Restored on unmount so other DirectBite pages keep the defaults.
  //
  // Favicon: two 192×192 canvases. Browser-tab icons get a transparent
  // background so they sit clean against any tab theme; iOS Add to Home
  // Screen icons get a solid white background since the OS otherwise
  // composites transparent PNGs against the wallpaper. Both canvases
  // crop the source to its non-transparent bounding box first — logos
  // with built-in whitespace would otherwise render tiny once the OS
  // downsamples to 16/32px.
  useEffect(() => {
    if (!restaurant) return

    const ICON_TARGETS = [
      { selector: "link[rel='icon']", variant: 'transparent' },
      { selector: "link[rel='shortcut icon']", variant: 'transparent' },
      { selector: "link[rel='apple-touch-icon']", variant: 'white' },
      { selector: "link[rel='apple-touch-icon-precomposed']", variant: 'white' },
    ]
    const META_NAMES = ['apple-mobile-web-app-title', 'application-name']

    // Snapshot each tag's state so cleanup can fully reverse our changes.
    const iconStates = ICON_TARGETS.map(({ selector, variant }) => {
      const el = document.querySelector(selector)
      return {
        selector,
        variant,
        element: el,
        preExisting: !!el,
        originalHref: el?.getAttribute('href') || null,
        originalType: el?.getAttribute('type') || null,
      }
    })
    const metaStates = META_NAMES.map(name => {
      const el = document.querySelector(`meta[name='${name}']`)
      return {
        name,
        element: el,
        preExisting: !!el,
        originalContent: el?.getAttribute('content') || null,
      }
    })

    const originalTitle = document.title
    document.title = restaurant.tagline
      ? `${restaurant.name} — ${restaurant.tagline}`
      : restaurant.name

    // PWA "Add to Home Screen" name — applied immediately, doesn't wait
    // on the canvas render.
    metaStates.forEach(state => {
      if (!state.element) {
        state.element = document.createElement('meta')
        state.element.setAttribute('name', state.name)
        document.head.appendChild(state.element)
      }
      state.element.setAttribute('content', restaurant.name)
    })

    let cancelled = false

    if (restaurant.logo_url) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (cancelled) return
        const SIZE = 192

        // Crop to the logo's actual content so built-in whitespace
        // doesn't shrink the rendered icon.
        const bounds = getNonTransparentBounds(img)
        const ratio = Math.min(SIZE / bounds.width, SIZE / bounds.height)
        const w = bounds.width * ratio
        const h = bounds.height * ratio
        const x = (SIZE - w) / 2
        const y = (SIZE - h) / 2

        function renderVariant(fillBackground) {
          const canvas = document.createElement('canvas')
          canvas.width = SIZE
          canvas.height = SIZE
          const ctx = canvas.getContext('2d')
          if (fillBackground) {
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, SIZE, SIZE)
          }
          ctx.drawImage(img, bounds.x, bounds.y, bounds.width, bounds.height, x, y, w, h)
          return canvas.toDataURL('image/png')
        }

        const transparentDataUrl = renderVariant(false)
        const whiteDataUrl = renderVariant(true)

        iconStates.forEach(state => {
          if (!state.element) {
            state.element = document.createElement('link')
            const match = state.selector.match(/rel='([^']+)'/)
            if (match) state.element.rel = match[1]
            document.head.appendChild(state.element)
          }
          state.element.setAttribute(
            'href',
            state.variant === 'white' ? whiteDataUrl : transparentDataUrl,
          )
          state.element.removeAttribute('type')
        })
      }
      img.src = restaurant.logo_url
    }

    return () => {
      cancelled = true
      document.title = originalTitle
      iconStates.forEach(state => {
        if (!state.element) return
        if (state.preExisting) {
          if (state.originalHref) state.element.setAttribute('href', state.originalHref)
          if (state.originalType) state.element.setAttribute('type', state.originalType)
        } else if (state.element.parentNode) {
          state.element.parentNode.removeChild(state.element)
        }
      })
      metaStates.forEach(state => {
        if (!state.element) return
        if (state.preExisting) {
          if (state.originalContent) state.element.setAttribute('content', state.originalContent)
        } else if (state.element.parentNode) {
          state.element.parentNode.removeChild(state.element)
        }
      })
    }
  }, [restaurant])

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
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !restaurant) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center px-6 text-center">
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

  return (
    <div
      className="min-h-screen bg-white pb-32 md:pb-0"
      style={{ '--brand-color': brandColor }}
    >
      <PromoBar promotion={promotion} />
      <TopBar restaurant={restaurant} status={status} hours={hours} onDrawerOpenChange={setDrawerOpen} />
      <Hero restaurant={restaurant} />
      {restaurant.about_section_visible && restaurant.about_text && (
        <About restaurant={restaurant} />
      )}
      {restaurant.featured_menu_section_visible && (
        <FeaturedMenu restaurant={restaurant} />
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
    </div>
  )
}
