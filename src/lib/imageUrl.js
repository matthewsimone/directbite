export function cdnImage(url, { width, height, quality = 72, resize } = {}) {
  if (!url || typeof url !== 'string') return url
  if (!url.includes('/storage/v1/object/public/')) return url
  let u
  try { u = new URL(url) } catch { return url }
  u.pathname = u.pathname.replace(
    '/storage/v1/object/public/',
    '/storage/v1/render/image/public/'
  )
  if (width) u.searchParams.set('width', String(width))
  if (height) u.searchParams.set('height', String(height))
  if (resize) u.searchParams.set('resize', resize)
  if (quality) u.searchParams.set('quality', String(quality))
  return u.toString()
}
