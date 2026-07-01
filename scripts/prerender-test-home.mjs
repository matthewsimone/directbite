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

const TEST_SLUG = 'test'
const TEST_ID = '00000000-0000-0000-0000-000000000001'
const ROUTE = `/${TEST_SLUG}/home`
const SHELL = path.resolve('dist/index.html')
const OUT_DIR = path.resolve('dist', TEST_SLUG, 'home')

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
    const HomePageMod = await vite.ssrLoadModule('/src/pages/website/HomePage.jsx')
    const HomePage = HomePageMod.default

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
    const out = shell.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`)
    await fs.mkdir(OUT_DIR, { recursive: true })
    await fs.writeFile(path.join(OUT_DIR, 'index.html'), out, 'utf-8')
    console.log(`✓ prerendered ${path.relative(process.cwd(), path.join(OUT_DIR, 'index.html'))} (${out.length} bytes, root html ${appHtml.length} bytes)`)
  } finally {
    await vite.close()
  }
}

main().catch((err) => {
  console.error('prerender failed:', err)
  process.exit(1)
})
