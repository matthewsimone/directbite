/**
 * Credit-processing recoup — migration 061.
 *
 * A per-restaurant, opt-in percentage folded into the existing customer-facing
 * Service Fee line. OFF for every restaurant by default. When off, every value
 * this module returns is 0 / 1.50 and checkout math is byte-identical to
 * pre-061 behavior.
 *
 * DESIGN NOTES — read before changing anything here.
 *
 * 1. The recoup base EXCLUDES tax. Deliberate, not an oversight. CheckoutPage's
 *    `taxableAmount` includes the service fee, and the service fee includes the
 *    recoup. If the recoup base also included tax, the two would be mutually
 *    dependent with no single-pass solution. Dropping tax from the base breaks
 *    the loop and keeps the arithmetic checkable by hand — a restaurant can
 *    verify any receipt with a calculator.
 *
 * 2. The recoup IS taxed. It lands in `serviceFee`, which CheckoutPage already
 *    feeds into `taxableAmount`. Intentional: the whole service fee is treated
 *    consistently, matching how the base $1.50 has always been taxed.
 *
 * 3. Money flow. The recoup raises the customer's total but NOT
 *    `application_fee_amount` in create-payment-intent. Under Stripe Direct
 *    Charges the charge is created on the connected account, so the extra lands
 *    in the restaurant's balance automatically. NEVER add the recoup to
 *    applicationFeeCents — that routes it to the platform instead.
 *
 * 4. PostgREST returns `numeric` columns as JSON strings ("0.0300"), so every
 *    read here goes through Number(). Without it the math silently yields NaN.
 *
 * 5. Rounding matches CheckoutPage: Math.round(x * 100) / 100.
 */

export const BASE_SERVICE_FEE = 1.50

// Hard cap mirrors the DB CHECK constraint (migration 061). Defense in depth:
// a bad write can never produce a runaway customer charge.
const MAX_RATE = 0.10

export function getRecoupRate(restaurant) {
  if (!restaurant || restaurant.recoup_enabled !== true) return 0
  const rate = Number(restaurant.recoup_rate)
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return Math.min(rate, MAX_RATE)
}

export function calcRecoup({ restaurant, discountedSubtotal, deliveryFee, tip }) {
  const rate = getRecoupRate(restaurant)
  if (rate === 0) {
    return { rate: 0, amount: 0, serviceFee: BASE_SERVICE_FEE }
  }
  const base =
    Number(discountedSubtotal || 0) +
    Number(deliveryFee || 0) +
    Number(tip || 0) +
    BASE_SERVICE_FEE
  const amount = Math.round(base * rate * 100) / 100
  return {
    rate,
    amount,
    serviceFee: Math.round((BASE_SERVICE_FEE + amount) * 100) / 100,
  }
}
