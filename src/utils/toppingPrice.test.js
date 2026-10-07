// Node-runnable assertions for toppingPrice (no test runner required):
//   node src/utils/toppingPrice.test.js
//
// Legacy parity: with size_prices null / {} / no matching key, the result must
// equal what ItemModal (placement-change path, ItemModal.jsx:136-145) and
// reorder.js (:116-119) charge today. legacyCharge() below is a copy of that
// arithmetic and is checked against a grid of cent-precision inputs.

import { normalizeSizeKey, getToppingPrices, resolveToppingPrice } from './toppingPrice.js';

const round2 = n => Math.round(n * 100) / 100;

// Copy of today's charge: reorder.js:117-119 / ItemModal.jsx:37 + 140-142.
function legacyCharge(topping, placement) {
  const whole = Number(topping.price);
  const half = topping.price_half != null ? Number(topping.price_half) : whole / 2;
  return round2(placement === 'whole' ? whole : half);
}

const j = v => JSON.stringify(v);
const cases = [];
const eq = (name, got, expect) => cases.push({ name, got: j(got), expect: j(expect) });

// ---- normalizeSizeKey ----
eq('key: null', normalizeSizeKey(null), '');
eq('key: undefined', normalizeSizeKey(undefined), '');
eq('key: empty', normalizeSizeKey(''), '');
eq('key: trim + lowercase', normalizeSizeKey('  Large '), 'large');
eq('key: collapse inner whitespace', normalizeSizeKey('Extra   Large\t Pie'), 'extra large pie');

// ---- legacy parity (size_prices null) ----
eq('legacy: price_half null', getToppingPrices({ price: 2, price_half: null, size_prices: null }, 'Large'), { whole: 2, half: 1 });
eq('legacy: price_half set', getToppingPrices({ price: 2, price_half: 1.5, size_prices: null }, 'Large'), { whole: 2, half: 1.5 });
eq('legacy: price_half 0 = free half', getToppingPrices({ price: 2, price_half: 0, size_prices: null }, 'Large'), { whole: 2, half: 0 });
eq('legacy: size_prices {}', getToppingPrices({ price: 3, price_half: null, size_prices: {} }, 'Large'), { whole: 3, half: 1.5 });
eq('legacy: size_prices undefined', getToppingPrices({ price: 3 }, 'Small'), { whole: 3, half: 1.5 });
eq('legacy: free topping', getToppingPrices({ price: 0, price_half: null, size_prices: null }, 'Large'), { whole: 0, half: 0 });

// Realistic parity case: 4.99 whole, no price_half. Expected half is computed
// with today's legacy expression (whole / 2, then Math.round to the cent),
// not hardcoded.
const legacyHalf499 = Math.round((4.99 / 2) * 100) / 100;
eq(`legacy: whole 4.99, price_half null -> half ${legacyHalf499} (legacy expression)`,
  getToppingPrices({ price: 4.99, price_half: null, size_prices: null }, 'Large'),
  { whole: 4.99, half: legacyHalf499 });

// Grid parity against today's arithmetic: every cent-precision price/half
// combination, both placements, size_prices null / {} / non-matching key.
let gridChecked = 0;
const gridFailures = [];
for (const price of [0, 0.5, 0.99, 1, 1.25, 1.5, 2, 2.25, 2.99, 3.33, 4.75, 4.99, 5, 12.49]) {
  for (const price_half of [null, 0, 0.5, 0.75, 1.13, 2]) {
    for (const size_prices of [null, {}, { 'some other size': { price: 9, half: 9 } }]) {
      const topping = { price, price_half, size_prices };
      for (const placement of ['whole', 'left', 'right']) {
        gridChecked++;
        const got = resolveToppingPrice(topping, 'Large', placement);
        const expect = legacyCharge(topping, placement);
        if (got !== expect) gridFailures.push(`${j(topping)} ${placement}: got ${got}, legacy ${expect}`);
      }
    }
  }
}
eq(`legacy grid parity (${gridChecked} combos)`, gridFailures, []);

// ---- size overrides ----
const sized = {
  price: 2,
  price_half: 1.25,
  size_prices: {
    large: { price: 3, half: null },
    small: { price: 1.5, half: 0.5 },
    personal: { price: 1, half: 0 },
    free: { price: 0, half: null },
  },
};
eq('override whole only -> half = override / 2', getToppingPrices(sized, 'Large'), { whole: 3, half: 1.5 });
eq('override with explicit half', getToppingPrices(sized, 'Small'), { whole: 1.5, half: 0.5 });
eq('override explicit half 0 = free half', getToppingPrices(sized, 'Personal'), { whole: 1, half: 0 });
eq('override price 0 = free (0 allowed)', getToppingPrices(sized, 'Free'), { whole: 0, half: 0 });
eq('unknown size -> base prices', getToppingPrices(sized, 'Medium'), { whole: 2, half: 1.25 });
eq('blank size -> base prices even with "" key',
  getToppingPrices({ price: 2, price_half: null, size_prices: { '': { price: 9, half: 9 } } }, ''),
  { whole: 2, half: 1 });
eq('null size -> base prices even with "" key',
  getToppingPrices({ price: 2, price_half: null, size_prices: { '': { price: 9, half: 9 } } }, null),
  { whole: 2, half: 1 });
eq('key normalization: "  Large " matches "large"', getToppingPrices(sized, '  Large '), { whole: 3, half: 1.5 });
eq('override half only (no price) -> base whole, entry half',
  getToppingPrices({ price: 2, price_half: 1.25, size_prices: { large: { half: 0.75 } } }, 'Large'),
  { whole: 2, half: 0.75 });
eq('invalid override price (negative) -> base whole, legacy half',
  getToppingPrices({ price: 2, price_half: 1.25, size_prices: { large: { price: -1, half: null } } }, 'Large'),
  { whole: 2, half: 1.25 });
eq('blank-string override price -> base whole (not 0)',
  getToppingPrices({ price: 2, price_half: null, size_prices: { large: { price: '', half: null } } }, 'Large'),
  { whole: 2, half: 1 });
eq('size name "constructor" does not hit Object prototype',
  getToppingPrices({ price: 2, price_half: null, size_prices: { large: { price: 3 } } }, 'constructor'),
  { whole: 2, half: 1 });

// ---- entry.half validation (jsonb: '' / junk / negatives fall through) ----
const withHalf = half => ({ price: 2, price_half: 1.25, size_prices: { large: { price: 3, half } } });
eq('entry.half "" -> entry.price / 2 (not a free half)', getToppingPrices(withHalf(''), 'Large'), { whole: 3, half: 1.5 });
eq('entry.half "abc" -> falls back to entry.price / 2', getToppingPrices(withHalf('abc'), 'Large'), { whole: 3, half: 1.5 });
eq('entry.half -1 -> falls back to entry.price / 2', getToppingPrices(withHalf(-1), 'Large'), { whole: 3, half: 1.5 });
eq('entry.half 0 -> 0 (free half)', getToppingPrices(withHalf(0), 'Large'), { whole: 3, half: 0 });
eq('entry.half "1.75" -> 1.75', getToppingPrices(withHalf('1.75'), 'Large'), { whole: 3, half: 1.75 });
eq('entry.half "abc", no entry.price -> legacy price_half',
  getToppingPrices({ price: 2, price_half: 1.25, size_prices: { large: { half: 'abc' } } }, 'Large'),
  { whole: 2, half: 1.25 });

// ---- resolveToppingPrice placements ----
eq('resolve: whole', resolveToppingPrice(sized, 'Large', 'whole'), 3);
eq('resolve: left', resolveToppingPrice(sized, 'Large', 'left'), 1.5);
eq('resolve: right', resolveToppingPrice(sized, 'Small', 'right'), 0.5);

// ---- rounding ----
eq('rounding: whole 2.25 -> half 1.13', getToppingPrices({ price: 2.25, price_half: null, size_prices: null }, 'Large'), { whole: 2.25, half: 1.13 });
eq('rounding: override 2.25 -> half 1.13', getToppingPrices({ price: 1, size_prices: { large: { price: 2.25 } } }, 'Large'), { whole: 2.25, half: 1.13 });

// Sub-cent pin. The formula is exactly Math.round(x * 100) / 100 — reorder.js's
// round2 and ItemModal.jsx:142 — so the result is whatever that formula gives,
// float quirks included. 1.255 is stored as 1.25499999999999989... in binary
// floating point, so 1.255 * 100 = 125.49999999999999 and Math.round gives 125:
// 1.255 -> 1.25 (not 1.26). This is intentional legacy parity: the charge must
// match what reorder.js and ItemModal's placement-change path produce today.
// No live topping has a sub-cent price or price_half as of migration 095, so no
// live data is affected.
eq('sub-cent: 1.255 -> whole 1.25 (float, intentional legacy parity)', getToppingPrices({ price: 1.255, price_half: null, size_prices: null }, 'Large').whole, 1.25);
eq('sub-cent: matches the legacy formula for whole', resolveToppingPrice({ price: 1.255, price_half: null }, 'Large', 'whole'), legacyCharge({ price: 1.255, price_half: null }, 'whole'));
eq('sub-cent: half from unrounded 1.255 / 2 matches legacy', resolveToppingPrice({ price: 1.255, price_half: null }, 'Large', 'left'), legacyCharge({ price: 1.255, price_half: null }, 'left'));

// ---- numeric strings ----
eq('strings: legacy price + price_half', getToppingPrices({ price: '2.00', price_half: '1.10', size_prices: null }, 'Large'), { whole: 2, half: 1.1 });
eq('strings: legacy price, null half', getToppingPrices({ price: '2.50', price_half: null }, 'Large'), { whole: 2.5, half: 1.25 });
eq('strings: override price + half', getToppingPrices({ price: 2, size_prices: { large: { price: '3.00', half: '1.75' } } }, 'Large'), { whole: 3, half: 1.75 });
eq('strings: override price "0" = free', getToppingPrices({ price: 2, size_prices: { large: { price: '0', half: null } } }, 'Large'), { whole: 0, half: 0 });

let failures = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${c.got})`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
