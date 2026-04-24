export default function handler(req, res) {
  const { slug } = req.query

  if (!slug) {
    return res.status(400).json({ error: 'slug parameter required' })
  }

  const manifest = {
    name: `DirectBite Tablet`,
    short_name: 'DirectBite',
    display: 'standalone',
    start_url: `/${slug}/tablet`,
    scope: `/${slug}/`,
    theme_color: '#111111',
    background_color: '#ffffff',
    icons: [
      { src: '/favicon.png', sizes: '192x192', type: 'image/png' },
      { src: '/favicon.png', sizes: '512x512', type: 'image/png' },
    ],
  }

  res.setHeader('Content-Type', 'application/manifest+json')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  return res.status(200).json(manifest)
}
