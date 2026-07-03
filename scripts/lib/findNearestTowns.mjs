// ============================================================================
// findNearestTowns.mjs — build-time entry for the /places/* geo helper.
//
// Thin wrapper over the browser-safe src/lib/geoTowns.js. The pure algorithm +
// radius constant live there; this file's only job is to load the gazetteer
// (via `with { type: 'json' }`, which build-time Node supports) and inject it,
// so existing prerender-script callers keep the old (restaurant, options)
// signature. The node:url self-test stays here — this file is only ever run /
// imported by Node build scripts, never bundled for the browser.
// ============================================================================
import { fileURLToPath } from 'node:url'
import {
  MAX_RADIUS_MILES,
  haversineMiles,
  findNearestTowns as _findNearestTowns,
} from '../../src/lib/geoTowns.js'
import NJ_TOWNS from '../../src/data/nj-towns.json' with { type: 'json' }

// Re-export the browser-safe primitives unchanged.
export { MAX_RADIUS_MILES, haversineMiles }

// Build-time wrapper: supplies the gazetteer so callers don't pass njTowns.
export function findNearestTowns(restaurant, options = {}) {
  return _findNearestTowns(restaurant, NJ_TOWNS, options)
}

// ---- Self-test: only runs when executed directly (node scripts/lib/findNearestTowns.mjs) ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const testPizza = { lat: 41.023305, lng: -73.984223, county: 'Bergen' }
  const nearby = findNearestTowns(testPizza, { radiusMiles: MAX_RADIUS_MILES, limit: 20 })
  console.log(`Test Pizza (Old Tappan, Bergen) — top ${nearby.length} within ${MAX_RADIUS_MILES} mi:`)
  for (const t of nearby) {
    console.log(
      `  ${t.distanceMiles.toFixed(2).padStart(5)} mi  ${t.name} ${t.type} (${t.county})`
    )
  }
}
