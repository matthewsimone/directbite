// Client-side mirror of the server's loyalty math.
//
// ⚠️  THIS MIRRORS SQL. Any change here requires the IDENTICAL change there,
// and vice versa:
//   • calculate_loyalty_points  — supabase/migrations/063_loyalty_foundation.sql
//   • orders_accrue_loyalty     — supabase/migrations/063_loyalty_foundation.sql,
//                                 last modified by 068_loyalty_rewards.sql
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
 * @param {number} [args.tierMultiplier]       the customer's tier multiplier
 * @returns {number} integer points, 0 when nothing would be earned
 */
export function calculateLoyaltyPoints({
  restaurant,
  subtotal,
  discountAmount = 0,
  totalAmount = 0,
  loyaltyDiscountAmount = 0,
  tierMultiplier = 1,
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
  const points = Math.floor((basisCents / 100) * rate * num(tierMultiplier))

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
