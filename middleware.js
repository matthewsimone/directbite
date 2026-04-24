export const config = {
  matcher: ['/:path*/tablet', '/:path*/tablet/login'],
}

export default async function middleware(request) {
  const url = new URL(request.url)
  const pathParts = url.pathname.split('/').filter(Boolean)
  const slug = pathParts[0]

  if (!slug || slug === 'api' || slug === '_next') {
    return
  }

  // Fetch the original HTML from the origin
  const response = await fetch(request)
  const html = await response.text()

  // Replace the root manifest with the per-slug tablet manifest
  const modifiedHtml = html.replace(
    '<link rel="manifest" href="/manifest.webmanifest" />',
    `<link rel="manifest" href="/api/tablet-manifest?slug=${encodeURIComponent(slug)}" />`
  )

  return new Response(modifiedHtml, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers),
      'content-type': 'text/html; charset=utf-8',
    },
  })
}
