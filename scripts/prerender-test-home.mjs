// ============================================================================
// prerender-test-home.mjs — SSG PROOF for exactly ONE route: /test/home
// ============================================================================
//
// Run AFTER `vite build` (it injects into the built dist/ shell). Standalone —
// NOT wired into the npm build script yet. Test Pizza only.
//
//   node scripts/prerender-test-home.mjs
//
// What it does:
//   1. Spin up Vite's SSR pipeline (createServer + ssrLoadModule) so the
//      JSX in HomePage.jsx and the import.meta.env in supabaseBuild.js are
//      transformed — a raw `node` run can parse neither. Everything is loaded
//      through Vite so they share ONE React instance (avoids invalid-hook /
//      duplicate-React errors in renderToString).
//   2. getBuildClient() (SSR-safe: persistSession/autoRefreshToken OFF) →
//      fetch Test Pizza's restaurant + hours (the same shape HomePage's prop
//      seam expects — identical to what CustomDomainShell feeds it).
//   3. renderToString(<StaticRouter><HomePage restaurant hours/></StaticRouter>)
//      and inject into a COPY of dist/index.html's <div id="root">.
//   4. Write ONLY dist/test/home/index.html. No other dist output is touched.
//
// HYDRATION-MISMATCH GUARD (the time-dependent open/closed status):
//   HomePage initializes status via useState({ isOpen:false, statusText:'CLOSED',
//   todaysHours:null }) and only computes the live value inside a useEffect
//   (tick → getStatus(hours, new Date())). useEffect does NOT run during
//   renderToString, so the SERVER HTML emits the static 'CLOSED' placeholder.
//   On the client, hydrateRoot's FIRST render uses that same initial state →
//   it matches the server HTML byte-for-byte → React keeps the prerendered DOM.
//   The live status then settles on the post-hydrate effect tick. So NO change
//   to HomePage is needed for the status mismatch — its existing
//   useState-placeholder + useEffect pattern is already hydration-safe.
//   (Same reasoning covers usePromotion: initial promotion=null → no PromoBar
//   on server AND on first client render → match; the banner appears post-fetch.)
// ============================================================================

import { createServer } from 'vite'
import { promises as fs } from 'node:fs'
import path from 'node:path'
// Bare npm deps load as normal ESM (Vite externalizes them for SSR — the same
// node singletons HomePage resolves, so React identity is shared). Only the
// project files (JSX / import.meta.env) go through ssrLoadModule below.
import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { findNearestTowns, MAX_RADIUS_MILES } from './lib/findNearestTowns.mjs'
import NJ_TOWNS from '../src/data/nj-towns.json' with { type: 'json' }

const TEST_SLUG = 'test'
const TEST_ID = '00000000-0000-0000-0000-000000000001'
const ROUTE = `/${TEST_SLUG}/home`
const ROUTE_MENU = `/${TEST_SLUG}/menu`
const SHELL = path.resolve('dist/index.html')
const OUT_DIR = path.resolve('dist', TEST_SLUG, 'home')
const OUT_DIR_MENU = path.resolve('dist', TEST_SLUG, 'menu')
const SITE_NAME = 'DirectBite'

// HTML-escape for injected head values — mirrored from api/og-html.js so a
// quote/ampersand in a restaurant name can't break an attribute or the markup.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Build the description + canonical + OG/Twitter block from buildSeoHead's
// (raw) values, escaping at this injection boundary (same split as og-html).
function buildMetaBlock({ title, description, canonical, image }) {
  const t = escapeHtml(title)
  const d = escapeHtml(description)
  const u = escapeHtml(canonical)
  const img = escapeHtml(image)
  return [
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${u}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${img}" />`,
  ].join('\n    ')
}

// Regex title-replace (not a literal "DirectBite") + inject block before
// </head> — the exact injectMeta mechanics from api/og-html.js.
function injectHead(html, seo) {
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(seo.title)}</title>`)
    .replace('</head>', `    ${buildMetaBlock(seo)}\n  </head>`)
}

async function main() {
  // dist must exist first — this injects into the built SPA shell.
  let shell
  try {
    shell = await fs.readFile(SHELL, 'utf-8')
  } catch {
    throw new Error(`${SHELL} not found — run \`vite build\` before this script.`)
  }
  if (!shell.includes('<div id="root"></div>')) {
    throw new Error('dist/index.html has no empty <div id="root"></div> to inject into.')
  }

  // Vite SSR server (no HTTP listener) — only used to transform + load modules.
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  })

  try {
    // Load ONLY the project files through Vite (JSX + import.meta.env transform).
    const { getBuildClient } = await vite.ssrLoadModule('/src/lib/supabaseBuild.js')
    const { buildSeoHead } = await vite.ssrLoadModule('/src/pages/website/utils/seoHead.js')
    const { parseAddress } = await vite.ssrLoadModule('/src/pages/website/utils/address.js')
    const HomePageMod = await vite.ssrLoadModule('/src/pages/website/HomePage.jsx')
    const HomePage = HomePageMod.default
    const MenuStatic = (await vite.ssrLoadModule('/src/pages/website/MenuStatic.jsx')).default
    const PlaceStatic = (await vite.ssrLoadModule('/src/pages/website/PlaceStatic.jsx')).default

    // ---- Build-time data fetch (Test Pizza only) ----
    const supabase = getBuildClient()
    const { data: restaurant, error: rErr } = await supabase
      .from('restaurants')
      .select('*')
      .eq('slug', TEST_SLUG)
      .single()
    if (rErr || !restaurant) {
      throw new Error(`restaurant fetch failed for slug '${TEST_SLUG}': ${rErr?.message || 'not found'}`)
    }
    // Safety: this proof is scoped to Test Pizza's known id only.
    if (restaurant.id !== TEST_ID) {
      throw new Error(`slug '${TEST_SLUG}' resolved to id ${restaurant.id}, expected ${TEST_ID} — aborting.`)
    }
    const { data: hoursData, error: hErr } = await supabase
      .from('hours')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .order('day_of_week')
    if (hErr) throw new Error(`hours fetch failed: ${hErr.message}`)

    // ---- Render via the SAME prop seam CustomDomainShell uses ----
    const appHtml = renderToString(
      React.createElement(
        StaticRouter,
        { location: ROUTE },
        React.createElement(HomePage, { restaurant, hours: hoursData || [] })
      )
    )

    // ---- Inject into a copy of the shell; write ONLY this one path ----
    // (1) prerendered app into #root, then (2) per-restaurant <head> (title,
    // description, canonical, OG/Twitter). useRestaurantBranding stays and
    // re-writes the same values on hydrate — no conflict.
    const seo = buildSeoHead(restaurant)
    let out = shell.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`)
    out = injectHead(out, seo)
    await fs.mkdir(OUT_DIR, { recursive: true })
    await fs.writeFile(path.join(OUT_DIR, 'index.html'), out, 'utf-8')
    console.log(`✓ prerendered ${path.relative(process.cwd(), path.join(OUT_DIR, 'index.html'))} (${out.length} bytes, root html ${appHtml.length} bytes)`)

    // ======================================================================
    // /test/menu — static, crawlable full menu (no cart / tabs / search).
    // ======================================================================
    const { data: categories, error: cErr } = await supabase
      .from('menu_categories')
      .select('id, name, sort_order')
      .eq('restaurant_id', restaurant.id)
      .order('sort_order')
    if (cErr) throw new Error(`menu_categories fetch failed: ${cErr.message}`)

    const { data: menuItems, error: iErr } = await supabase
      .from('menu_items')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .order('sort_order')
    if (iErr) throw new Error(`menu_items fetch failed: ${iErr.message}`)

    // item_sizes has no restaurant_id column — filter via inner-join on
    // menu_items, exactly like useMenu, so we don't hit PostgREST's 1000-row
    // default cap and silently drop sizes for high-row-index restaurants.
    const { data: sizes, error: sErr } = await supabase
      .from('item_sizes')
      .select('*, menu_items!inner(restaurant_id)')
      .eq('menu_items.restaurant_id', restaurant.id)
      .order('sort_order')
    if (sErr) throw new Error(`item_sizes fetch failed: ${sErr.message}`)

    // Replicate useMenu.getLowestPrice EXACTLY: sizes for the item (matched by
    // s.item_id), lowest of Number(price), or null when the item has no sizes.
    // Promotion is deliberately NOT applied — the static file is cached, so a
    // time-gated/toggled promo would go stale, and an async client promo fetch
    // (initial null) would hydration-mismatch baked-in discounted prices.
    // Static menu shows LIST prices only.
    const lowestPrices = {}
    for (const item of (menuItems || [])) {
      const itemSizes = (sizes || []).filter((s) => s.item_id === item.id)
      lowestPrices[item.id] = itemSizes.length
        ? Math.min(...itemSizes.map((s) => Number(s.price)))
        : null
    }

    // Featured items for the /places Featured carousel — a SEPARATE query with
    // item_sizes nested (the card reads item.item_sizes for pricing). Matches
    // the homepage FeaturedMenu fetch exactly: featured_on_website, ordered by
    // featured_order, capped at 8, image required.
    const { data: featuredRows } = await supabase
      .from('menu_items')
      .select('*, item_sizes(*)')
      .eq('restaurant_id', restaurant.id)
      .eq('featured_on_website', true)
      .order('featured_order')
      .limit(8)
    const featuredItems = (featuredRows || []).filter((i) => i.image_url)

    const menuHtml = renderToString(
      React.createElement(
        StaticRouter,
        { location: ROUTE_MENU },
        React.createElement(MenuStatic, {
          restaurant,
          hours: hoursData || [],
          categories: categories || [],
          items: menuItems || [],
          lowestPrices,
        })
      )
    )

    // Menu-specific <head>: custom title, reuse home's description/image.
    // Canonical ALWAYS points at the main-domain path — that's the only URL
    // with prerendered, crawlable HTML. A custom domain's /menu currently
    // serves the SPA shell (no prerender), so canonicalizing there would send
    // crawlers to a page with no content.
    const { city, state } = parseAddress(restaurant.address)
    const cuisine = restaurant.cuisine || 'Pizza'
    const menuSeo = {
      title:
        city && state
          ? `Menu | ${restaurant.name} — Best ${cuisine} in ${city}, ${state}`
          : `Menu | ${restaurant.name}`,
      description: seo.description,
      canonical: `https://directbite.co/${restaurant.slug}/menu`,
      image: seo.image,
    }

    let menuOut = shell.replace('<div id="root"></div>', `<div id="root">${menuHtml}</div>`)
    menuOut = injectHead(menuOut, menuSeo)
    await fs.mkdir(OUT_DIR_MENU, { recursive: true })
    await fs.writeFile(path.join(OUT_DIR_MENU, 'index.html'), menuOut, 'utf-8')
    console.log(`✓ prerendered ${path.relative(process.cwd(), path.join(OUT_DIR_MENU, 'index.html'))} (${menuOut.length} bytes, root html ${menuHtml.length} bytes, ${Object.keys(lowestPrices).length} items)`)

    // ======================================================================
    // /test/places/{town} — location SEO pages within MAX_RADIUS_MILES.
    // Reuses restaurant / hoursData / categories / menuItems / lowestPrices /
    // seo / cuisine + the `city` parsed for the menu head above (no refetch).
    // ======================================================================
    const ownCitySlug = (city || '').toLowerCase().replace(/\s+/g, '-')
    // parseAddress yields no county; derive it by matching the parsed city
    // against the gazetteer (feeds findNearestTowns' same-county tiebreaker).
    // NOTE: collision cities (Washington, Franklin, …) are ambiguous here — fine
    // for Test Pizza (Old Tappan → Bergen only); revisit for real restaurants in
    // collision towns (disambiguate by zip/proximity).
    const county = NJ_TOWNS.find((t) => t.slug === ownCitySlug)?.county
    if (!county) {
      console.warn(`⚠ no county match for own town '${ownCitySlug}' — sibling sort runs without a county tiebreaker`)
    }

    const places = findNearestTowns(
      { lat: restaurant.latitude, lng: restaurant.longitude, county },
      { radiusMiles: MAX_RADIUS_MILES, limit: 20 }
    )
    // Drop the restaurant's own town. Exclude on EITHER signal so a
    // mis-geocoded restaurant still sheds its true-nearest town:
    //   - address match: slug === ownCitySlug, OR
    //   - distance guard: < 0.5 mi (physically at/adjacent to the restaurant)
    const targetTowns = places.filter((t) => t.slug !== ownCitySlug && t.distanceMiles >= 0.5)
    console.log(`found ${targetTowns.length} nearby towns for /places generation`)

    // seo_pages overrides (migration 057). Zero rows => everything auto-generates
    // (no behavior change). A row can override title/description or disable a page
    // via the kill-switch (enabled === false). Keyed by town slug.
    const { data: seoOverrides } = await supabase
      .from('seo_pages')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .eq('page_type', 'place')
    const overrideBySlug = new Map((seoOverrides || []).map((o) => [o.slug, o]))

    // Count pages actually written (kill-switch skips must not inflate the total).
    let placesWritten = 0
    for (const town of targetTowns) {
      // Per-page seo_pages override for this town (undefined when no row exists).
      const ov = overrideBySlug.get(town.slug)
      // Kill-switch: an explicitly disabled page is skipped entirely (not rendered).
      if (ov && ov.enabled === false) continue

      const siblingTowns = targetTowns.filter((t) => t.slug !== town.slug).slice(0, 12)

      const placeHtml = renderToString(
        React.createElement(
          StaticRouter,
          { location: `/${TEST_SLUG}/places/${town.slug}` },
          React.createElement(PlaceStatic, {
            restaurant,
            hours: hoursData || [],
            town,
            siblingTowns,
            featuredItems,
          })
        )
      )

      // Honest framing: "delivery" only when the town is inside the in-house
      // delivery radius; else "near" (also the default when no radius is set).
      // Mirrors the same branch in PlaceStatic.jsx.
      const deliveryBoundary = Number(restaurant.delivery_max_radius_miles) || 0
      const delivers = town.distanceMiles != null && town.distanceMiles <= deliveryBoundary

      // seo_pages can override title/description; else fall back to the auto-formula.
      // NOTE: h1_override / body_override are a follow-up — they need PlaceStatic prop
      // wiring to reach the rendered body, so they are intentionally not applied here.
      const placeSeo = {
        title: ov?.title_override || (delivers
          ? `Best ${cuisine} around ${town.name}, NJ | ${restaurant.name}`
          : `Best ${cuisine} near ${town.name}, NJ | ${restaurant.name}`),
        description: ov?.meta_description_override || (delivers
          ? `Order ${cuisine} for pickup or delivery to ${town.name}. ${restaurant.name} delivers commission-free — support local.`
          : `Looking for ${cuisine} near ${town.name}? ${restaurant.name} serves the area — order online for pickup or delivery, commission-free.`),
        canonical: `https://directbite.co/${TEST_SLUG}/places/${town.slug}`,
        image: seo.image,
      }

      let placeOut = shell.replace('<div id="root"></div>', `<div id="root">${placeHtml}</div>`)
      placeOut = injectHead(placeOut, placeSeo)
      const placeOutDir = path.resolve('dist', TEST_SLUG, 'places', town.slug)
      await fs.mkdir(placeOutDir, { recursive: true })
      await fs.writeFile(path.join(placeOutDir, 'index.html'), placeOut, 'utf-8')
      placesWritten++
    }
    console.log(`✓ generated ${placesWritten} location pages for Test Pizza`)
  } finally {
    await vite.close()
  }
}

main().catch((err) => {
  console.error('prerender failed:', err)
  process.exit(1)
})
