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

export const round2 = n => Math.round(n * 100) / 100

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

// ── Admin editor helpers (MenuManagementTab "Price by size") ──

// Cent-rounded number for a price input, or null when blank / invalid /
// negative. Accepts numeric strings.
export function centsOrNull(v) {
  const n = toPrice(v)
  return isValidPrice(n) ? round2(n) : null
}

// Editor state → stored toppings.size_prices. Entries whose key is in
// knownKeys (Set or array of normalized size keys) are normalized:
// { price, half } rounded to the cent, blank/invalid → null, and dropped when
// neither a valid price nor a valid half is left (a half-only entry is kept).
// Entries whose key is NOT known (e.g. a renamed size) are copied through
// untouched. Returns null when nothing is left.
export function buildSizePrices(raw, knownKeys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || [])
  const out = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (!known.has(key)) { out[key] = entry; continue }
    if (!entry || typeof entry !== 'object') continue
    const price = centsOrNull(entry.price)
    const half = centsOrNull(entry.half)
    if (price == null && half == null) continue
    out[key] = { price, half }
  }
  return Object.keys(out).length ? out : null
}

// Size options for a topping group from the raw rows of
//   item_topping_groups.select('menu_items(item_sizes(name, sort_order))')
// → [{ key, label }]. Deduped by normalizeSizeKey, labelled with the trimmed
// original name, blank names skipped. Order: the linked item with the most
// sizes first (its sizes by sort_order; first such item wins a tie), then any
// remaining keys by their lowest sort_order, then label. Anchoring on one
// item keeps that item's own order (Small, Medium, Large) instead of mixing
// sort_order values from items with different size counts.
export function orderSizeOptions(rows) {
  const items = []
  for (const row of rows || []) {
    const mi = row?.menu_items
    for (const m of Array.isArray(mi) ? mi : (mi ? [mi] : [])) {
      const sizes = (m?.item_sizes || [])
        .map(s => {
          const label = String(s?.name ?? '').trim()
          return { key: normalizeSizeKey(label), label, sort: Number(s?.sort_order) || 0 }
        })
        .filter(s => s.key)
        .sort((a, b) => a.sort - b.sort)
      items.push(sizes)
    }
  }

  let primary = []
  let best = -1
  for (const sizes of items) {
    const n = new Set(sizes.map(s => s.key)).size
    if (n > best) { best = n; primary = sizes }
  }

  const out = []
  const seen = new Set()
  for (const s of primary) {
    if (seen.has(s.key)) continue
    seen.add(s.key)
    out.push({ key: s.key, label: s.label })
  }

  const rest = new Map()
  for (const sizes of items) {
    for (const s of sizes) {
      if (seen.has(s.key)) continue
      const prev = rest.get(s.key)
      if (!prev || s.sort < prev.sort) rest.set(s.key, s)
    }
  }
  for (const s of [...rest.values()].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))) {
    out.push({ key: s.key, label: s.label })
  }
  return out
}
