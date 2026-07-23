import { rewrite, waitUntil } from '@vercel/functions'
import domainMap from './src/lib/domainMap.js'

export const config = {
  matcher: ['/', '/menu', '/places/:town', '/tags/:tag', '/sitemap.xml', '/robots.txt', '/r/:slug', '/:slug/tablet', '/:slug/tablet/login'],
}

export default async function middleware(request) {
  const url = new URL(request.url)
  const rawHost = request.headers.get('host') || ''
  const normalized = rawHost.toLowerCase().replace(/^www\./, '').split(':')[0]
  const isMainDomain =
    normalized === 'directbite.co' ||
    normalized === 'ordr.co' ||
    normalized.endsWith('.vercel.app') ||
    normalized.startsWith('localhost')

  // Custom-domain requests: serve the restaurant's PRERENDERED pages by
  // rewriting to the main-domain slug path (Vercel then serves dist/{slug}/…).
  // The domain→slug map is generated at build time (scripts/gen-domain-map.mjs)
  // and imported above, so there is no per-request DB lookup. new URL(request.url)
  // preserves the query string; the slug-prefixed target matches no matcher
  // entry, so the rewrite does not re-enter middleware.
  if (!isMainDomain) {
    const slug = domainMap[normalized]
    if (slug) {
      if (url.pathname === '/')     { const t = new URL(request.url); t.pathname = `/${slug}/home`; return rewrite(t) }
      if (url.pathname === '/menu') { const t = new URL(request.url); t.pathname = `/${slug}/menu`; return rewrite(t) }
      const m = url.pathname.match(/^\/places\/([^/]+)\/?$/)
      if (m)                        { const t = new URL(request.url); t.pathname = `/${slug}/places/${m[1]}`; return rewrite(t) }
      const tg = url.pathname.match(/^\/tags\/([^/]+)\/?$/)
      if (tg)                       { const t = new URL(request.url); t.pathname = `/${slug}/tags/${tg[1]}`; return rewrite(t) }
      if (url.pathname === '/sitemap.xml') { const t = new URL(request.url); t.pathname = `/${slug}/sitemap.xml`; return rewrite(t) }
      if (url.pathname === '/robots.txt')  { const t = new URL(request.url); t.pathname = `/${slug}/robots.txt`;  return rewrite(t) }
    }

    // Fallback — domain attached but NOT in the map (not website_enabled /
    // prerendered yet): inject per-restaurant OG/Twitter meta into the SPA
    // shell via /api/og-html. Vercel's vercel.json `has` rewrites silently fail
    // on this project; middleware runs at a layer that does. The function reads
    // ?host= and returns dist/index.html with meta tags injected.
    if (url.pathname === '/') {
      const target = new URL(request.url)
      target.pathname = '/api/og-html'
      target.searchParams.set('host', rawHost)
      return rewrite(target)
    }
  }

  // Permanent QR redirect: /r/:slug → restaurants.redirect_url. Lets us
  // print one sticker per restaurant and change the destination from
  // admin without reprinting. Scan log is fire-and-forget via waitUntil
  // so the 302 doesn't block on the DB write.
  const qrMatch = url.pathname.match(/^\/r\/([^/]+)\/?$/)
  if (qrMatch) {
    const slug = decodeURIComponent(qrMatch[1])
    const supabaseUrl = process.env.VITE_SUPABASE_URL
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY

    let target = `https://directbite.co/${slug}`
    if (supabaseUrl && anonKey) {
      try {
        const lookupRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurants?slug=eq.${encodeURIComponent(slug)}&select=id,redirect_url&limit=1`,
          { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
        )
        if (lookupRes.ok) {
          const rows = await lookupRes.json()
          if (rows.length > 0) {
            const r = rows[0]
            target = r.redirect_url || `https://directbite.co/${slug}`
            waitUntil(
              fetch(`${supabaseUrl}/rest/v1/scans`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  apikey: anonKey,
                  Authorization: `Bearer ${anonKey}`,
                  Prefer: 'return=minimal',
                },
                body: JSON.stringify({ restaurant_id: r.id }),
              }).catch(() => null)
            )
          } else {
            target = 'https://directbite.co'
          }
        }
      } catch {
        // Fall through to slug-default redirect rather than 500 — getting
        // customers to the ordering page matters more than scan logging.
      }
    }

    return new Response(null, {
      status: 302,
      headers: { Location: target, 'Cache-Control': 'no-store' },
    })
  }

  // Tablet PWA manifest injection (existing behavior, preserved).
  if (url.pathname.match(/^\/[^/]+\/tablet(\/login)?$/)) {
    try {
      const pathParts = url.pathname.split('/').filter(Boolean)
      const slug = pathParts[0]

      // Safety checks — skip non-restaurant paths
      if (!slug || slug === 'api' || slug === '_next' || slug === 'admin' || slug === 'r') {
        return
      }

      // Fetch index.html from origin using absolute URL to avoid re-entry
      const originUrl = new URL('/index.html', url.origin)
      const response = await fetch(originUrl.toString(), {
        headers: { 'Accept': 'text/html' },
      })

      if (!response.ok) {
        return
      }

      const html = await response.text()

      // Replace the root manifest with the per-slug tablet manifest
      const modifiedHtml = html.replace(
        '<link rel="manifest" href="/manifest.webmanifest" />',
        `<link rel="manifest" href="/api/tablet-manifest?slug=${encodeURIComponent(slug)}" />`
      )

      return new Response(modifiedHtml, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    } catch (err) {
      // On any error, fall through to default behavior
      console.error('[Middleware] Error:', err.message || err)
      return
    }
  }

  return
}
