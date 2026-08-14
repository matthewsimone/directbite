// Client-side preview of the server's loyalty math — a deliberate LOWER
// BOUND, not a mirror.
//
// The divergence is the tier ladder. calculate_loyalty_points
// (supabase/migrations/083_tier_promotion.sql:79) walks it: it starts from the
// customer's lifetime points, applies each tier's multiplier to the slice of
// the order earned while standing on that tier, and rolls onto the next tier
// as the order carries them across a threshold. This file applies no
// multiplier at all — it computes the base points and stops, which is the
// ladder walk with every multiplier pinned to 1.
//
// It has no choice. All four callers — the cart, the checkout summary, the
// add-to-cart float and the confirmation page — render without the customer's
// lifetime points, and that figure is the ladder's entry point; without it
// there is no tier to multiply by and no threshold to detect a crossing
// against. Guessing would be worse than not multiplying, because multipliers
// are >= 1: the base figure can only be too low, never too high. So the
// customer is shown a number the ledger meets or beats, which is the safe
// direction to be wrong — a preview that overshot would read as points going
// missing.
//
// The rest — the earn basis, the loyalty-redeemed deduction, the floor — does
// mirror the SQL, and a change to any of those on either side needs the
// identical change on the other.
//
// The database is the authority: it awards the points, this file only
// previews them. Every customer-facing surface that shows a points figure
// (cart, checkout summary, add-to-cart float, confirmation) must call this,
// so no two surfaces can disagree with each other or with what actually
// lands in the ledger.

/**
 * Points a customer would earn on an order. Always a non-negative integer.
 *
 * @param {object}  args.restaurant            restaurant row; needs loyalty_enabled,
 *                                             loyalty_earn_basis, loyalty_points_per_dollar
 * @param {number}  args.subtotal              pre-discount food subtotal, dollars
 * @param {number} [args.discountAmount]       promotional discount, dollars
 * @param {number} [args.totalAmount]          order grand total, dollars
 * @param {number} [args.loyaltyDiscountAmount] portion paid with points, dollars
 * @returns {number} integer points, 0 when nothing would be earned
 */
export function calculateLoyaltyPoints({
  restaurant,
  subtotal,
  discountAmount = 0,
  totalAmount = 0,
  loyaltyDiscountAmount = 0,
}) {
  if (!restaurant || restaurant.loyalty_enabled !== true) return 0

  // An unrecognized, null, or absent basis falls back to 'subtotal' — the
  // same `else` branch the SQL CASE uses.
  const basis = restaurant.loyalty_earn_basis
  let basisCents
  switch (basis) {
    case 'subtotal_less_discount':
      basisCents = Math.round(Math.max(num(subtotal) - num(discountAmount), 0) * 100)
      break
    case 'total':
      basisCents = Math.round(num(totalAmount) * 100)
      break
    case 'subtotal':
    default:
      basisCents = Math.round(num(subtotal) * 100)
      break
  }

  // Remove the loyalty-redeemed portion whatever the basis mode: a customer
  // must not earn points on a dollar amount they paid for with points.
  // Promotional discounts still earn — only the loyalty portion comes off.
  basisCents = Math.max(basisCents - Math.round(num(loyaltyDiscountAmount) * 100), 0)

  if (!Number.isFinite(basisCents) || basisCents <= 0) return 0

  const rate = num(restaurant.loyalty_points_per_dollar)

  // FLOOR, not round — the SQL floors, and rounding up here would show the
  // customer a point they will never actually receive on most orders.
  const points = Math.floor((basisCents / 100) * rate)

  if (!Number.isFinite(points) || points <= 0) return 0
  return points
}

/** Thousands-separated points for display. '0' for anything non-numeric. */
export function formatPoints(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return Math.trunc(v).toLocaleString('en-US')
}

/**
 * Formatted count plus the correctly pluralised word: '1 point',
 * '18 points', '1,250 points'. Non-numeric input reads '0 points'.
 */
export function pointsLabel(n) {
  const v = Number(n)
  // Compare the truncated absolute value so -1 and 1.4 both read "point".
  const singular = Number.isFinite(v) && Math.trunc(Math.abs(v)) === 1
  return `${formatPoints(n)} ${singular ? 'point' : 'points'}`
}

// Coerces to a usable number; anything non-finite (null, '', NaN) becomes 0
// so a missing field can never poison the arithmetic into NaN.
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
