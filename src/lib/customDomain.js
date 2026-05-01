// Hostname utilities for custom-domain-aware routing.
//
// directbite.co is the main app domain. Restaurants can attach a custom
// domain (e.g. testpizza.co) that serves their marketing website at the
// root path. Order/checkout flows always live on the main domain — links
// that point at /:slug must absolute-redirect when the page is rendered
// on a custom domain.

const MAIN_DOMAIN = 'directbite.co'

const MAIN_HOSTS = new Set([
  MAIN_DOMAIN,
  `www.${MAIN_DOMAIN}`,
  'localhost',
  '127.0.0.1',
])

export function isMainDomain(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  if (!hostname) return true
  if (MAIN_HOSTS.has(hostname)) return true
  if (hostname.endsWith('.vercel.app')) return true
  return false
}

// Resolve the customer's hostname to a domain we can match against
// restaurants.custom_domain. Strips a leading 'www.' so root + www
// configurations both resolve to the same DB row.
export function getCustomDomainKey(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  if (!hostname) return null
  return hostname.replace(/^www\./, '')
}

// Build the URL that takes a user to the ordering flow for a slug. On the
// main domain we keep relative paths so react-router can client-side
// navigate; on a custom domain we return an absolute URL so the browser
// crosses origins to directbite.co.
export function getOrderUrl(slug, suffix = '') {
  if (isMainDomain()) return `/${slug}${suffix}`
  return `https://${MAIN_DOMAIN}/${slug}${suffix}`
}

export { MAIN_DOMAIN }
