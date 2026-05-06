import { createClient } from '@supabase/supabase-js'
import * as cheerio from 'cheerio'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
const RATE_LIMIT_WINDOW_MS = 30 * 1000
const FETCH_TIMEOUT_MS = 15 * 1000

// In-memory rate-limit map. Resets across cold starts and isn't shared
// across parallel Vercel instances — fine for a soft, internal-use limit.
const lastImportByAdmin = new Map()

const NO_MATCH_RESPONSE = (sourceUrl) => ({
  source_url: sourceUrl,
  categories: [],
  note: 'No menu items found at this URL',
})

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const apiKey = process.env.SUPABASE_QR_API_KEY
  if (!supabaseUrl || !apiKey) {
    console.error('[import-menu] Missing env: VITE_SUPABASE_URL or SUPABASE_QR_API_KEY')
    return res.status(500).json({ error: 'Server not configured' })
  }

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  const supabase = createClient(supabaseUrl, apiKey)
  const { data: userResult, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !userResult?.user?.email) {
    return res.status(401).json({ error: 'invalid token' })
  }
  const adminEmail = userResult.user.email

  const { data: adminRow } = await supabase
    .from('admin_users')
    .select('email')
    .eq('email', adminEmail)
    .maybeSingle()
  if (!adminRow) return res.status(403).json({ error: 'forbidden' })

  const now = Date.now()
  const last = lastImportByAdmin.get(adminEmail)
  if (last && now - last < RATE_LIMIT_WINDOW_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - last)) / 1000)
    return res.status(429).json({
      error: `Please wait ${waitSec} seconds before importing again.`,
    })
  }

  const body = req.body || {}
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const restaurantId = typeof body.restaurant_id === 'string' ? body.restaurant_id : ''
  if (!url) return res.status(400).json({ error: 'url required' })
  if (!restaurantId) return res.status(400).json({ error: 'restaurant_id required' })

  let parsedUrl
  try {
    parsedUrl = new URL(url)
    if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error('only http(s) allowed')
  } catch {
    return res.status(400).json({ error: 'Invalid URL' })
  }

  // Mark the rate-limit window before fetching, so a slow fetch can't
  // be raced by a parallel call from the same admin.
  lastImportByAdmin.set(adminEmail, now)

  let html
  try {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return res.status(200).json(NO_MATCH_RESPONSE(url))
    html = await response.text()
  } catch (err) {
    console.error('[import-menu] Fetch failed:', err?.message || err)
    return res.status(200).json(NO_MATCH_RESPONSE(url))
  }

  const result = parseSlice(html, url)
  if (!result || result.categories.length === 0) {
    return res.status(200).json(NO_MATCH_RESPONSE(url))
  }

  return res.status(200).json({ source_url: url, ...result })
}

// ────────────────────────────────────────────────────────────────────
// Parser
// Two strategies, run in order. The first that yields a non-empty
// category list wins. Internal tool — if a target site's markup
// changes, we iterate the selectors here.
// ────────────────────────────────────────────────────────────────────

function parseSlice(html, sourceUrl) {
  const $ = cheerio.load(html)
  if (!looksLikeSlice($, sourceUrl)) return null

  const fromNextData = parseFromNextData($)
  if (fromNextData && fromNextData.categories.length > 0) return fromNextData

  return parseFromDom($)
}

function looksLikeSlice($, sourceUrl) {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase()
    if (host === 'slicelife.com' || host.endsWith('.slicelife.com')) return true
  } catch {
    // fall through
  }

  if ($('img[src*="slice-menu-assets"], img[src*="slicelife"]').length > 0) return true

  const nextDataRaw = $('#__NEXT_DATA__').first().html()
  if (nextDataRaw && /slicelife|slice-menu-assets/i.test(nextDataRaw)) return true

  return false
}

function parseFromNextData($) {
  const raw = $('#__NEXT_DATA__').first().html()
  if (!raw) return null

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  const probes = [
    ['props', 'pageProps', 'menu'],
    ['props', 'pageProps', 'shop', 'menu'],
    ['props', 'pageProps', 'restaurant', 'menu'],
    ['props', 'pageProps', 'data', 'menu'],
    ['props', 'pageProps', 'initialData', 'menu'],
  ]

  let menu = null
  for (const path of probes) {
    let cursor = data
    let ok = true
    for (const k of path) {
      if (!cursor || typeof cursor !== 'object' || !(k in cursor)) {
        ok = false
        break
      }
      cursor = cursor[k]
    }
    if (ok && cursor) {
      menu = cursor
      break
    }
  }
  if (!menu) return null

  const cats = Array.isArray(menu.categories) ? menu.categories : []
  if (cats.length === 0) return null

  const categories = cats
    .map((cat, ci) => ({
      name: String(cat.name || cat.title || '').trim(),
      sort_order: Number.isFinite(cat.sortOrder) ? cat.sortOrder : ci + 1,
      items: (Array.isArray(cat.items) ? cat.items : [])
        .map((it, ii) => normalizeItem(it, ii))
        .filter(Boolean),
    }))
    .filter((c) => c.name && c.items.length > 0)

  return { categories }
}

function normalizeItem(it, idx) {
  if (!it || typeof it !== 'object') return null

  const name = String(it.name || it.title || '').trim()
  if (!name) return null

  const priceCandidates = [it.basePrice, it.price, it.minPrice, it.startingPrice]
  const price = priceCandidates.find((p) => Number.isFinite(p) && p >= 0)
  if (price == null) return null

  const image =
    (typeof it.imageUrl === 'string' && it.imageUrl) ||
    (typeof it.image === 'string' && it.image) ||
    (typeof it.imageSrc === 'string' && it.imageSrc) ||
    null

  const description =
    typeof it.description === 'string' ? it.description.trim() : null

  const isBestSeller =
    it.isBestSeller === true ||
    it.bestSeller === true ||
    (Array.isArray(it.badges) &&
      it.badges.some((b) =>
        /best.?seller/i.test(typeof b === 'string' ? b : b?.name || '')
      )) ||
    false

  return {
    name,
    description: description || null,
    base_price: Number(price),
    image_url: image,
    original_image_url: image,
    is_best_seller: isBestSeller,
    sort_order: idx + 1,
  }
}

function parseFromDom($) {
  // Slice ships obfuscated CSS-module class names, so structural
  // traversal beats class-based selectors. For each h2[id]:
  //  - Walk forward siblings until the next h2.
  //  - The "items container" is the sibling with the most direct
  //    children (skipping single-child description blocks).
  //  - Each direct child of that container is one item card.
  const categories = []
  let categoryIdx = 0

  $('h2[id]').each((_, h2El) => {
    const $h2 = $(h2El)
    const name = ($h2.text() || '').trim()
    if (!name) return

    let $container = null
    let bestCount = 0
    let $cursor = $h2.next()
    let safety = 0
    while ($cursor.length && !$cursor.is('h2') && safety < 10) {
      const childCount = $cursor.children().length
      if (childCount > bestCount) {
        bestCount = childCount
        $container = $cursor
      }
      $cursor = $cursor.next()
      safety += 1
    }
    if (!$container || bestCount < 2) return

    const items = []
    $container.children().each((_, cardEl) => {
      const item = extractItemFromCard($, $(cardEl), items.length)
      if (item) items.push(item)
    })

    if (items.length > 0) {
      categoryIdx += 1
      categories.push({ name, sort_order: categoryIdx, items })
    }
  })

  return { categories }
}

// Slice's React cards put each piece of info (badge, name, description,
// price) in its own leaf element, so we walk descendants and pick out
// leaves — elements with no element children — by what their text looks
// like. More resilient than guessing class names.
const BUTTON_LABEL_RE =
  /^(\+\s*)?add(\s+to\s+(cart|bag|order))?$|^customi[sz]e$|^show\s+more$|^see\s+more$|^view$/i

function extractItemFromCard($, $card, idx) {
  const imageUrl = $card.find('img').first().attr('src') || null

  const fields = []
  $card.find('*').each((_, el) => {
    const $el = $(el)
    if ($el.children().length > 0) return
    const text = ($el.text() || '').trim()
    if (text) fields.push(text)
  })

  let isBestSeller = false
  let priceVal = null
  const others = []
  for (const text of fields) {
    if (/^best\s*seller$/i.test(text)) {
      isBestSeller = true
      continue
    }
    const priceOnly = text.match(/^\$\s*(\d+(?:\.\d{1,2})?)$/)
    if (priceOnly) {
      priceVal = Number(priceOnly[1])
      continue
    }
    if (BUTTON_LABEL_RE.test(text)) continue
    others.push(text)
  }

  // Fallback if the price wasn't an isolated leaf — pull the first $
  // amount out of the card's full text.
  if (priceVal == null) {
    const m = ($card.text() || '').match(/\$\s*(\d+(?:\.\d{1,2})?)/)
    if (m) priceVal = Number(m[1])
  }

  if (others.length === 0 || priceVal == null) return null

  const name = others[0]
  const description = others.length > 1 ? others.slice(1).join(' ').trim() : null

  return {
    name,
    description: description || null,
    base_price: priceVal,
    image_url: imageUrl,
    original_image_url: imageUrl,
    is_best_seller: isBestSeller,
    sort_order: idx + 1,
  }
}
