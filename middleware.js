export const config = {
  matcher: ['/:slug/tablet', '/:slug/tablet/login'],
}

export default async function middleware(request) {
  try {
    const url = new URL(request.url)
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
