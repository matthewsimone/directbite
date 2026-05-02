import { useEffect } from 'react'

// While a restaurant page is mounted, swap the document title, PWA app
// name meta tags, and favicon/manifest link hrefs to the per-restaurant
// API endpoints. All originals are restored on unmount so other pages
// (admin, tablet, landing) keep the DirectBite defaults.
//
// context: "website" → manifest start_url is "/" (custom domain context)
//          "ordering" (default) → manifest start_url is "/{slug}"
export function useRestaurantBranding(restaurant, context = 'ordering') {
  useEffect(() => {
    if (!restaurant?.slug) return

    // Cache-bust the favicon URL on logo replacement. ImageUpload
    // appends ?t={epoch} to logo_url, so use that as the version.
    const tMatch = restaurant.logo_url?.match(/[?&]t=(\d+)/)
    const version = tMatch ? tMatch[1] : 'default'
    const slug = encodeURIComponent(restaurant.slug)
    const ctxParam = context === 'website' ? '&context=website' : ''

    const ICON_TARGETS = [
      { rel: 'icon',                          href: `/api/restaurant-favicon?slug=${slug}&size=192&style=transparent&v=${version}` },
      { rel: 'shortcut icon',                 href: `/api/restaurant-favicon?slug=${slug}&size=192&style=transparent&v=${version}` },
      { rel: 'apple-touch-icon',              href: `/api/restaurant-favicon?slug=${slug}&size=192&style=white&v=${version}` },
      { rel: 'apple-touch-icon-precomposed',  href: `/api/restaurant-favicon?slug=${slug}&size=192&style=white&v=${version}` },
      { rel: 'mask-icon',                     href: `/api/restaurant-favicon?slug=${slug}&size=192&style=transparent&v=${version}` },
      { rel: 'manifest',                      href: `/api/restaurant-manifest?slug=${slug}${ctxParam}` },
    ]
    const META_NAMES = ['apple-mobile-web-app-title', 'application-name']

    // Snapshot pre-existing tag state so cleanup can fully reverse.
    const iconStates = ICON_TARGETS.map(({ rel, href }) => {
      const el = document.querySelector(`link[rel='${rel}']`)
      return {
        rel,
        newHref: href,
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

    metaStates.forEach(state => {
      if (!state.element) {
        state.element = document.createElement('meta')
        state.element.setAttribute('name', state.name)
        document.head.appendChild(state.element)
      }
      state.element.setAttribute('content', restaurant.name)
    })

    iconStates.forEach(state => {
      if (!state.element) {
        state.element = document.createElement('link')
        state.element.rel = state.rel
        document.head.appendChild(state.element)
      }
      state.element.setAttribute('href', state.newHref)
      // Source data may be png/jpg/webp — let the browser sniff the type
      // header rather than forcing the SVG type the default link carries.
      state.element.removeAttribute('type')
    })

    return () => {
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
  }, [restaurant?.slug, restaurant?.logo_url, restaurant?.name, restaurant?.tagline, context])
}
