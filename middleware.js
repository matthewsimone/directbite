import { rewrite, waitUntil } from '@vercel/functions'
import domainMap, { linkPaths } from './src/lib/domainMap.js'

// Public-facing host for QR fallback redirects. Plain-Node context, so this
// reads process.env rather than importing src/lib/publicDomain.js. Same
// variable, same fallback — the two stay in step.
const PUBLIC_DOMAIN = process.env.VITE_PUBLIC_DOMAIN || 'directbite.co'

export const config = {
  matcher: ['/', '/menu', '/:path', '/places/:town', '/tags/:tag', '/sitemap.xml', '/robots.txt', '/r/:slug', '/:slug/tablet', '/:slug/tablet/login'],
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

      // Single-segment path that matched none of the rewrites above. Two cases:
      //   - a REAL page: /catering, /storemenu (website_links → LinkViewer), or
      //     /order (CustomDomainShell redirects to the main domain)
      //   - a LEGACY url inherited from the restaurant's previous website
      //     (/pasta, /deals, /contact-us). Google has these indexed and the SPA
      //     catch-all answers 200 with an empty shell titled "Ordr" — a soft 404
      //     on a client's own domain, unbounded in count.
      // Real pages pass through untouched. The rest get a genuine 404 STATUS
      // while still serving the SPA shell as the BODY, so LinkViewer renders its
      // existing branded "Page not found" for humans. Status and body are
      // independent: crawlers read the status, browsers render the body.
      //
      // The [^/.] character class excludes dots, so /favicon.ico, /chime.wav,
      // /manifest.webmanifest and every other static asset can never match here.
      // That guard is structural, not a maintained list.
      const seg = url.pathname.match(/^\/([^/.]+)\/?$/)
      if (seg) {
        const p = seg[1]
        const allowed = p === 'order' || (linkPaths[normalized] || []).includes(p)
        if (!allowed) {
          try {
            const shellRes = await fetch(new URL('/index.html', url.origin), {
              headers: { Accept: 'text/html' },
            })
            if (shellRes.ok) {
              const shell = await shellRes.text()
              return new Response(shell, {
                status: 404,
                headers: {
                  'content-type': 'text/html; charset=utf-8',
                  'cache-control': 'public, max-age=0, must-revalidate',
                },
              })
            }
          } catch (err) {
            console.error('[Middleware] 404 shell fetch failed:', err?.message || err)
          }
          // Fail OPEN: shell fetch failed, so fall through to the existing
          // catch-all (200 + shell). A wrong status code is a SEO problem;
          // a 500 here would be an outage. Never fail closed on this path.
        }
      }
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

    let target = `https://${PUBLIC_DOMAIN}/${slug}`
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
            target = r.redirect_url || `https://${PUBLIC_DOMAIN}/${slug}`
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
            target = `https://${PUBLIC_DOMAIN}`
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
