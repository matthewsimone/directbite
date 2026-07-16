import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const ALLOWED_SIZES = new Set([192, 512])
const ALLOWED_STYLES = new Set(['transparent', 'white'])
const FALLBACK_LOGO = path.join(process.cwd(), 'api/_assets/directbite-logo.png')

async function loadSourceBuffer(restaurant) {
  if (restaurant?.logo_url) {
    try {
      const res = await fetch(restaurant.logo_url)
      if (res.ok) return Buffer.from(await res.arrayBuffer())
    } catch {
      // fall through to DirectBite fallback
    }
  }
  return fs.readFileSync(FALLBACK_LOGO)
}

export default async function handler(req, res) {
  const { slug } = req.query
  const size = ALLOWED_SIZES.has(Number(req.query.size)) ? Number(req.query.size) : 192
  const style = ALLOWED_STYLES.has(req.query.style) ? req.query.style : 'white'

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
    .select('logo_url')
    .eq('slug', slug)
    .maybeSingle()
  // Restaurant not found: still serve the DirectBite fallback so anyone
  // who deep-links the API doesn't get a broken image.

  const sourceBuffer = await loadSourceBuffer(restaurant)
  // Only trim when the source has an alpha channel. Trimming strips transparent
  // dead padding around a logo — good. But an OPAQUE background-tile logo (e.g.
  // a solid gold badge) has no alpha, and trim() would crop the tile down to the
  // glyph's bounding box, destroying the design's intended margin. So gate it.
  const meta = await sharp(sourceBuffer).metadata()
  const background = style === 'white'
    ? { r: 255, g: 255, b: 255, alpha: 1 }
    : { r: 255, g: 255, b: 255, alpha: 0 }

  // ~8% safe margin so logos don't render edge-to-edge: fit the logo into an
  // inner square (84% of size), then pad back out to the full size on the same
  // background. Final output is exactly size×size.
  const inner = Math.round(size * 0.84)
  const pad = Math.floor((size - inner) / 2)

  try {
    let p = sharp(sourceBuffer)
    // Strip transparent padding ONLY when the source actually has alpha;
    // opaque tile logos are left intact so their built-in margin survives.
    if (meta.hasAlpha) p = p.trim({ threshold: 10 })
    const png = await p
      .resize(inner, inner, { fit: 'contain', background })
      .extend({
        top: pad,
        left: pad,
        bottom: size - inner - pad,
        right: size - inner - pad,
        background,
      })
      .png()
      .toBuffer()

    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=300')
    return res.status(200).send(png)
  } catch (err) {
    console.error('[restaurant-favicon] sharp pipeline failed:', err?.message)
    return res.status(500).json({ error: 'image processing failed' })
  }
}
