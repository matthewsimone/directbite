// ============================================================================
// audit-geo.mjs — READ-ONLY geocode audit for /places fleet generalization
// ============================================================================
//
// Catches mis-geocoded restaurants BEFORE we generalize the /places prerender
// to the whole fleet: if a restaurant's stored lat/lng disagrees with its
// address, its "nearest town" (and therefore every generated /places page)
// will be wrong. This script surfaces those disagreements as a table.
//
// READ-ONLY. It performs exactly one Supabase SELECT and prints a table.
// It does NOT prerender, write any file, or mutate the repo or the database.
//
// It reuses the SAME primitives the prerender uses so the audit matches what
// generation would actually compute:
//   - getBuildClient()  from src/lib/supabaseBuild.js  (via vite.ssrLoadModule
//     — it reads import.meta.env.VITE_*, so it only runs inside Vite's SSR
//     context, exactly as scripts/prerender-test-home.mjs loads it)
//   - findNearestTowns / MAX_RADIUS_MILES  from ./lib/findNearestTowns.mjs
//     (the build wrapper that injects NJ_TOWNS)
//   - parseAddress  from src/pages/website/utils/address.js (via ssrLoadModule)
//   - the identical findNearestTowns options: { radiusMiles: MAX_RADIUS_MILES,
//     limit: 20 }, with the same county tiebreaker derived from the parsed city
// ============================================================================

import { createServer } from 'vite'
import { findNearestTowns, MAX_RADIUS_MILES } from './lib/findNearestTowns.mjs'
import NJ_TOWNS from '../src/data/nj-towns.json' with { type: 'json' }

// Normalize for the coord-vs-address comparison: case-insensitive, punctuation
// and whitespace stripped ("Old Tappan" === "old-tappan" === "OLD  TAPPAN").
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Fixed-width plain-text table cell (truncate with … so rows stay aligned).
function cell(value, width) {
  let s = value == null ? '' : String(value)
  if (s.length > width) s = s.slice(0, width - 1) + '…'
  return s.padEnd(width)
}

// Flag sort priority — problems float to the top.
const FLAG_RANK = { 'NO COORDS': 0, MISMATCH: 1, 'ADDR?': 2, ok: 3 }

async function main() {
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
  })

  try {
    const { getBuildClient } = await vite.ssrLoadModule('/src/lib/supabaseBuild.js')
    const { parseAddress } = await vite.ssrLoadModule('/src/pages/website/utils/address.js')
    const supabase = getBuildClient()

    const { data: restaurants, error } = await supabase
      .from('restaurants')
      .select('id, name, slug, address, latitude, longitude, delivery_max_radius_miles')
      .eq('website_enabled', true)
    if (error) throw error

    const rows = []
    for (const r of restaurants || []) {
      // Address town via the prerender's own parser. city === null when the
      // address can't be confidently parsed → mark "?" and show the raw string.
      const { city } = parseAddress(r.address)
      const addressTown = city || '?'
      const addressCell = city || `? ${r.address || '(no address)'}`

      // No coords → cannot compute a nearest town at all. Flag and move on.
      if (r.latitude == null || r.longitude == null) {
        rows.push({
          name: r.name, slug: r.slug, coordTown: '—',
          addressCell, nearest3: '—',
          radius: r.delivery_max_radius_miles ?? '—', flag: 'NO COORDS',
        })
        continue
      }

      // Same county tiebreaker the prerender derives (best-effort; undefined is
      // fine — findNearestTowns just runs without the same-county tiebreak).
      const citySlug = (city || '').toLowerCase().replace(/\s+/g, '-')
      const county = NJ_TOWNS.find((t) => t.slug === citySlug)?.county

      // IDENTICAL call + options to the prerender.
      const places = findNearestTowns(
        { lat: r.latitude, lng: r.longitude, county },
        { radiusMiles: MAX_RADIUS_MILES, limit: 20 }
      )
      const coordTown = places[0]?.name || '(none in radius)'
      const nearest3 = places.slice(0, 3).map((t) => t.name).join(', ') || '—'

      let flag
      if (addressTown === '?') flag = 'ADDR?'                       // can't verify
      else if (!places.length) flag = 'MISMATCH'                    // coords yield nothing near
      else if (norm(coordTown) !== norm(addressTown)) flag = 'MISMATCH'
      else flag = 'ok'

      rows.push({
        name: r.name, slug: r.slug, coordTown, addressCell, nearest3,
        radius: r.delivery_max_radius_miles ?? '—', flag,
      })
    }

    // Problems first, then alphabetical by name within each flag rank.
    rows.sort((a, b) =>
      (FLAG_RANK[a.flag] ?? 9) - (FLAG_RANK[b.flag] ?? 9) ||
      norm(a.name).localeCompare(norm(b.name)))

    // ---- Print table ----
    const W = { name: 22, slug: 16, coord: 16, addr: 26, near: 32, rad: 7, flag: 12 }
    const header =
      cell('name', W.name) + cell('slug', W.slug) + cell('coord town', W.coord) +
      cell('address town', W.addr) + cell('nearest 3 towns', W.near) +
      cell('radius', W.rad) + cell('FLAG', W.flag)
    console.log(header)
    console.log('-'.repeat(header.length))
    for (const row of rows) {
      const flagDisplay = row.flag === 'ok' ? 'ok' : `⚠ ${row.flag}`
      console.log(
        cell(row.name, W.name) + cell(row.slug, W.slug) + cell(row.coordTown, W.coord) +
        cell(row.addressCell, W.addr) + cell(row.nearest3, W.near) +
        cell(row.radius, W.rad) + cell(flagDisplay, W.flag)
      )
    }

    const flagged = rows.filter((r) => r.flag !== 'ok').length
    console.log('')
    console.log(`${rows.length} restaurants, ${flagged} flagged (need coord review)`)
  } finally {
    await vite.close()
  }
}

main().catch((err) => {
  console.error('audit-geo failed:', err)
  process.exit(1)
})
