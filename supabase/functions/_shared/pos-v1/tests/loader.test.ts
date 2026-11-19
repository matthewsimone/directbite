/**
 * Loader + handler tests on fixture rows: size_prices, half toppings, recoup,
 * promo resolution, Uber quotes, redemptions, availability, channel, errors.
 */
import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';
import { cents, parseRate } from '../../ordr-core/money.ts';
import { priceOrder } from '../../ordr-core/order/index.ts';
import { ApiError } from '../errors.ts';
import { handlePriceRequest, type QuoteResponse } from '../handler.ts';
import { convertSizePrices, loadPricingInput, localDateIn, resolvePromotion } from '../loader.ts';
import type { PromotionRow, RestaurantRow } from '../db.ts';
import { parsePriceRequest } from '../request.ts';
import { addMenu, addSession, emptyTables, FakeDb, headers, id, line, NOW, pointAtMiles, restaurantRow, type Tables } from './fixtures.ts';

// ---- harness ------------------------------------------------------------------------

function setup(rk: string, over: Partial<RestaurantRow> = {}): Tables {
  const t = emptyTables();
  t.restaurants.push(restaurantRow(id(rk), over));
  addMenu(t, rk);
  return t;
}

async function run(t: Tables, body: Record<string, unknown>, opts: { now?: Date; version?: string | null } = {}) {
  const logs: unknown[] = [];
  const res = await handlePriceRequest(
    { method: 'POST', headers: headers(opts.version === undefined ? '1' : opts.version), bodyText: JSON.stringify(body) },
    { db: new FakeDb(t), now: () => opts.now ?? NOW, channel: 'online', log: (e, d) => logs.push({ e, d }) },
  );
  return { ...res, logs };
}

const ok = (r: { status: number; body: unknown }) => {
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body as QuoteResponse;
};

function expectError(r: { status: number; body: unknown }, status: number, code: string) {
  assertEquals({ status: r.status, code: (r.body as { code: string }).code }, { status, code }, JSON.stringify(r.body));
}

const pickup = (rk: string, lines: unknown[], extra: Record<string, unknown> = {}) => ({ restaurantId: id(rk), orderType: 'pickup', lines, ...extra });

// ---- size_prices --------------------------------------------------------------------

Deno.test('size_prices: junk / blank / negative / non-numeric → null; valid → cents', () => {
  const sp = convertSizePrices({
    small: { price: '1.75', half: null },
    medium: { price: 2, half: '0.90' },
    large: { price: '', half: 'abc' },
    xl: { price: -1, half: true },
    party: 'not-an-object',
    family: [1, 2],
  }, 't');
  assertEquals(sp, {
    small: { price: cents(175), half: null },
    medium: { price: cents(200), half: cents(90) },
    large: { price: null, half: null },
    xl: { price: null, half: null },
  });
  assertEquals(convertSizePrices(null, 't'), null);
  assertEquals(convertSizePrices([], 't'), null);
  assertEquals(convertSizePrices({}, 't'), null);
});

Deno.test('size_prices: > 2 decimals is pricing_config_invalid (never rounded)', () => {
  const err = assertThrows(() => convertSizePrices({ small: { price: '1.255', half: null } }, 't'), ApiError);
  assertEquals(err.code, 'pricing_config_invalid');
});

// ---- half toppings (R1, chain a–d) --------------------------------------------------------------

Deno.test('half toppings: per-size half, per-size price/2, price_half (0 = free), price/2 — exact cents', async () => {
  const rk = 'halves';
  const t = setup(rk);
  const g = id(`${rk}:group:pizza`);
  const add = (key: string, price: string, price_half: string | null, size_prices: unknown) =>
    t.toppings.push({ id: id(`${rk}:top:${key}`), restaurant_id: id(rk), topping_group_id: g, price, price_half, size_prices, is_available: true });
  add('a', '3.00', null, { large: { price: '2.40', half: '1.10' } }); // a. size half → 110
  add('b', '3.00', null, { large: { price: '2.25', half: null } }); // b. 225/2 = 112.5 → 113
  add('c', '3.00', '0', null); // c. price_half 0 → free half
  add('d', '1.15', null, null); // d. 115/2 = 57.5 → 58 (web: 57, D3)
  add('e', '2.00', null, { large: { price: '', half: '-1' } }); // junk size entry → legacy d: 100
  const r = ok(await run(t, pickup(rk, [line(rk, 'pie', 'Large', 1, [['a', 'left'], ['b', 'right'], ['c', 'left'], ['d', 'right'], ['e', 'left']])])));
  assertEquals(r.breakdown.lines[0].modifiers.map((m) => m.charge), [110, 113, 0, 58, 100]);
  assertEquals(r.breakdown.lines[0].unit, 1899 + 110 + 113 + 0 + 58 + 100);
});

Deno.test('whole topping uses the per-size price; another size falls back to the base price', async () => {
  const rk = 'wholes';
  const t = setup(rk);
  const r = ok(await run(t, pickup(rk, [line(rk, 'pie', 'Small', 1, [['mushrooms', 'whole']]), line(rk, 'pie', 'Large', 1, [['onions', 'whole']])])));
  assertEquals(r.breakdown.lines.map((l) => l.modifiers[0].charge), [175, 150]);
});

// ---- recoup -----------------------------------------------------------------------------------------

Deno.test('recoup restaurant (Pazza-like 3.2%): recoup base includes tip, fee is taxed', async () => {
  const rk = 'recoup';
  const t = setup(rk, { tax_rate: '0.06625', recoup_enabled: true, recoup_rate: '0.032' });
  const b = ok(await run(t, pickup(rk, [line(rk, 'pie', 'Large')], { tip: { mode: 'percent', percent: '18' } }))).breakdown;
  // net 1899, tip 18% = 341.82 → 342, base 1899+342+150 = 2391 × 0.032 = 76.512 → 77
  assertEquals([b.tip, b.recoup, b.serviceFee], [342, 77, 227]);
  assertEquals(b.taxable, 1899 + 227);
  assertEquals(b.rates.recoupRate, '0.032');
});

Deno.test('recoup_rate set but recoup_enabled false → no recoup; > 10% is capped', async () => {
  const off = setup('recoup-off', { recoup_enabled: false, recoup_rate: '0.035' });
  assertEquals(ok(await run(off, pickup('recoup-off', [line('recoup-off', 'pie', 'Large')]))).breakdown.recoup, 0);
  const cap = setup('recoup-cap', { recoup_enabled: true, recoup_rate: '0.25' });
  assertEquals(ok(await run(cap, pickup('recoup-cap', [line('recoup-cap', 'pie', 'Large')]))).breakdown.rates.recoupRate, '0.1');
});

// ---- channel ----------------------------------------------------------------------------------------------

Deno.test('dine_in is rejected on the online channel (400 unsupported_order_type)', async () => {
  const t = setup('dinein');
  expectError(await run(t, { restaurantId: id('dinein'), orderType: 'dine_in', lines: [] }), 400, 'unsupported_order_type');
});

Deno.test('in_person channel (POS, not wired yet): $0 base fee, no recoup, dine_in allowed', async () => {
  const rk = 'inperson';
  const t = setup(rk, { recoup_enabled: true, recoup_rate: '0.035' });
  const req = parsePriceRequest({ restaurantId: id(rk), orderType: 'dine_in', lines: [line(rk, 'pie', 'Large')] });
  const loaded = await loadPricingInput(new FakeDb(t), req, { channel: 'in_person', now: NOW });
  const b = priceOrder(loaded.order, loaded.config);
  assertEquals([b.serviceFee, b.recoup, b.tax, b.total], [0, 0, 169, 2068]);
});

Deno.test('channel is never a request field', () => {
  const err = assertThrows(() => parsePriceRequest({ restaurantId: id('x'), orderType: 'pickup', lines: [], channel: 'in_person' }), ApiError);
  assertEquals(err.code, 'invalid_request');
});

// ---- promotion -------------------------------------------------------------------------------------------

const promo = (rk: string, label: string, pct: string, over: Partial<PromotionRow> = {}): PromotionRow => ({
  id: id(`${rk}:promo:${label}`), restaurant_id: id(rk), discount_percentage: pct, is_active: true, is_perpetual: false,
  start_date: '2026-11-01', end_date: '2026-11-19', ...over,
});

Deno.test('promo is resolved by the restaurant-LOCAL date, not UTC (D14)', async () => {
  const rk = 'promo-tz';
  const t = setup(rk);
  t.promotions.push(promo(rk, 'nov', '10'));
  const body = pickup(rk, [line(rk, 'pie', 'Large')]);
  // 21:30 Eastern on the 19th = 02:30 UTC on the 20th: still the 19th locally → promo applies.
  const evening = ok(await run(t, body, { now: new Date('2026-11-20T02:30:00Z') }));
  assertEquals([evening.resolved.localDate, evening.breakdown.promoDiscount], ['2026-11-19', 190]);
  // 00:30 Eastern on the 20th → ended.
  const after = ok(await run(t, body, { now: new Date('2026-11-20T05:30:00Z') }));
  assertEquals([after.resolved.localDate, after.breakdown.promoDiscount, after.resolved.promotionId], ['2026-11-20', 0, null]);
});

Deno.test('promo tie-break: highest percentage, then lowest id; incomplete windows never apply', () => {
  const rk = 'promo-tie';
  const rows = [promo(rk, 'b', '10'), promo(rk, 'a', '15'), promo(rk, 'c', '15'), promo(rk, 'open', '50', { end_date: null })];
  const best = resolvePromotion(rows, '2026-11-10')!;
  assertEquals(best.id, [id(`${rk}:promo:a`), id(`${rk}:promo:c`)].sort()[0]);
  assertEquals(resolvePromotion(rows.slice(0, 1), '2026-10-31'), null);
  assertEquals(resolvePromotion([promo(rk, 'p', '5', { is_perpetual: true, start_date: null, end_date: null })], '2030-01-01')!.id, id(`${rk}:promo:p`));
  assertEquals(resolvePromotion([promo(rk, 'off', '20', { is_active: false })], '2026-11-10'), null);
});

Deno.test('promo > 100% is pricing_config_invalid', () => {
  const err = assertThrows(() => resolvePromotion([promo('p100', 'x', '120')], '2026-11-10'), ApiError);
  assertEquals(err.code, 'pricing_config_invalid');
});

Deno.test('localDateIn', () => {
  assertEquals(localDateIn('America/New_York', new Date('2026-11-20T04:59:00Z')), '2026-11-19');
  assertEquals(localDateIn('America/New_York', new Date('2026-11-20T05:00:00Z')), '2026-11-20');
  assertEquals(localDateIn('America/Los_Angeles', new Date('2026-11-20T07:59:00Z')), '2026-11-19');
});

// ---- timezone / config -----------------------------------------------------------------------------------

Deno.test('missing timezone (099 not applied) → 500 pricing_config_invalid, generic message, detail logged', async () => {
  const rk = 'no-tz';
  const t = setup(rk);
  delete (t.restaurants[0] as Record<string, unknown>).timezone;
  const r = await run(t, pickup(rk, [line(rk, 'pie', 'Large')]));
  expectError(r, 500, 'pricing_config_invalid');
  assertEquals((r.body as { message: string }).message, 'Pricing is temporarily unavailable for this restaurant.');
  assert(JSON.stringify(r.logs).includes('timezone'));
});

Deno.test('invalid timezone and tax_rate as a percent (8.875) → pricing_config_invalid', async () => {
  for (const [rk, over] of [['bad-tz', { timezone: 'Mars/Olympus' }], ['bad-tax', { tax_rate: '8.875' }]] as const) {
    const t = setup(rk, over as Partial<RestaurantRow>);
    expectError(await run(t, pickup(rk, [line(rk, 'pie', 'Large')])), 500, 'pricing_config_invalid');
  }
});

Deno.test('item price with > 2 decimals → pricing_config_invalid (never rounded)', async () => {
  const rk = 'bad-price';
  const t = setup(rk);
  t.item_sizes.find((s) => s.id === id(`${rk}:size:pie:Large`))!.price = '18.995';
  expectError(await run(t, pickup(rk, [line(rk, 'pie', 'Large')])), 500, 'pricing_config_invalid');
});

// ---- availability / menu integrity ------------------------------------------------------------------------

Deno.test('unavailable item and unavailable topping → 409 item_unavailable', async () => {
  const rk = 'unavail';
  const t = setup(rk);
  t.menu_items.find((i) => i.id === id(`${rk}:item:knots`))!.is_available = false;
  t.toppings.find((x) => x.id === id(`${rk}:top:sausage`))!.is_available = false;
  expectError(await run(t, pickup(rk, [line(rk, 'knots', '6 pc')])), 409, 'item_unavailable');
  expectError(await run(t, pickup(rk, [line(rk, 'pie', 'Large', 1, [['sausage', 'whole']])])), 409, 'item_unavailable');
});

Deno.test('menu integrity: foreign item, foreign/unlinked topping, wrong size, missing size, placements, duplicates', async () => {
  const rk = 'integrity';
  const t = setup(rk);
  addMenu(t, 'other');
  t.restaurants.push(restaurantRow(id('other')));
  const cases: [unknown[], number, string][] = [
    [[line('other', 'pie', 'Large')], 400, 'item_not_found'],
    [[{ ...line(rk, 'pie', 'Large'), modifiers: [{ toppingId: id('other:top:pepperoni'), placement: 'whole' }] }], 400, 'topping_not_allowed'],
    [[line(rk, 'pie', 'Large', 1, [['ranch']])], 400, 'topping_not_allowed'], // wings add-on on a pie
    [[{ ...line(rk, 'pie', null), itemSizeId: id(`${rk}:size:knots:6 pc`) }], 400, 'size_not_found'],
    [[line(rk, 'pie', null)], 400, 'size_not_found'],
    [[line(rk, 'pie', 'Large', 1, [['pepperoni']])], 400, 'invalid_placement'],
    [[line(rk, 'wings', '10 pc', 1, [['ranch', 'left']])], 400, 'invalid_placement'],
    [[line(rk, 'pie', 'Large', 1, [['pepperoni', 'left'], ['pepperoni', 'right']])], 400, 'duplicate_modifier'],
  ];
  for (const [lines, status, code] of cases) expectError(await run(t, pickup(rk, lines)), status, code);
});

// ---- delivery -----------------------------------------------------------------------------------------------------

const DELIVERY = { delivery_max_radius_miles: '5', delivery_tier1_max_miles: '2', delivery_tier1_fee_cents: 299, delivery_tier2_fee_cents: 499 };
const delivery = (rk: string, at: Record<string, unknown>, lines: unknown[]) => ({ restaurantId: id(rk), orderType: 'delivery', delivery: at, lines });

Deno.test('in-house delivery: distance computed server-side from coordinates → tier fee; range; minimum', async () => {
  const rk = 'inhouse';
  const t = setup(rk, { ...DELIVERY, delivery_minimum_in_house: '15.00' });
  const pie = [line(rk, 'pie', 'Large')];
  const near = ok(await run(t, delivery(rk, pointAtMiles(1.5), pie)));
  assertEquals([near.breakdown.deliveryFee, near.resolved.deliveryMode, near.resolved.distanceMiles], [299, 'in_house', 1.5]);
  assertEquals(ok(await run(t, delivery(rk, pointAtMiles(3), pie))).breakdown.deliveryFee, 499);
  expectError(await run(t, delivery(rk, pointAtMiles(5.5), pie)), 422, 'out_of_delivery_range');
  expectError(await run(t, delivery(rk, pointAtMiles(1), [line(rk, 'knots', '6 pc')])), 422, 'below_delivery_minimum');
  expectError(await run(t, { restaurantId: id(rk), orderType: 'delivery', lines: pie }), 400, 'delivery_location_required');
  expectError(await run(t, delivery(rk, { distanceMiles: 0.1, ...pointAtMiles(1) }, pie)), 400, 'invalid_request');
});

function uberSetup(rk: string, over: Partial<RestaurantRow> = {}) {
  const t = setup(rk, { delivery_fulfillment: 'uber_direct', uber_credentials_verified_at: '2026-01-01T00:00:00Z', uber_passthrough_mode: 'split', uber_passthrough_value: '50', ...over });
  const p = pointAtMiles(3);
  t.uber_quotes.push({ quote_id: 'dqt_ok', restaurant_id: id(rk), uber_quoted_fee_cents: 899, customer_delivery_fee_cents: 450, expires_at: '2026-11-19T17:10:00Z', dropoff_lat: p.lat, dropoff_lng: p.lng });
  return t;
}

Deno.test('Uber quote: fee from the cached quote (passthrough re-checked), coords from the quote', async () => {
  const rk = 'uber';
  const t = uberSetup(rk);
  const r = ok(await run(t, delivery(rk, { ...pointAtMiles(0.1), uberQuoteId: 'dqt_ok' }, [line(rk, 'pie', 'Large')])));
  assertEquals([r.breakdown.deliveryFee, r.resolved.deliveryMode, r.resolved.uberQuoteId, r.resolved.distanceMiles], [450, 'uber_direct', 'dqt_ok', 3]);
});

Deno.test('Uber quote failures: required / not found / wrong restaurant / expiring / passthrough changed / extended radius', async () => {
  const rk = 'uber-bad';
  const t = uberSetup(rk);
  t.uber_quotes.push({ quote_id: 'dqt_foreign', restaurant_id: id('elsewhere'), uber_quoted_fee_cents: 899, customer_delivery_fee_cents: 450, expires_at: '2026-11-19T17:10:00Z', dropoff_lat: 40, dropoff_lng: -74 });
  t.uber_quotes.push({ quote_id: 'dqt_soon', restaurant_id: id(rk), uber_quoted_fee_cents: 899, customer_delivery_fee_cents: 450, expires_at: '2026-11-19T17:00:30Z', dropoff_lat: 40, dropoff_lng: -74 });
  t.uber_quotes.push({ quote_id: 'dqt_stale', restaurant_id: id(rk), uber_quoted_fee_cents: 899, customer_delivery_fee_cents: 899, expires_at: '2026-11-19T17:10:00Z', dropoff_lat: 40, dropoff_lng: -74 });
  const pie = [line(rk, 'pie', 'Large')];
  const at = (q?: string) => ({ ...pointAtMiles(1), ...(q ? { uberQuoteId: q } : {}) });
  expectError(await run(t, delivery(rk, at(), pie)), 409, 'quote_required');
  expectError(await run(t, delivery(rk, at('dqt_missing'), pie)), 409, 'quote_not_found');
  expectError(await run(t, delivery(rk, at('dqt_foreign'), pie)), 409, 'quote_wrong_restaurant');
  expectError(await run(t, delivery(rk, at('dqt_soon'), pie)), 409, 'quote_expired');
  expectError(await run(t, delivery(rk, at('dqt_stale'), pie)), 409, 'quote_passthrough_changed');

  const ext = 'uber-ext';
  const te = uberSetup(ext, { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_max_radius_miles: '2.5', ...DELIVERY });
  expectError(await run(te, delivery(ext, { ...pointAtMiles(3), uberQuoteId: 'dqt_ok', extendedZone: true }, [line(ext, 'pie', 'Large')])), 422, 'out_of_delivery_range');
  // extendedZone claimed on a restaurant that did not opt in → in-house tiers apply, quote ignored
  const plain = setup('uber-noext', DELIVERY);
  const r = ok(await run(plain, delivery('uber-noext', { ...pointAtMiles(1), uberQuoteId: 'dqt_ok', extendedZone: true }, [line('uber-noext', 'pie', 'Large')])));
  assertEquals([r.resolved.deliveryMode, r.breakdown.deliveryFee], ['in_house', 299]);
});

// ---- redemptions ----------------------------------------------------------------------------------------------------

async function redemptionSetup(rk: string, over: Record<string, unknown> = {}) {
  const t = setup(rk);
  const token = await addSession(t, 'owner');
  const other = await addSession(t, 'other');
  const revoked = await addSession(t, 'revoked', { revoked_at: '2026-11-01T00:00:00Z' });
  t.loyalty_rewards.push({ id: id(`${rk}:reward`), min_subtotal_cents: 1000 });
  t.loyalty_redemptions.push({
    id: id(`${rk}:red`), restaurant_id: id(rk), customer_id: id('customer:owner'), status: 'pending', reward_kind: 'discount',
    discount_cents: 300, reward_id: id(`${rk}:reward`), menu_item_id: null, item_size_id: null, code_expires_at: '2026-11-19T17:20:00Z',
    ...over,
  } as never);
  return { t, token, other, revoked };
}

Deno.test('redemption: owner, pending, unexpired, above minimum → discount applied from the row', async () => {
  const rk = 'red-ok';
  const { t, token } = await redemptionSetup(rk);
  const r = ok(await run(t, pickup(rk, [line(rk, 'pie', 'Large')], { loyaltyRedemptionId: id(`${rk}:red`), sessionToken: token })));
  assertEquals([r.breakdown.loyaltyDiscountFace, r.breakdown.netSubtotal], [300, 1599]);
  assertEquals(r.resolved.redemption, { id: id(`${rk}:red`), kind: 'discount' });
  assertEquals(r.resolved.lines.at(-1)!.reward, 'discount');
});

Deno.test('redemption ownership: no session / revoked session / unknown token → 403 requires_signin; another customer → 403 not_yours', async () => {
  const rk = 'red-own';
  const { t, other, revoked } = await redemptionSetup(rk);
  const body = (sessionToken?: string) => pickup(rk, [line(rk, 'pie', 'Large')], { loyaltyRedemptionId: id(`${rk}:red`), ...(sessionToken ? { sessionToken } : {}) });
  expectError(await run(t, body()), 403, 'redemption_requires_signin');
  expectError(await run(t, body(revoked)), 403, 'redemption_requires_signin');
  expectError(await run(t, body('token-nobody')), 403, 'redemption_requires_signin');
  expectError(await run(t, body(other)), 403, 'redemption_not_yours');
});

Deno.test('redemption state: not found / wrong restaurant / not pending / expired → 409; below minimum → 422', async () => {
  const cases: [Record<string, unknown>, number, string, string?][] = [
    [{}, 409, 'redemption_not_found', 'missing'],
    [{ restaurant_id: id('elsewhere') }, 409, 'redemption_wrong_restaurant'],
    [{ status: 'applied' }, 409, 'redemption_not_pending'],
    [{ code_expires_at: '2026-11-19T16:59:00Z' }, 409, 'redemption_expired'],
  ];
  for (const [over, status, code, missing] of cases) {
    const rk = `red-${code}`;
    const { t, token } = await redemptionSetup(rk, over);
    const redId = missing ? id(`${rk}:nope`) : id(`${rk}:red`);
    expectError(await run(t, pickup(rk, [line(rk, 'pie', 'Large')], { loyaltyRedemptionId: redId, sessionToken: token })), status, code);
  }
  const rk = 'red-min';
  const { t, token } = await redemptionSetup(rk);
  expectError(await run(t, pickup(rk, [line(rk, 'knots', '6 pc')], { loyaltyRedemptionId: id(`${rk}:red`), sessionToken: token })), 422, 'reward_below_minimum');
});

Deno.test('item redemption: $0 reward line synthesized from the row (item id from the redemption)', async () => {
  const rk = 'red-item';
  const { t, token } = await redemptionSetup(rk, { reward_kind: 'item', discount_cents: null, menu_item_id: id(`${rk}:item:knots`) });
  t.loyalty_rewards[0].min_subtotal_cents = 0;
  const r = ok(await run(t, pickup(rk, [line(rk, 'pie', 'Large')], { loyaltyRedemptionId: id(`${rk}:red`), sessionToken: token })));
  assertEquals(r.breakdown.lines.map((l) => l.lineTotal), [1899, 0]);
  assertEquals(r.resolved.lines[1], { menuItemId: id(`${rk}:item:knots`), itemSizeId: null, sizeName: null, quantity: 1, discountExempt: true, reward: 'item', modifiers: [] });
});

// ---- unit: parseRate edge used by tip -------------------------------------------------------------------------------

Deno.test('percent tip text is parsed exactly (no float)', async () => {
  const rk = 'tip';
  const t = setup(rk);
  const b = ok(await run(t, pickup(rk, [line(rk, 'specialty', 'Large', 3)], { tip: { mode: 'percent', percent: '15.5' } }))).breakdown;
  assertEquals(b.tip, 907); // 5850 × 0.155 = 906.75 → 907
  assert(parseRate('15.5'));
});

Deno.test('db errors surface as a generic 500 internal_error (detail logged only)', async () => {
  const t = setup('dberr');
  const db = new FakeDb(t);
  db.getActivePromotions = () => Promise.reject(new Error('connection reset; host=db.internal password=hunter2'));
  const logs: unknown[] = [];
  const r = await handlePriceRequest(
    { method: 'POST', headers: headers(), bodyText: JSON.stringify(pickup('dberr', [line('dberr', 'pie', 'Large')])) },
    { db, now: () => NOW, channel: 'online', log: (e, d) => logs.push({ e, d }) },
  );
  expectError(r, 500, 'internal_error');
  assert(!JSON.stringify(r.body).includes('hunter2'));
  assert(JSON.stringify(logs).includes('connection reset'));
  await assertRejects(() => db.getActivePromotions(id('dberr')));
});
