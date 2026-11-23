/**
 * CP9b: size_prices as [{size_key, price_cents, half_cents}] — the web's effective rule (exact lookup
 * of normalizeSizeKey(size name) against the STORED keys, src/utils/toppingPrice.js:45-53), sorted by
 * size_key, no duplicates, null when empty; array ⇄ map for submit-order (item 2).
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { toppingPrices, type ToppingPricing } from '../../ordr-core/order/index.ts';
import { cents } from '../../ordr-core/money.ts';
import { convertSizePrices } from '../../pos-v1/loader.ts';
import { SizePriceError, sizePricesArrayProblem, sizePricesFromJsonb, sizePricesFromMap, sizePricesToMap } from '../sizePrices.ts';

Deno.test('inch marks / hyphens / spaces survive as values; sorted by size_key (UTF-16 code units)', () => {
  assertEquals(sizePricesFromJsonb({ "x-large 18\"": { price: '3.50' }, "large 16''": { price: 2.75, half: 1.5 }, 'extra large': { price: '3.25' }, '12" small': { price: 1 } }, 'f'), [
    { size_key: '12" small', price_cents: 100, half_cents: null },
    { size_key: 'extra large', price_cents: 325, half_cents: null },
    { size_key: "large 16''", price_cents: 275, half_cents: 150 },
    { size_key: 'x-large 18"', price_cents: 350, half_cents: null },
  ]);
  // UTF-16 code-unit order, not locale order: uppercase-free keys, but digits / punctuation sort first
  assertEquals(sizePricesFromJsonb({ b: { price: 1 }, 'a b': { price: 1 }, a: { price: 1 }, 'a-b': { price: 1 } }, 'f')!.map((e) => e.size_key), ['a', 'a b', 'a-b', 'b']);
});

Deno.test('two raw keys that normalize alike → the web\'s winner (the already-normalized key; the other is dead on the web) — never a duplicate', () => {
  const raw = { 'Large': { price: '9.00' }, 'large': { price: '2.00' }, ' large ': { price: '7.00' }, 'Extra  Large': { price: '5.00' } };
  const wire = sizePricesFromJsonb(raw, 'f');
  assertEquals(wire, [{ size_key: 'large', price_cents: 200, half_cents: null }]);
  // web parity: the web's exact lookup of normalizeSizeKey('Large') finds raw['large'] (2.00) and
  // never 'Large' / ' large '; 'Extra  Large' is unreachable (normalizes to 'extra large').
  // Server pricing (loader keeps the raw map + vendored exact lookup) agrees, and so does the wire map:
  const t = (sizePrices: ToppingPricing['sizePrices']): ToppingPricing => ({ price: cents(150), priceHalf: null, sizePrices });
  for (const size of ['Large', 'large', ' LARGE ', 'Extra Large', 'extra  large']) {
    assertEquals(toppingPrices(t(sizePricesToMap(wire)), size), toppingPrices(t(convertSizePrices(raw, 'x')), size), size);
  }
  assertEquals(toppingPrices(t(sizePricesToMap(wire)), 'Large').whole, 200);
  assertEquals(toppingPrices(t(sizePricesToMap(wire)), 'Extra Large').whole, 150, 'unreachable entry → base price, like the web');
});

Deno.test('null cases and invalid entries (web isValidPrice): non-object map / empty / all invalid → null; blank / junk / negative values → null; half-only kept', () => {
  for (const raw of [null, undefined, 'x', [], {}, { large: null }, { large: 'x' }, { large: { price: '', half: null } }, { large: { price: -1, half: 'abc' } }, { '': { price: 1 } }]) {
    assertEquals(sizePricesFromJsonb(raw, 'f'), null, JSON.stringify(raw));
  }
  assertEquals(sizePricesFromJsonb({ large: { price: '0', half: '' } }, 'f'), [{ size_key: 'large', price_cents: 0, half_cents: null }], '0 = free');
  assertEquals(sizePricesFromJsonb({ large: { price: null, half: '0.75' } }, 'f'), [{ size_key: 'large', price_cents: null, half_cents: 75 }], 'half-only');
  assertEquals(assertThrows(() => sizePricesFromJsonb({ large: { price: '2.005' } }, 'toppings(t1).size_prices'), SizePriceError).field, 'toppings(t1).size_prices.large.price');
});

Deno.test('array ⇄ map round trip (submit-order will price modifiers from the wire array)', () => {
  const wire = sizePricesFromJsonb({ small: { price: '1.75' }, "large 16''": { price: '2.25', half: '1.00' } }, 'f');
  const map = sizePricesToMap(wire);
  assertEquals(map as unknown, { small: { price: 175, half: null }, "large 16''": { price: 225, half: 100 } });
  assertEquals(sizePricesFromMap(map), wire);
  assertEquals([sizePricesToMap(null), sizePricesToMap([]), sizePricesFromMap(null), sizePricesFromMap({ x: { price: null, half: null } } as unknown as Parameters<typeof sizePricesFromMap>[0])], [null, null, null, null]);
});

Deno.test('validator for device-sent arrays: sorted, unique, normalized keys, integer cents', () => {
  assertEquals(sizePricesArrayProblem(null), null);
  assertEquals(sizePricesArrayProblem([{ size_key: 'large', price_cents: 225, half_cents: null }, { size_key: 'small', price_cents: null, half_cents: 50 }]), null);
  for (const bad of [
    [],
    {},
    [{ size_key: 'Large', price_cents: 1, half_cents: null }],
    [{ size_key: 'small', price_cents: 1, half_cents: null }, { size_key: 'large', price_cents: 1, half_cents: null }],
    [{ size_key: 'large', price_cents: 1, half_cents: null }, { size_key: 'large', price_cents: 2, half_cents: null }],
    [{ size_key: 'large', price_cents: 1.5, half_cents: null }],
    [{ size_key: 'large', price_cents: -1, half_cents: null }],
    [{ size_key: 'large', price_cents: null, half_cents: null }],
  ]) assertEquals(typeof sizePricesArrayProblem(bad), 'string', JSON.stringify(bad));
});
