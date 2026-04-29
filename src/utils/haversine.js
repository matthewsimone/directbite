const R = 3958.8 // Earth radius in miles

export function haversineDistanceMiles(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function calculateDeliveryFeeCents(distanceMiles, restaurant) {
  const { delivery_max_radius_miles, delivery_tier1_fee_cents, delivery_tier1_max_miles, delivery_tier2_fee_cents } = restaurant
  if (!delivery_max_radius_miles) return null
  if (distanceMiles > Number(delivery_max_radius_miles)) return null
  if (delivery_tier1_max_miles && distanceMiles > Number(delivery_tier1_max_miles)) {
    return delivery_tier2_fee_cents ?? delivery_tier1_fee_cents ?? 0
  }
  return delivery_tier1_fee_cents ?? 0
}
