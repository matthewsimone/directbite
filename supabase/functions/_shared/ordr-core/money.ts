/**
 * Money. The ONLY module where money code lives (ARCHITECTURE.md, OFFLINE.md).
 *
 * - All money in POS code is integer cents, carried as the branded `Cents` type.
 * - The web DB stores most money as numeric DOLLARS. Conversion happens only
 *   here, only at the API boundary: `dollarsToCents` on the way in,
 *   `centsToDollars` on the way out. Nothing else in the POS sees dollars.
 * - Rates (tax_rate, promo/tip percents, recoup, points per dollar) are NOT
 *   money and are never `Cents`. They are exact decimals (`Rate`), and the
 *   only way to apply one to money is `applyRate`: exact BigInt arithmetic,
 *   round half away from zero to the cent (OFFLINE.md -> "Rounding spec").
 * - No React Native / Expo / `@/` imports: this file is imported unchanged by
 *   the Deno `pos-v1` pricing function (via src/core/order/).
 * - `scripts/check-invariants.mjs` fails the build on money arithmetic,
 *   `as Cents` casts, or dollar conversions anywhere outside this file.
 */
declare const centsBrand: unique symbol;

/** Integer number of cents. Negative is allowed (refunds, adjustments). */
export type Cents = number & { readonly [centsBrand]: true };

/** Wrap a raw integer as `Cents`. Throws on non-integers (e.g. dollars like 4.25). */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Cents must be a safe integer, got ${value}`);
  }
  return value as Cents;
}

export const ZERO: Cents = cents(0);

// ---- Arithmetic (integer-only, exact) ---------------------------------------

export function addCents(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function subtractCents(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((total, v) => addCents(total, v), ZERO);
}

/** Line amount for an integer quantity, e.g. 2 × $2.99. */
export function multiplyCents(amount: Cents, quantity: number): Cents {
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError(`Quantity must be an integer, got ${quantity}`);
  }
  return cents(amount * quantity);
}

/** The larger of two amounts (e.g. a subtotal floored at zero). */
export function maxCents(a: Cents, b: Cents): Cents {
  return a >= b ? a : b;
}

// ---- Rates (exact decimals, never Cents) ------------------------------------
//
// A Rate is an exact decimal: units / 10^scale, parsed from the DB's decimal
// text, so rate × cents is decided in integer (BigInt) arithmetic. Rounding
// spec: OFFLINE.md → "Rounding spec" (half away from zero, to the cent).

declare const rateBrand: unique symbol;

export interface Rate {
  readonly [rateBrand]: true;
  /** Exact value = units / 10^scale. */
  readonly units: bigint;
  readonly scale: number;
}

const MAX_RATE_DECIMALS = 10;
const RATE_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Canonical form: no trailing decimal zeros (1.00 -> 1, scale 0). */
function makeRate(units: bigint, scale: number): Rate {
  let u = units;
  let k = scale;
  while (k > 0 && u % 10n === 0n) {
    u /= 10n;
    k -= 1;
  }
  return { units: u, scale: k } as Rate;
}

/**
 * Parse an exact decimal rate: a fraction ("0.08875"), or with `percent: true`
 * a percentage ("18" -> 0.18). JSON numbers are read via String(n), the
 * shortest round-trip text. Throws on exponents, junk, or > 10 decimals.
 */
export function parseRate(value: number | string, options: { percent?: boolean } = {}): Rate {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = RATE_DECIMAL.exec(text);
  if (!match) throw new RangeError(`Not a plain decimal rate: ${JSON.stringify(value)}`);
  const [, sign, whole, rawFraction = ''] = match;
  const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > MAX_RATE_DECIMALS) {
    throw new RangeError(`Rate has more than ${MAX_RATE_DECIMALS} decimal places: ${JSON.stringify(value)}`);
  }
  const magnitude = BigInt(whole + fraction);
  const units = sign === '-' ? -magnitude : magnitude;
  return makeRate(units, fraction.length + (options.percent ? 2 : 0));
}

export const ZERO_RATE: Rate = makeRate(0n, 0);

/** A percentage rate as a fraction, exactly (18 -> 0.18). */
export function fromPercent(percent: Rate): Rate {
  return makeRate(percent.units, percent.scale + 2);
}
const HALF: Rate = makeRate(5n, 1);

/** Exact comparison of two rates. */
export function compareRates(a: Rate, b: Rate): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const x = a.units * 10n ** BigInt(scale - a.scale);
  const y = b.units * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Exact comparison of a rate against a plain decimal bound (e.g. 0, 1, 100). */
export function compareRate(rate: Rate, bound: number | string): -1 | 0 | 1 {
  return compareRates(rate, parseRate(bound));
}

/** The smaller of two rates (e.g. recoup rate capped at 0.10). */
export function minRate(a: Rate, b: Rate): Rate {
  return compareRates(a, b) <= 0 ? a : b;
}

/** Exact decimal text of a rate, e.g. "0.08875". */
export function rateToString(rate: Rate): string {
  const negative = rate.units < 0n;
  const digits = (negative ? -rate.units : rate.units).toString().padStart(rate.scale + 1, '0');
  const whole = digits.slice(0, digits.length - rate.scale);
  const fraction = digits.slice(digits.length - rate.scale);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Exact integer quotient n / d rounded half away from zero (d > 0). */
function divideHalfAwayFromZero(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const rounded = (abs * 2n + d) / (d * 2n); // floor((|n| + d/2) / d)
  return negative ? -rounded : rounded;
}

function toSafeNumber(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} out of range: ${value}`);
  return n;
}

/**
 * amount × rate, exact, rounded half away from zero to the cent.
 * The only way to apply a rate (tax, % tip, promo, recoup) to money.
 */
export function applyRate(amount: Cents, rate: Rate): Cents {
  const product = BigInt(amount) * rate.units;
  const divisor = 10n ** BigInt(rate.scale);
  return cents(toSafeNumber(divideHalfAwayFromZero(product, divisor), 'applyRate result'));
}

/** Half of an amount, rounded half away from zero (125¢ -> 63¢). */
export function halfOf(amount: Cents): Cents {
  return applyRate(amount, HALF);
}

/**
 * floor(amount in dollars × rate) as a plain integer, exact. For loyalty base
 * points: floor(basisCents / 100 × pointsPerDollar). Not money: returns number.
 */
export function floorDollarsTimesRate(amount: Cents, rate: Rate): number {
  const product = BigInt(amount) * rate.units;
  const divisor = 100n * 10n ** BigInt(rate.scale);
  // BigInt division truncates toward zero; adjust to floor for negatives.
  let q = product / divisor;
  if (product % divisor !== 0n && product < 0n) q -= 1n;
  return toSafeNumber(q, 'floorDollarsTimesRate result');
}

// ---- API boundary: dollars <-> cents ----------------------------------------

/** Plain decimal with an optional fraction; no exponent, no leading '+'/'.'. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Convert a dollar amount from the API (numeric column, JSON number or string)
 * to `Cents`. Exact: parses the decimal text, never multiplies a float.
 *
 * Throws instead of rounding when the value has more than 2 decimal places
 * (trailing zeros are fine: "19.900" is 1990). For a JSON number, the text is
 * `String(value)`, the shortest decimal that round-trips, so a DB value of
 * 19.99 parses as "19.99", while float noise such as 0.1 + 0.2
 * ("0.30000000000000004") is rejected rather than silently rounded.
 */
export function dollarsToCents(value: number | string): Cents {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (!match) {
    throw new RangeError(`Not a plain dollar amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > 2) {
    throw new RangeError(
      `Dollar amount has more than 2 decimal places: ${JSON.stringify(value)}`,
    );
  }
  const magnitude = Number(whole + significant.padEnd(2, '0'));
  if (!Number.isSafeInteger(magnitude)) {
    throw new RangeError(`Dollar amount out of range: ${JSON.stringify(value)}`);
  }
  return cents(sign === '-' && magnitude !== 0 ? -magnitude : magnitude);
}

/**
 * Convert `Cents` to dollars for an API payload (numeric column).
 * `n / 100` is the correctly rounded double nearest the exact quotient, which
 * is the same double as the 2-decimal literal, so it serializes exactly
 * (1999 -> 19.99). Round-trip is unit-tested.
 */
export function centsToDollars(amount: Cents): number {
  return amount / 100;
}

/** Nullable variant for optional numeric columns. */
export function dollarsToCentsOrNull(value: number | string | null | undefined): Cents | null {
  return value === null || value === undefined ? null : dollarsToCents(value);
}

// ---- Display ----------------------------------------------------------------

/** "$1,234.56", "-$1.50". The only money formatting in the app. */
export function formatCents(amount: Cents): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${fraction}`;
}
