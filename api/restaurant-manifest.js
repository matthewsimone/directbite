import { createClient } from '@supabase/supabase-js'

// Cache-bust the favicon URL when the logo is replaced. Restaurants table
// doesn't track updated_at, but ImageUpload appends ?t={epoch} to logo_url
// on every upload — extract that as the version key.
function cacheBustKey(logoUrl) {
  if (!logoUrl) return 'default'
  const m = logoUrl.match(/[?&]t=(\d+)/)
  return m ? m[1] : String(logoUrl.length)
}

export default async function handler(req, res) {
  const { slug, context } = req.query

  if (!slug) {
    return res.status(400).json({ error: 'slug parameter required' })
  }

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return res.status(500).json({ error: 'Supabase env vars not configured' })
  }

  const supabase = createClient(url, anonKey)
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('name, slug, logo_url, primary_color')
    .eq('slug', slug)
    .maybeSingle()

  if (!restaurant) {
    return res.status(404).json({ error: 'restaurant not found' })
  }

  const v = cacheBustKey(restaurant.logo_url)
  const startUrl = context === 'website' ? '/' : `/${restaurant.slug}`

  const manifest = {
    name: restaurant.name,
    short_name: restaurant.name,
    display: 'standalone',
    start_url: startUrl,
    background_color: '#ffffff',
    theme_color: restaurant.primary_color || '#16a34a',
    icons: [
      {
        src: `/api/restaurant-favicon?slug=${encodeURIComponent(restaurant.slug)}&size=192&style=white&v=${v}`,
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: `/api/restaurant-favicon?slug=${encodeURIComponent(restaurant.slug)}&size=512&style=white&v=${v}`,
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }

  res.setHeader('Content-Type', 'application/manifest+json')
  res.setHeader('Cache-Control', 'public, max-age=300')
  return res.status(200).json(manifest)
}
