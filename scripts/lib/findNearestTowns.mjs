// ============================================================================
// findNearestTowns.mjs — build-time geo helper for /places/* SEO pages.
// Pure, side-effect-free. Given a restaurant's coordinates, returns the nearby
// NJ towns (from the Census gazetteer) sorted by distance, same-county first.
// ============================================================================
import { fileURLToPath } from 'node:url'
import NJ_TOWNS from '../../src/data/nj-towns.json' with { type: 'json' }

// Radius cap (miles): the max distance a town can be from a restaurant and
// still get a /places page. Exported so the prerender shares the same default.
export const MAX_RADIUS_MILES = 8

// Great-circle distance in miles between two lat/lng points.
export function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8 // Earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// Nearby towns for a restaurant.
//   restaurant: { lat, lng, county? }   county optional but preferred
//   options:    { radiusMiles = 8, limit = 20 }
// Returns [{ name, slug, type, county, county_fips, lat, lng, geoid, distanceMiles }]
// sorted by ascending distance; a supplied county is only a TIEBREAKER (on
// equal distance, same-county wins). A closer town in another county still
// ranks ahead of a farther same-county town.
export function findNearestTowns(restaurant, options = {}) {
  const { radiusMiles = MAX_RADIUS_MILES, limit = 20 } = options
  if (!restaurant || typeof restaurant.lat !== 'number' || typeof restaurant.lng !== 'number') {
    return []
  }
  const { lat, lng, county } = restaurant

  const withDistance = []
  for (const town of NJ_TOWNS) {
    const d = haversineMiles(lat, lng, town.lat, town.lng)
    if (d <= radiusMiles) {
      withDistance.push({ ...town, distanceMiles: Math.round(d * 100) / 100 })
    }
  }

  withDistance.sort((a, b) => {
    // Nearest first.
    if (a.distanceMiles !== b.distanceMiles) return a.distanceMiles - b.distanceMiles
    // Tiebreaker only: on equal distance, same-county wins.
    if (county) {
      const aSame = a.county === county ? 0 : 1
      const bSame = b.county === county ? 0 : 1
      if (aSame !== bSame) return aSame - bSame
    }
    return 0
  })

  return withDistance.slice(0, limit)
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
