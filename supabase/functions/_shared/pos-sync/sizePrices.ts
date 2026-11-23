/**
 * Per-size topping prices on the wire (CP9b contract change, POS-confirmed):
 *
 *   size_prices: [ { size_key, price_cents, half_cents } ] | null
 *
 * used by pos-v1-menu-snapshot toppings[] now and by submit-order lines[].modifiers[] later (item 2).
 * Sorted by size_key (UTF-16 code units), no duplicate keys, null when no entry survives. An array
 * because size keys are free text (`large 16"`, `x-large`) and canonical JSON (SYNC §7) only allows
 * ^[a-z0-9_]+$ object KEYS — as values they hash fine.
 *
 * WHICH ENTRIES — the web's effective rule, so web, server pricing and the POS agree:
 *   The web reads toppings.size_prices with an EXACT key lookup of normalizeSizeKey(sizeName)
 *   (src/utils/toppingPrice.js:45-53 sizeEntry: `hasOwnProperty(map, key)` — it never normalizes the
 *   STORED keys). The vendored pricing module does the same (ordr-core order/toppings.ts:15-19) on the
 *   raw map the pos-v1 loader keeps (loader.ts convertSizePrices). So a stored raw key that is not
 *   already in normalized form ("Large", " large") can never be matched by anyone: it is dropped
 *   here too. Every emitted size_key therefore equals both its raw key and normalizeSizeKey(raw key),
 *   and two entries can never share a size_key (jsonb object keys are unique; Postgres keeps the
 *   last duplicate on input and returns keys ordered by length, then bytes — irrelevant here).
 *
 * VALUES — the web's isValidPrice (toppingPrice.js:35-43): a value counts when it is a finite number
 * ≥ 0 (numeric strings accepted); null / '' / junk / negative → null. An entry with neither a price
 * nor a half is dropped (a half-only entry is kept, as the admin editor writes it, toppingPrice.js:95-108).
 * Dollars → cents through the vendored dollarsToCents: > 2 decimals is an error (SizePriceError).
 *
 * NOTE: half-only entries mean price_cents can be null on the wire (the web then charges the
 * topping's base price for whole and the entry's half for halves).
 */
import { dollarsToCents, type Cents } from '../ordr-core/money.ts';
import { normalizeSizeKey, type SizePrice } from '../ordr-core/order/index.ts';

export interface SizePriceEntry {
  size_key: string;
  price_cents: number | null;
  half_cents: number | null;
}

export class SizePriceError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = 'SizePriceError';
    this.field = field;
  }
}

/** The web's isValidPrice on a jsonb value → cents, or null when not a valid price. */
function priceCents(v: unknown, field: string): number | null {
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
  } else if (typeof v !== 'number') {
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  try {
    return dollarsToCents(v as number | string);
  } catch (err) {
    throw new SizePriceError(`${field}: ${(err as Error).message}`, field);
  }
}

const byKey = (a: SizePriceEntry, b: SizePriceEntry) => (a.size_key < b.size_key ? -1 : a.size_key > b.size_key ? 1 : 0);

/** toppings.size_prices (jsonb, dollars) → wire array. `fieldPrefix` names the field in errors. */
export function sizePricesFromJsonb(raw: unknown, fieldPrefix: string): SizePriceEntry[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: SizePriceEntry[] = [];
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    // only keys the web can ever match (exact lookup of a normalized size name)
    if (key === '' || normalizeSizeKey(key) !== key) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const price_cents = priceCents(e.price, `${fieldPrefix}.${key}.price`);
    const half_cents = priceCents(e.half, `${fieldPrefix}.${key}.half`);
    if (price_cents === null && half_cents === null) continue;
    out.push({ size_key: key, price_cents, half_cents });
  }
  out.sort(byKey);
  return out.length ? out : null;
}

/** Wire array → the pricing module's map (ToppingPricing.sizePrices). For submit-order (item 2). */
export function sizePricesToMap(entries: readonly SizePriceEntry[] | null): Record<string, SizePrice> | null {
  if (!entries || entries.length === 0) return null;
  const out: Record<string, SizePrice> = {};
  for (const e of entries) out[e.size_key] = { price: e.price_cents as Cents | null, half: e.half_cents as Cents | null };
  return out;
}

/** The pricing module's map → wire array (same filter + order as sizePricesFromJsonb). */
export function sizePricesFromMap(map: Record<string, SizePrice> | null): SizePriceEntry[] | null {
  if (!map) return null;
  const out: SizePriceEntry[] = [];
  for (const [key, v] of Object.entries(map)) {
    if (key === '' || normalizeSizeKey(key) !== key) continue;
    if (v.price === null && v.half === null) continue;
    out.push({ size_key: key, price_cents: v.price, half_cents: v.half });
  }
  out.sort(byKey);
  return out.length ? out : null;
}

/**
 * Validate a wire array received from a device (submit-order, item 2): ints ≥ 0 or null, a
 * normalized non-empty size_key, strictly ascending (sorted + no duplicates). Returns a reason or null.
 */
export function sizePricesArrayProblem(v: unknown): string | null {
  if (v === null) return null;
  if (!Array.isArray(v)) return 'size_prices must be an array or null';
  if (v.length === 0) return 'size_prices must be null when empty';
  let prev: string | null = null;
  for (const [i, e] of v.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `size_prices[${i}] is not an object`;
    const { size_key, price_cents, half_cents } = e as Record<string, unknown>;
    if (typeof size_key !== 'string' || size_key === '' || normalizeSizeKey(size_key) !== size_key) return `size_prices[${i}].size_key is not a normalized size key`;
    for (const [k, c] of [['price_cents', price_cents], ['half_cents', half_cents]] as const) {
      if (c !== null && !(typeof c === 'number' && Number.isSafeInteger(c) && c >= 0)) return `size_prices[${i}].${k} must be integer cents ≥ 0 or null`;
    }
    if (price_cents === null && half_cents === null) return `size_prices[${i}] has neither price nor half`;
    if (prev !== null && !(prev < size_key)) return 'size_prices must be sorted by size_key with no duplicates';
    prev = size_key;
  }
  return null;
}
