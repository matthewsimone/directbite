// Pure head-metadata builder for the prerendered restaurant marketing page.
// Returns RAW (unescaped) strings — escaping happens at the injection
// boundary (the prerender script), mirroring api/og-html.js's separation of
// build-the-values vs. escapeHtml-at-inject.
//
// No DOM / window. Imports PUBLIC_DOMAIN (import.meta.env), so this module
// must be loaded through Vite — the prerender does that via ssrLoadModule.

import { parseAddress } from './address'
import { PUBLIC_DOMAIN } from '../../../lib/publicDomain'

// Word-boundary truncation, mirrored from api/og-html.js's truncateAtWord:
// keep <= max; otherwise cut at the last space (only if past 80 chars, so we
// don't produce a tiny fragment) and append an ellipsis.
function truncateAtWord(s, max = 150) {
  if (!s) return s
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  const slice = trimmed.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > 80 ? slice.slice(0, lastSpace) : slice).trim() + '…'
}

// Canonical host for a restaurant: the www subdomain of its custom_domain,
// matching the live infra (all custom domains 30x apex -> www). Null-domain
// restaurants (served under directbite.co/{slug}) have no custom host and
// return null. Guards against double-prefixing an already-www value.
export function canonicalHost(restaurant) {
  const d = restaurant?.custom_domain
  if (!d) return null
  return d.startsWith('www.') ? d : `www.${d}`
}

export function buildSeoHead(restaurant) {
  const name = restaurant.name
  const cuisine = restaurant.cuisine || 'Pizza'
  const { city, state, street } = parseAddress(restaurant.address)

  const title =
    restaurant.seo_title ||
    (city && state && street ? `${name}, best ${cuisine} in ${city}, ${street}` : name)

  // A manual seo_description override is used verbatim (operator's choice).
  // Only the auto-derived fallback is word-truncated to ~150 chars.
  const description =
    restaurant.seo_description ||
    truncateAtWord(
      city && state
        ? `${name}: the best ${cuisine} in ${city}, ${state}. Order directly online for pickup or delivery — support your local restaurant!`
        : (restaurant.tagline || `Order directly online from ${name} for pickup or delivery.`),
      160
    )

  const canonical = restaurant.custom_domain
    ? `https://${canonicalHost(restaurant)}`
    : `https://${PUBLIC_DOMAIN}/${restaurant.slug}/home`

  const image =
    restaurant.hero_image_url ||
    restaurant.logo_url ||
    'https://directbite.co/directbite-logo-lockup.png'

  return { title, description, canonical, image }
}
