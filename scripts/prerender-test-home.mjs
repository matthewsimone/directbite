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
import TAG_KEYWORDS from '../src/data/tag-keywords.json' with { type: 'json' }

const SHELL = path.resolve('dist/index.html')
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
    const { buildMenuSchema, buildFaqSchema, buildItemListSchema, schemaScriptTag } = await vite.ssrLoadModule('/src/pages/website/utils/schema.js')
    const { buildRestaurantFaq } = await vite.ssrLoadModule('/src/pages/website/utils/faqContent.js')
    const { formatWeekHours } = await vite.ssrLoadModule('/src/pages/website/utils/hours.js')
    const { resolveGeneratedTags, siblingTagsFor, withItemSizes } = await vite.ssrLoadModule('/src/pages/website/utils/tagMatch.js')
    const { parseAddress } = await vite.ssrLoadModule('/src/pages/website/utils/address.js')
    const HomePageMod = await vite.ssrLoadModule('/src/pages/website/HomePage.jsx')
    const HomePage = HomePageMod.default
    const MenuStatic = (await vite.ssrLoadModule('/src/pages/website/MenuStatic.jsx')).default
    const PlaceStatic = (await vite.ssrLoadModule('/src/pages/website/PlaceStatic.jsx')).default
    const TagStatic = (await vite.ssrLoadModule('/src/pages/website/TagStatic.jsx')).default
    const { LinkBaseProvider } = await vite.ssrLoadModule('/src/pages/website/LinkBaseContext.jsx')

    // ---- Build-time data fetch: full fleet (all website_enabled restaurants) ----
    const supabase = getBuildClient()
    const { data: restaurants, error: rErr } = await supabase
      .from('restaurants')
      .select('*')
      .eq('website_enabled', true)
      .order('slug')
    if (rErr) throw rErr
    console.log(`\n=== FLEET PRERENDER: ${restaurants.length} website_enabled restaurants ===\n`)

    // Per-restaurant try/catch: one bad restaurant (bad coords, unparseable
    // address, null fields) must not crash the whole build — it's logged and
    // recorded in the summary, and the loop moves on.
    const summary = []
    // Root directbite.co sitemap: only null-domain restaurants live under
    // directbite.co/{slug}; the 15 custom-domain restaurants are listed on
    // their own hosts, not here.
    const rootUrls = []
    for (const restaurant of restaurants) {
      try {
        // Sitemap URLs for THIS restaurant — each page's canonical, collected as
        // it is written, then emitted as the restaurant's own sitemap below.
        const restaurantUrls = []
        // Per-restaurant routes + output dirs (were module-level TEST_SLUG consts).
        const ROUTE = `/${restaurant.slug}/home`
        const ROUTE_MENU = `/${restaurant.slug}/menu`
        const OUT_DIR = path.resolve('dist', restaurant.slug, 'home')
        const OUT_DIR_MENU = path.resolve('dist', restaurant.slug, 'menu')
        // Link base for same-domain SEO-nav links: bare for custom-domain
        // restaurants (pages served at the domain root), slug-prefixed otherwise.
        // Explicit (not isMainDomain()) because prerender has no window.
        const linkBaseValue = restaurant.custom_domain ? '' : `/${restaurant.slug}`

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
            React.createElement(
              LinkBaseProvider,
              { value: linkBaseValue },
              React.createElement(HomePage, { restaurant, hours: hoursData || [] })
            )
          )
        )

        // ---- Inject into a copy of the shell; write this restaurant's home ----
        // (1) prerendered app into #root, then (2) per-restaurant <head> (title,
        // description, canonical, OG/Twitter). useRestaurantBranding stays and
        // re-writes the same values on hydrate — no conflict.
        const seo = buildSeoHead(restaurant)
        let homeOut = shell.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`)
        homeOut = injectHead(homeOut, seo)
        // GSC verification — home page only, custom-domain restaurants only.
        // Each custom domain is its own GSC property; the token verifies it.
        // null-domain restaurants (served on directbite.co/{slug}) share the
        // directbite.co property, verified once separately — they get no tag.
        if (restaurant.gsc_verification && restaurant.custom_domain) {
          const gscTag = `<meta name="google-site-verification" content="${escapeHtml(restaurant.gsc_verification)}" />`
          homeOut = homeOut.replace('</head>', `    ${gscTag}\n  </head>`)
        }
        restaurantUrls.push(seo.canonical)
        // NOTE: home file is written LATER (after tags/towns are computed) so the
        // FAQ-mesh block can link to the generated /tags and /places pages. See
        // the deferred write after the /tags loop.
        console.log(`✓ prepared ${path.relative(process.cwd(), path.join(OUT_DIR, 'index.html'))} (deferred write for mesh, root html ${appHtml.length} bytes)`)

        // ======================================================================
        // /{slug}/menu — static, crawlable full menu (no cart / tabs / search).
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
            React.createElement(
              LinkBaseProvider,
              { value: linkBaseValue },
              React.createElement(MenuStatic, {
                restaurant,
                hours: hoursData || [],
                categories: categories || [],
                items: menuItems || [],
                lowestPrices,
              })
            )
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
          canonical: restaurant.custom_domain
            ? `https://${restaurant.custom_domain}/menu`
            : `https://directbite.co/${restaurant.slug}/menu`,
          image: seo.image,
        }

        let menuOut = shell.replace('<div id="root"></div>', `<div id="root">${menuHtml}</div>`)
        menuOut = injectHead(menuOut, menuSeo)

        // Menu JSON-LD (Menu/MenuSection/MenuItem). Injected raw AFTER
        // injectHead so it bypasses escapeHtml (JSON-LD must not be
        // HTML-entity-escaped). Built from the same categories/menuItems/
        // lowestPrices already rendered, so schema == visible content.
        const menuSchema = buildMenuSchema({
          name: `${restaurant.name} Menu`,
          sections: categories.map((cat) => ({
            name: cat.name,
            items: menuItems
              .filter((it) => it.category_id === cat.id)
              .map((it) => ({
                name: it.name,
                description: it.description,
                image: it.image_url,
                price: lowestPrices[it.id],
              })),
          })),
        })
        menuOut = menuOut.replace('</head>', `    ${schemaScriptTag(menuSchema)}\n  </head>`)

        await fs.mkdir(OUT_DIR_MENU, { recursive: true })
        await fs.writeFile(path.join(OUT_DIR_MENU, 'index.html'), menuOut, 'utf-8')
        restaurantUrls.push(menuSeo.canonical)
        console.log(`✓ prerendered ${path.relative(process.cwd(), path.join(OUT_DIR_MENU, 'index.html'))} (${menuOut.length} bytes, root html ${menuHtml.length} bytes, ${Object.keys(lowestPrices).length} items)`)

        // ======================================================================
        // /{slug}/places/{town} — location SEO pages within MAX_RADIUS_MILES.
        // Reuses restaurant / hoursData / featuredItems / seo / cuisine + the
        // `city` parsed for the menu head above (no refetch).
        // ======================================================================
        const ownCitySlug = (city || '').toLowerCase().replace(/\s+/g, '-')
        // parseAddress yields no county; derive it by matching the parsed city
        // against the gazetteer (feeds findNearestTowns' same-county tiebreaker).
        // NOTE: collision cities (Washington, Franklin, …) are ambiguous here —
        // they resolve to the FIRST gazetteer match regardless of the restaurant's
        // actual county. Revisit for fleet restaurants in collision towns
        // (disambiguate by zip/proximity).
        const county = NJ_TOWNS.find((t) => t.slug === ownCitySlug)?.county
        if (!county) {
          console.warn(`⚠ no county match for own town '${ownCitySlug}' (${restaurant.slug}) — sibling sort runs without a county tiebreaker`)
        }

        const places = findNearestTowns(
          { lat: restaurant.latitude, lng: restaurant.longitude, county },
          { radiusMiles: MAX_RADIUS_MILES, limit: 20 }
        )
        // Keep the home town (it gets its own "in {town}" page) but still shed a
        // NON-home town that sits coincidentally within 0.5 mi (mis-geocode guard):
        //   - home town (slug === ownCitySlug): always keep
        //   - non-home town: drop when < 0.5 mi (physically at/adjacent to the restaurant)
        const targetTowns = places.filter((t) => {
          if (t.slug === ownCitySlug) return true          // home town: always keep
          return t.distanceMiles >= 0.5                     // non-home: drop if coincidentally adjacent
        })
        console.log(`found ${targetTowns.length} nearby towns for /places generation (${restaurant.slug})`)

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
              { location: `/${restaurant.slug}/places/${town.slug}` },
              React.createElement(
                LinkBaseProvider,
                { value: linkBaseValue },
                React.createElement(PlaceStatic, {
                  restaurant,
                  hours: hoursData || [],
                  town,
                  siblingTowns,
                  featuredItems,
                })
              )
            )
          )

          // Framing priority: home > delivers > near.
          //   - home: this IS the restaurant's own town ("in {town}")
          //   - delivers: inside the in-house delivery radius ("around {town}")
          //   - near: everything else (also the default when no radius is set)
          // Mirrors the same branch in PlaceStatic.jsx.
          const isHome = town.slug === ownCitySlug
          const deliveryBoundary = Number(restaurant.delivery_max_radius_miles) || 0
          const delivers = town.distanceMiles != null && town.distanceMiles <= deliveryBoundary

          // seo_pages can override title/description; else fall back to the auto-formula.
          // NOTE: h1_override / body_override are a follow-up — they need PlaceStatic prop
          // wiring to reach the rendered body, so they are intentionally not applied here.
          const placeSeo = {
            title: ov?.title_override || (isHome
              ? `Best ${cuisine} in ${town.name}, NJ | ${restaurant.name}`
              : delivers
              ? `Best ${cuisine} around ${town.name}, NJ | ${restaurant.name}`
              : `Best ${cuisine} near ${town.name}, NJ | ${restaurant.name}`),
            description: ov?.meta_description_override || (isHome
              ? `${restaurant.name} is your local ${cuisine} spot in ${town.name}, NJ. View the menu, hours, and order directly online for pickup or delivery.`
              : delivers
              ? `Order ${cuisine} for pickup or delivery to ${town.name}. ${restaurant.name} delivers to ${town.name} — support local.`
              : `Looking for ${cuisine} near ${town.name}? ${restaurant.name} serves the area — order online for pickup or delivery.`),
            canonical: restaurant.custom_domain
              ? `https://${restaurant.custom_domain}/places/${town.slug}`
              : `https://directbite.co/${restaurant.slug}/places/${town.slug}`,
            image: seo.image,
          }

          let placeOut = shell.replace('<div id="root"></div>', `<div id="root">${placeHtml}</div>`)
          placeOut = injectHead(placeOut, placeSeo)

          // Place-page FAQ (real data: cuisine/categories, location, hours,
          // and the delivery Q ONLY where we actually deliver to this town).
          const placeCategoriesText = categories && categories.length
            ? categories.map((c) => c.name).slice(0, 6).join(', ')
            : ''
          const placeFaq = buildFaqSchema(
            buildRestaurantFaq(restaurant, {
              hoursText: formatWeekHours(hoursData),
              categoriesText: placeCategoriesText,
              town,
              delivers,
            })
          )
          if (placeFaq) {
            placeOut = placeOut.replace('</head>', `    ${schemaScriptTag(placeFaq)}\n  </head>`)
          }

          const placeOutDir = path.resolve('dist', restaurant.slug, 'places', town.slug)
          await fs.mkdir(placeOutDir, { recursive: true })
          await fs.writeFile(path.join(placeOutDir, 'index.html'), placeOut, 'utf-8')
          restaurantUrls.push(placeSeo.canonical)
          placesWritten++
        }
        console.log(`✓ generated ${placesWritten} location pages for ${restaurant.name}`)

        // ============================================================
        // /{slug}/tags/{tag} — dish-intent SEO landing pages.
        // Sourced from the canonical allowlist; a tag generates ONLY
        // where >=3 matching items exist (the anti-thin-content gate).
        // Reuses categories/menuItems/lowestPrices already fetched
        // above. Additive: new URLs, never touches menu/places/order.
        // ============================================================

        const { data: tagOverrides } = await supabase
          .from('seo_pages')
          .select('*')
          .eq('restaurant_id', restaurant.id)
          .eq('page_type', 'tag')
        const tagOverrideBySlug = new Map((tagOverrides || []).map((o) => [o.slug, o]))

        const generatedTags = resolveGeneratedTags({
          allowlist: TAG_KEYWORDS.tags,
          categories,
          items: menuItems,
        })

        let tagsWritten = 0
        for (const { def: tagDef, items } of generatedTags) {
          const ov = tagOverrideBySlug.get(tagDef.slug)
          if (ov && ov.enabled === false) continue // kill-switch

          const siblingTags = siblingTagsFor(generatedTags, tagDef.slug)

          const tagItems = withItemSizes(items, (id) => (sizes || []).filter((s) => s.item_id === id))

          const tagHtml = renderToString(
            React.createElement(
              StaticRouter,
              { location: `/${restaurant.slug}/tags/${tagDef.slug}` },
              React.createElement(
                LinkBaseProvider,
                { value: linkBaseValue },
                React.createElement(TagStatic, {
                  restaurant,
                  hours: hoursData || [],
                  tag: { slug: tagDef.slug, label: tagDef.label },
                  siblingTags,
                  tagItems,
                })
              )
            )
          )

          const tagSeo = {
            title: ov?.title_override
              || `${tagDef.label} | ${restaurant.name}`,
            description: ov?.meta_description_override
              || `Order ${tagDef.label.toLowerCase()} from ${restaurant.name} — made fresh daily. Pickup or delivery.`,
            canonical: restaurant.custom_domain
              ? `https://${restaurant.custom_domain}/tags/${tagDef.slug}`
              : `https://directbite.co/${restaurant.slug}/tags/${tagDef.slug}`,
            image: seo.image,
          }

          let tagOut = shell.replace('<div id="root"></div>', `<div id="root">${tagHtml}</div>`)
          tagOut = injectHead(tagOut, tagSeo)

          const tagSchema = buildItemListSchema(
            tagItems.map((it) => ({
              name: it.name,
              description: it.description,
              image: it.image_url,
              price: lowestPrices[it.id],
            })),
            { name: `${tagDef.label} at ${restaurant.name}` }
          )
          if (tagSchema) {
            tagOut = tagOut.replace('</head>', `    ${schemaScriptTag(tagSchema)}\n  </head>`)
          }

          const tagOutDir = path.resolve('dist', restaurant.slug, 'tags', tagDef.slug)
          await fs.mkdir(tagOutDir, { recursive: true })
          await fs.writeFile(path.join(tagOutDir, 'index.html'), tagOut, 'utf-8')
          restaurantUrls.push(tagSeo.canonical)
          tagsWritten++
        }
        console.log(`  wrote ${tagsWritten} /tags pages for ${restaurant.slug}`)

        // ============================================================
        // Home FAQ-mesh block — visible FAQ that doubles as the internal
        // -link hub (Owner pattern). Links home -> every /tags and /places
        // page (1 hop from root = crawlable). Built from generatedTags +
        // targetTowns (both in scope here). Prerender-only: crawlers hit
        // this prerendered home; client SPA nav doesn't need a crawl mesh.
        // ============================================================
        const meshBase = linkBaseValue != null ? linkBaseValue : `/${restaurant.slug}`
        const chipClass = 'inline-flex items-center px-3 py-1.5 rounded-full bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors'
        const tagLinks = (generatedTags || [])
          .map((g) => `<a href="${meshBase}/tags/${g.def.slug}" class="${chipClass}">${escapeHtml(g.def.label)}</a>`)
          .join('')
        const townLinks = (targetTowns || [])
          .map((t) => `<a href="${meshBase}/places/${t.slug}" class="${chipClass}">${escapeHtml(cuisine)} in ${escapeHtml(t.name)}</a>`)
          .join('')

        // Only emit a group when it has links (a restaurant with no tags or
        // no towns simply omits that group — no empty hub sections).
        const hubRows = []
        if (tagLinks) hubRows.push(`<div class="mb-6"><h3 class="text-lg font-bold text-gray-900 mb-3">Explore the menu</h3><div class="flex flex-wrap gap-2">${tagLinks}</div></div>`)
        if (townLinks) hubRows.push(`<div class="mb-6"><h3 class="text-lg font-bold text-gray-900 mb-3">Areas we serve</h3><div class="flex flex-wrap gap-2">${townLinks}</div></div>`)

        if (hubRows.length > 0) {
          const meshHtml = `<section class="max-w-[1100px] mx-auto px-6 sm:px-8 -mt-32 md:mt-0 pt-10 pb-32 md:pb-10"><h2 class="text-xl font-bold text-gray-900 mb-6">Explore ${escapeHtml(restaurant.name)}</h2>${hubRows.join('')}</section>`
          // Inject before </body> — OUTSIDE #root, so React hydration
          // doesn't strip it (anything inside #root that HomePage
          // doesn't render gets removed on hydrate). Renders below the
          // footer; crawlers + users both keep it. Above-footer would
          // require making this a real HomePage component (follow-up).
          if (homeOut.includes('</body>')) {
            homeOut = homeOut.replace('</body>', `${meshHtml}</body>`)
          }
        }

        await fs.mkdir(OUT_DIR, { recursive: true })
        await fs.writeFile(path.join(OUT_DIR, 'index.html'), homeOut, 'utf-8')

        // Per-restaurant sitemap + robots, served on the restaurant's own
        // domain (custom domain for the 15, directbite.co/{slug} for the rest).
        // A sitemap may only list URLs on its own host, so each restaurant gets
        // its own file listing exactly the pages we wrote for it — every entry
        // in restaurantUrls is already an absolute canonical on the right host.
        const sitemapUrl = restaurant.custom_domain
          ? `https://${restaurant.custom_domain}/sitemap.xml`
          : `https://directbite.co/${restaurant.slug}/sitemap.xml`
        const sitemapXml =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          restaurantUrls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join('\n') +
          `\n</urlset>\n`
        const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${sitemapUrl}\n`
        const restaurantOutDir = path.resolve('dist', restaurant.slug)
        await fs.mkdir(restaurantOutDir, { recursive: true })
        await fs.writeFile(path.join(restaurantOutDir, 'sitemap.xml'), sitemapXml, 'utf-8')
        await fs.writeFile(path.join(restaurantOutDir, 'robots.txt'), robotsTxt, 'utf-8')

        // Null-domain restaurants also feed the root directbite.co sitemap.
        if (!restaurant.custom_domain) rootUrls.push(...restaurantUrls)

        summary.push({ slug: restaurant.slug, ok: true, homeTown: ownCitySlug, places: placesWritten })
      } catch (err) {
        console.error(`✗ ${restaurant.slug}: ${err.message}`)
        summary.push({ slug: restaurant.slug, ok: false, error: err.message })
      }
    }

    // Root directbite.co sitemap + robots — lists every page of every
    // null-domain restaurant (each already an absolute directbite.co/{slug}/…
    // canonical). Custom-domain restaurants are excluded; they self-serve.
    const rootSitemapXml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      rootUrls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join('\n') +
      `\n</urlset>\n`
    const rootRobotsTxt = `User-agent: *\nAllow: /\nSitemap: https://directbite.co/sitemap.xml\n`
    await fs.mkdir(path.resolve('dist'), { recursive: true })
    await fs.writeFile(path.resolve('dist', 'sitemap.xml'), rootSitemapXml, 'utf-8')
    await fs.writeFile(path.resolve('dist', 'robots.txt'), rootRobotsTxt, 'utf-8')
    console.log(`✓ root directbite.co sitemap: ${rootUrls.length} urls from null-domain restaurants`)

    // ---- Dry-run fleet summary (no deploy) ----
    console.log('\n=== FLEET SUMMARY ===')
    for (const s of summary) {
      if (s.ok) console.log(`  ✓ ${s.slug.padEnd(18)} home=${(s.homeTown || '—').padEnd(20)} places=${s.places}`)
      else      console.log(`  ✗ ${s.slug.padEnd(18)} FAILED: ${s.error}`)
    }
    const okCount = summary.filter((s) => s.ok).length
    console.log(`\n${okCount}/${summary.length} restaurants generated OK\n`)
  } finally {
    await vite.close()
  }
}

main().catch((err) => {
  console.error('prerender failed:', err)
  process.exit(1)
})
