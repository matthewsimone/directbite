// Browser-safe, pure geo helpers for /places/* SEO pages.
//
// No node: imports, no file loads, no self-test — so this module bundles
// cleanly for the browser AND runs at build time. The caller supplies the town
// data (`njTowns`), which is the one thing that differs by runtime: the client
// passes a plain JSON import, the build script passes a `with { type: 'json' }`
// import. Single source of truth for the radius constant + geo algorithm.

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
//   njTowns:    the gazetteer array (caller-supplied — keeps this module pure)
//   options:    { radiusMiles = MAX_RADIUS_MILES, limit = 20 }
// Returns [{ ...town, distanceMiles }] sorted by ascending distance; a supplied
// county is only a TIEBREAKER (on equal distance, same-county wins). A closer
// town in another county still ranks ahead of a farther same-county town.
export function findNearestTowns(restaurant, njTowns, options = {}) {
  const { radiusMiles = MAX_RADIUS_MILES, limit = 20 } = options
  if (!restaurant || typeof restaurant.lat !== 'number' || typeof restaurant.lng !== 'number') {
    return []
  }
  const { lat, lng, county } = restaurant

  const withDistance = []
  for (const town of njTowns || []) {
    const d = haversineMiles(lat, lng, town.lat, town.lng)
    if (d <= radiusMiles) {
      withDistance.push({ ...town, distanceMiles: Math.round(d * 100) / 100 })
    }
  }

  withDistance.sort((a, b) => {
    if (a.distanceMiles !== b.distanceMiles) return a.distanceMiles - b.distanceMiles
    if (county) {
      const aSame = a.county === county ? 0 : 1
      const bSame = b.county === county ? 0 : 1
      if (aSame !== bSame) return aSame - bSame
    }
    return 0
  })

  return withDistance.slice(0, limit)
}
