// Topping prices — the single source of truth for what a topping costs for a
// given item size and placement.
//
// Legacy behavior (toppings.size_prices NULL / {} / no matching size key)
// mirrors what ItemModal and reorder.js charge today:
//   whole = Number(topping.price)
//   half  = topping.price_half != null ? Number(topping.price_half) : price / 2
//           (!= null: a price_half of 0 means a free half)
// Both rounded to the cent with Math.round(x * 100) / 100 — exactly
// reorder.js's round2 and ItemModal's placement-change rounding
// (ItemModal.jsx:142). Deliberately not a decimal-safe rounding: parity with
// what is charged today matters more than float-exact cents.
//
// Per-size overrides (migration 095), keyed by normalizeSizeKey(size name):
//   { "<size>": { "price": number, "half": number|null } }
//   whole = entry.price when it is a finite number >= 0 (0 = free), else legacy
//   half, first match wins:
//     a. entry.half when it is a finite number >= 0 (0 = free half). size_prices
//        is jsonb, so '' / junk / negatives are ignored here rather than
//        becoming a free half (Number('') is 0) or NaN in the cart total.
//     b. entry.price / 2, when entry.price was used for whole
//     c. topping.price_half != null           (legacy, numeric column — unchanged)
//     d. topping.price / 2                    (legacy)
// Numeric strings are accepted. Halves are computed from the unrounded whole
// and rounded once, as the legacy code does.

const round2 = n => Math.round(n * 100) / 100

// Trim, lowercase, collapse inner whitespace. null/undefined/'' → ''.
export function normalizeSizeKey(name) {
  if (name == null) return ''
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ')
}

// Number for a price-like value; null/undefined/blank string → NaN (so they
// never count as a valid override; Number(null) and Number('') would be 0).
function toPrice(v) {
  if (v == null) return NaN
  if (typeof v === 'string' && v.trim() === '') return NaN
  return Number(v)
}

const isValidPrice = n => Number.isFinite(n) && n >= 0

function sizeEntry(topping, sizeName) {
  const key = normalizeSizeKey(sizeName)
  if (!key) return null // an empty key never matches
  const map = topping?.size_prices
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null
  const entry = map[key]
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null
}

// → { whole, half }, both rounded to the cent.
export function getToppingPrices(topping, sizeName) {
  const entry = sizeEntry(topping, sizeName)
  const entryPrice = entry ? toPrice(entry.price) : NaN
  const entryHalf = entry ? toPrice(entry.half) : NaN
  const useEntryPrice = isValidPrice(entryPrice)

  const whole = useEntryPrice ? entryPrice : Number(topping?.price)

  let half
  if (isValidPrice(entryHalf)) half = entryHalf
  else if (useEntryPrice) half = entryPrice / 2
  else if (topping?.price_half != null) half = Number(topping.price_half)
  else half = Number(topping?.price) / 2

  return { whole: round2(whole), half: round2(half) }
}

// → the price for this placement: whole when placement === 'whole', else half
// (left / right).
export function resolveToppingPrice(topping, sizeName, placement) {
  const { whole, half } = getToppingPrices(topping, sizeName)
  return placement === 'whole' ? whole : half
}
