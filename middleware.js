import { rewrite } from '@vercel/functions'

export const config = {
  matcher: ['/', '/:slug/tablet', '/:slug/tablet/login'],
}

export default async function middleware(request) {
  const url = new URL(request.url)
  const rawHost = request.headers.get('host') || ''
  const normalized = rawHost.toLowerCase().replace(/^www\./, '').split(':')[0]
  const isMainDomain =
    normalized === 'directbite.co' ||
    normalized.endsWith('.vercel.app') ||
    normalized.startsWith('localhost')

  // Custom domain root — inject per-restaurant OG/Twitter meta tags via
  // /api/og-html. Vercel's vercel.json `has` rewrites silently fail to
  // fire on this project; middleware runs at a different layer that
  // does. The function reads ?host= and returns dist/index.html with
  // meta tags injected.
  if (url.pathname === '/' && !isMainDomain) {
    const target = new URL(request.url)
    target.pathname = '/api/og-html'
    target.searchParams.set('host', rawHost)
    return rewrite(target)
  }

  // Tablet PWA manifest injection (existing behavior, preserved).
  if (url.pathname.match(/^\/[^/]+\/tablet(\/login)?$/)) {
    try {
      const pathParts = url.pathname.split('/').filter(Boolean)
      const slug = pathParts[0]

      // Safety checks — skip non-restaurant paths
      if (!slug || slug === 'api' || slug === '_next' || slug === 'admin') {
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
