import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const FALLBACK_IMAGE = 'https://directbite.co/directbite-logo-lockup.png'

let TEMPLATE_CACHE = null
function getTemplate() {
  if (TEMPLATE_CACHE) return TEMPLATE_CACHE
  try {
    TEMPLATE_CACHE = fs.readFileSync(
      path.join(process.cwd(), 'dist', 'index.html'),
      'utf-8'
    )
  } catch {
    // Dev fallback. Production always has dist/ bundled via
    // vercel.json functions.includeFiles.
    TEMPLATE_CACHE =
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><title>DirectBite</title></head><body><div id="root"></div></body></html>'
  }
  return TEMPLATE_CACHE
}

function escapeHtml(s) {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncateAtWord(s, max = 150) {
  if (!s) return s
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  const slice = trimmed.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > 80 ? slice.slice(0, lastSpace) : slice).trim() + '…'
}

function buildMetaBlock({ title, description, image, url, siteName }) {
  const t = escapeHtml(title)
  const d = escapeHtml(description)
  const i = escapeHtml(image)
  const u = escapeHtml(url)
  const s = escapeHtml(siteName)
  return `<meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:image" content="${i}" />
    <meta property="og:url" content="${u}" />
    <meta property="og:site_name" content="${s}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${i}" />`
}

function injectMeta(template, title, metaBlock) {
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace('</head>', `    ${metaBlock}\n  </head>`)
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader(
    'Cache-Control',
    'public, max-age=300, s-maxage=300, stale-while-revalidate=600'
  )

  const template = getTemplate()
  // Strip leading www. and any :port (matters for `vercel dev` localhost).
  const host = (req.query.host || '')
    .toString()
    .toLowerCase()
    .replace(/^www\./, '')
    .split(':')[0]

  if (!host) return res.status(200).send(template)

  // Pass through for main domain and Vercel preview deploys. Vercel's
  // host-match regex was silently failing to filter these at the rewrite
  // layer, so we filter here in the function instead.
  if (host === 'directbite.co' || host === 'ordr.co' || host.endsWith('.vercel.app')) {
    return res.status(200).send(template)
  }

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) return res.status(200).send(template)

  try {
    const supabase = createClient(url, anonKey)
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('name, tagline, about_text, hero_image_url, logo_url, custom_domain')
      .eq('custom_domain', host)
      .maybeSingle()

    if (!restaurant) return res.status(200).send(template)

    const description =
      restaurant.tagline ||
      (restaurant.about_text ? truncateAtWord(restaurant.about_text, 150) : null) ||
      `Order pickup or delivery direct from ${restaurant.name}`

    const image = restaurant.hero_image_url || restaurant.logo_url || FALLBACK_IMAGE

    const metaBlock = buildMetaBlock({
      title: restaurant.name,
      description,
      image,
      url: `https://${host}/`,
      siteName: restaurant.name,
    })

    return res.status(200).send(injectMeta(template, restaurant.name, metaBlock))
  } catch (err) {
    console.error('og-html error:', err)
    return res.status(200).send(template)
  }
}
