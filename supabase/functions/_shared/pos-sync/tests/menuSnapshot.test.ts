/**
 * pos-v1-menu-snapshot (SYNC §4, handoff item 1): the body built from DB-shaped rows matches the
 * reference fixture (ordr-pos test/support/fixtures.ts makeSnapshot) field by field; hash stability;
 * the cheap not-modified path; identity + auth codes; money / availability / promotion edges.
 */
import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';
import { canonicalJson, contentHash, SNAPSHOT_HASH_EXCLUDES } from '../canonicalJson.ts';
import { buildMenuSnapshot, SnapshotError, usPhoneE164, wireSizePrices, type SnapshotDb } from '../menuSnapshot.ts';
import { handleMenuSnapshot, SnapshotCache, type SnapshotHandlerDeps } from '../menuSnapshotHandler.ts';
import type { MenuSnapshot } from '../menuSnapshot.ts';
import { err, harness, ok, R1, type Registered } from '../../pos-device/tests/harness.ts';

// ---- fixture (the reference fixture's restaurant, as DB rows) --------------------------------------

const ID = {
  catPizza: 'c0000000-0000-4000-8000-000000000001', catSides: 'c0000000-0000-4000-8000-000000000002', catDrinks: 'c0000000-0000-4000-8000-000000000003',
  pie: 'i0000000-0000-4000-8000-000000000001', knots: 'i0000000-0000-4000-8000-000000000002', soda: 'i0000000-0000-4000-8000-000000000003',
  pieLarge: 's0000000-0000-4000-8000-000000000001', pieSmall: 's0000000-0000-4000-8000-000000000002', knotsReg: 's0000000-0000-4000-8000-000000000003', sodaReg: 's0000000-0000-4000-8000-000000000004',
  gToppings: 'g0000000-0000-4000-8000-000000000001', gAddons: 'g0000000-0000-4000-8000-000000000002',
  pepperoni: 't0000000-0000-4000-8000-000000000001', extraCheese: 't0000000-0000-4000-8000-000000000002', mushrooms: 't0000000-0000-4000-8000-000000000003',
  promo: 'p0000000-0000-4000-8000-000000000001',
};
const NOW = new Date('2026-11-19T16:00:00Z'); // 11:00 New York, Thursday

interface Rows {
  restaurant: Record<string, unknown> | null;
  categories: Record<string, unknown>[];
  items: Record<string, unknown>[];
  sizes: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  toppings: Record<string, unknown>[];
  links: Record<string, unknown>[];
  promos: Record<string, unknown>[];
}

function rows(): Rows {
  return {
    restaurant: {
      id: R1, name: 'Test Pizza', phone: '(201) 555-0100',
      address_street: '100 Washington St', address_city: 'Hoboken', address_state: 'NJ', address_zip: '07030',
      timezone: 'America/New_York', tax_rate: 0.08875,
      delivery_available: true, delivery_fulfillment: 'in_house',
      delivery_max_radius_miles: '5.00', delivery_tier1_max_miles: '2.00', delivery_tier1_fee_cents: 299, delivery_tier2_fee_cents: 499,
      delivery_minimum_in_house: '15.00', delivery_minimum_uber_direct: 0,
      loyalty_enabled: true, loyalty_earn_basis: 'subtotal', loyalty_points_per_dollar: '1.00',
    },
    categories: [
      { id: ID.catDrinks, name: 'Drinks', sort_order: 3, discount_exempt: true, availability: null },
      { id: ID.catPizza, name: 'Pizza', sort_order: 1, discount_exempt: false, availability: null },
      { id: ID.catSides, name: 'Sides', sort_order: 2, discount_exempt: false, availability: { '4': { enabled: true, start: '11:00:00', end: '15:00' }, '5': { enabled: false } } },
    ],
    items: [
      { id: ID.soda, category_id: ID.catDrinks, name: '2-liter soda', description: null, is_available: true, sort_order: 1 },
      { id: ID.pie, category_id: ID.catPizza, name: 'Pie', description: null, is_available: true, sort_order: 1 },
      { id: ID.knots, category_id: ID.catSides, name: 'Garlic knots (6)', description: 'Six knots', is_available: false, sort_order: 1 },
    ],
    sizes: [
      { id: ID.pieLarge, item_id: ID.pie, name: 'Large', price: '18.99', sort_order: 2 },
      { id: ID.pieSmall, item_id: ID.pie, name: 'Small', price: 13.99, sort_order: 1 },
      { id: ID.knotsReg, item_id: ID.knots, name: 'Regular', price: '5.99', sort_order: 1 },
      { id: ID.sodaReg, item_id: ID.soda, name: 'Regular', price: '3.49', sort_order: 1 },
    ],
    groups: [
      { id: ID.gAddons, name: 'Add-ons', placement_type: 'addon', selection_type: 'unlimited', required: false, max_selections: null, sort_order: 2 },
      { id: ID.gToppings, name: 'Toppings', placement_type: 'pizza', selection_type: 'unlimited', required: false, max_selections: null, sort_order: 1 },
    ],
    toppings: [
      { id: ID.mushrooms, topping_group_id: ID.gToppings, name: 'Mushrooms', price: '2.25', price_half: '1.25', size_prices: { small: { price: '1.75', half: '' }, large: { price: 2.25 }, xl: { price: 'n/a' }, junk: 7 }, is_available: true, is_default: false, sort_order: 3 },
      { id: ID.pepperoni, topping_group_id: ID.gToppings, name: 'Pepperoni', price: '2.50', price_half: null, size_prices: null, is_available: true, is_default: false, sort_order: 1 },
      { id: ID.extraCheese, topping_group_id: ID.gToppings, name: 'Extra cheese', price: 1.15, price_half: null, size_prices: {}, is_available: true, is_default: true, sort_order: 2 },
    ],
    links: [
      { item_id: ID.pie, topping_group_id: ID.gAddons, sort_order: 2 },
      { item_id: ID.pie, topping_group_id: ID.gToppings, sort_order: 1 },
    ],
    promos: [],
  };
}

class FakeSnapshotDb implements SnapshotDb {
  calls = 0;
  constructor(public t: Rows) {}
  private r<T>(v: unknown): Promise<T> { this.calls++; return Promise.resolve(structuredClone(v) as T); }
  getRestaurant() { return this.r<never>(this.t.restaurant); }
  getCategories() { return this.r<never>(this.t.categories); }
  getItems() { return this.r<never>(this.t.items); }
  getItemSizes() { return this.r<never>(this.t.sizes); }
  getToppingGroups() { return this.r<never>(this.t.groups); }
  getToppings() { return this.r<never>(this.t.toppings); }
  getItemToppingGroups() { return this.r<never>(this.t.links); }
  getActivePromotions() { return this.r<never>(this.t.promos); }
}

// ---- the expected body (fakeServer-fixture shaped) ---------------------------------------------------

const EXPECTED: Omit<MenuSnapshot, 'hash'> = {
  server_time: NOW.toISOString(),
  restaurant: {
    id: R1,
    name: 'Test Pizza',
    address: { street: '100 Washington St', city: 'Hoboken', state: 'NJ', zip: '07030', phone: '+12015550100' },
    timezone: 'America/New_York',
    business_day_cutoff: '04:00',
    tax_rate: '0.08875',
    recoup_rate: '0',
    delivery: {
      max_radius_miles: '5', tier1_max_miles: '2', tier1_fee_cents: 299, tier2_fee_cents: 499,
      minimum_in_house_cents: 1500, minimum_uber_direct_cents: 0, offline_fee_cents: 499, enabled: true, fulfillment: 'in_house',
    },
    loyalty: { enabled: true, earn_basis: 'subtotal', points_per_dollar: '1' },
  },
  promotion: null,
  categories: [
    { id: ID.catPizza, name: 'Pizza', sort_order: 1, available: true, discount_exempt: false, availability: null },
    { id: ID.catSides, name: 'Sides', sort_order: 2, available: true, discount_exempt: false, availability: { '4': { start: '11:00', end: '15:00' } } },
    { id: ID.catDrinks, name: 'Drinks', sort_order: 3, available: true, discount_exempt: true, availability: null },
  ],
  items: [
    { id: ID.pie, category_id: ID.catPizza, name: 'Pie', description: null, is_available: true, sort_order: 1 },
    { id: ID.knots, category_id: ID.catSides, name: 'Garlic knots (6)', description: 'Six knots', is_available: false, sort_order: 1 },
    { id: ID.soda, category_id: ID.catDrinks, name: '2-liter soda', description: null, is_available: true, sort_order: 1 },
  ].sort((a, b) => (a.category_id < b.category_id ? -1 : 1)),
  item_sizes: [
    { id: ID.pieSmall, item_id: ID.pie, name: 'Small', price_cents: 1399, sort_order: 1 },
    { id: ID.pieLarge, item_id: ID.pie, name: 'Large', price_cents: 1899, sort_order: 2 },
    { id: ID.knotsReg, item_id: ID.knots, name: 'Regular', price_cents: 599, sort_order: 1 },
    { id: ID.sodaReg, item_id: ID.soda, name: 'Regular', price_cents: 349, sort_order: 1 },
  ],
  topping_groups: [
    { id: ID.gToppings, name: 'Toppings', placement_type: 'pizza', selection_type: 'unlimited', required: false, max_selections: null, sort_order: 1 },
    { id: ID.gAddons, name: 'Add-ons', placement_type: 'addon', selection_type: 'unlimited', required: false, max_selections: null, sort_order: 2 },
  ],
  toppings: [
    { id: ID.pepperoni, group_id: ID.gToppings, name: 'Pepperoni', price_cents: 250, price_half_cents: null, size_prices: null, is_available: true, is_default: false, sort_order: 1 },
    { id: ID.extraCheese, group_id: ID.gToppings, name: 'Extra cheese', price_cents: 115, price_half_cents: null, size_prices: null, is_available: true, is_default: true, sort_order: 2 },
    { id: ID.mushrooms, group_id: ID.gToppings, name: 'Mushrooms', price_cents: 225, price_half_cents: 125, size_prices: { small: { price_cents: 175, half_cents: null }, large: { price_cents: 225, half_cents: null } }, is_available: true, is_default: false, sort_order: 3 },
  ],
  item_topping_groups: [
    { item_id: ID.pie, group_id: ID.gToppings, is_active: true, sort_order: 1 },
    { item_id: ID.pie, group_id: ID.gAddons, is_active: true, sort_order: 2 },
  ],
};

const build = (t = rows(), now = NOW) => buildMenuSnapshot(new FakeSnapshotDb(t), R1, now);

// ---- body -------------------------------------------------------------------------------------------

Deno.test('body: every field, field by field, as the reference fixture shapes it (cents, decimal strings, normalized availability, sorted arrays)', async () => {
  const s = await build();
  const { hash, ...body } = s;
  assertEquals(body, EXPECTED);
  assertEquals(hash, await contentHash(s as unknown as Record<string, unknown>, SNAPSHOT_HASH_EXCLUDES));
  assertEquals(hash.length, 64);
  // every key always present (incl. nulls) — canonical JSON would refuse undefined anyway
  canonicalJson(body);
});

Deno.test('hash: stable across DB row order and server_time; changes with any priced field', async () => {
  const a = await build();
  const shuffled = rows();
  for (const k of ['categories', 'items', 'sizes', 'groups', 'toppings', 'links'] as const) shuffled[k].reverse();
  const b = await build(shuffled, new Date('2026-11-19T16:05:00Z'));
  assertEquals(b.hash, a.hash);
  const moved = rows();
  moved.sizes[0].price = '19.49';
  assert((await build(moved)).hash !== a.hash);
});

Deno.test('money: > 2 decimals → SnapshotError naming the field; size_prices invalid entries dropped; bad size key fails closed', async () => {
  const t = rows();
  t.sizes[0].price = '18.999';
  const e = await assertRejects(() => build(t), SnapshotError);
  assertEquals([e.code, e.field], ['snapshot_config_invalid', `item_sizes(${ID.pieLarge}).price`]);
  const t2 = rows();
  t2.restaurant!.delivery_minimum_in_house = '15.005';
  assertEquals((await assertRejects(() => build(t2), SnapshotError)).field, 'restaurants.delivery_minimum_in_house');
  assertEquals(wireSizePrices({ a: { price: '-1' }, b: { price: null, half: '' }, c: 'x', d: { price: '1.5', half: '0' } }, 't'), { d: { price_cents: 150, half_cents: 0 } });
  assertEquals(wireSizePrices({}, 't'), null);
  assertEquals(assertThrows(() => wireSizePrices({ 'large 16"': { price: '2.00' } }, 'tx'), SnapshotError).field, 'toppings(tx).size_prices.large 16"');
});

Deno.test('availability: malformed / disabled / overnight-shaped blobs normalize exactly like the device (fail open → null)', async () => {
  for (const [raw, want] of [
    [{ '4': 'yes' }, null],
    [{ '4': { enabled: true, start: '25:00', end: '15:00' } }, null],
    [{ '4': { enabled: false } }, null],
    [[], null],
    [{ '4': { enabled: true } }, { '4': { start: null, end: null } }],
    [{ '4': { enabled: true, start: '22:00', end: '02:00' } }, { '4': { start: '22:00', end: '02:00' } }],
  ] as [unknown, unknown][]) {
    const t = rows();
    t.categories[2].availability = raw;
    assertEquals((await build(t)).categories[1].availability, want, JSON.stringify(raw));
  }
});

Deno.test('promotion: restaurant-LOCAL date (8 pm ET is still "today"), highest % wins, ties → lowest id', async () => {
  const at8pm = new Date('2026-11-20T01:00:00Z'); // Thu 2026-11-19 20:00 New York (UTC date is already the 20th)
  const t = rows();
  t.promos = [
    { id: ID.promo, restaurant_id: R1, discount_percentage: '10', is_active: true, is_perpetual: false, start_date: '2026-11-19', end_date: '2026-11-19' },
    { id: 'p0000000-0000-4000-8000-000000000009', restaurant_id: R1, discount_percentage: '20', is_active: true, is_perpetual: false, start_date: '2026-11-20', end_date: '2026-11-21' },
  ];
  assertEquals((await build(t, at8pm)).promotion, { id: ID.promo, discount_percent: '10' }, 'the 20th promo has not started locally');
  assertEquals((await build(t, new Date('2026-11-20T05:30:00Z'))).promotion, { id: 'p0000000-0000-4000-8000-000000000009', discount_percent: '20' });
  t.promos.push({ id: 'p0000000-0000-4000-8000-000000000002', restaurant_id: R1, discount_percentage: '10.0', is_active: true, is_perpetual: true, start_date: null, end_date: null });
  assertEquals((await build(t, at8pm)).promotion, { id: ID.promo, discount_percent: '10' }, 'tie → lowest id');
});

Deno.test('restaurant edge values: phone E.164 (US only), blank address parts → null, fulfillment fallback, offline fee tier2 ?? tier1 ?? 0, tax_rate range', async () => {
  assertEquals([usPhoneE164('(201) 555-0100'), usPhoneE164('1-201-555-0100'), usPhoneE164('+12015550100'), usPhoneE164('555-0100'), usPhoneE164('+44 20 7946 0958'), usPhoneE164(null)], ['+12015550100', '+12015550100', '+12015550100', null, null, null]);
  const t = rows();
  Object.assign(t.restaurant!, { address_city: '  ', address_zip: null, delivery_fulfillment: 'weird', delivery_tier2_fee_cents: null, loyalty_points_per_dollar: null });
  const s = await build(t);
  assertEquals([s.restaurant.address.city, s.restaurant.address.zip, s.restaurant.delivery.fulfillment, s.restaurant.delivery.offline_fee_cents, s.restaurant.loyalty.points_per_dollar], [null, null, 'in_house', 299, '1']);
  Object.assign(t.restaurant!, { delivery_tier1_fee_cents: null });
  assertEquals((await build(t)).restaurant.delivery.offline_fee_cents, 0);
  Object.assign(t.restaurant!, { tax_rate: 6.625 });
  assertEquals((await assertRejects(() => build(t), SnapshotError)).field, 'restaurants.tax_rate');
  const gone = rows();
  gone.restaurant = null;
  assertEquals((await assertRejects(() => build(gone), SnapshotError)).code, 'restaurant_not_found');
});

// ---- the function (handler) ------------------------------------------------------------------------

async function setup() {
  const h = harness();
  const dev = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const db = new FakeSnapshotDb(rows());
  const persisted: MenuSnapshot[] = [];
  const deps: SnapshotHandlerDeps = { ...h.deps, snapshotDb: db, persist: (s) => { persisted.push(s); return Promise.resolve(); }, cache: new SnapshotCache() };
  const call = (body: unknown, hdr: Record<string, string> = h.asDevice(dev)) =>
    handleMenuSnapshot({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', ...hdr }), bodyText: JSON.stringify(body), ip: null }, deps);
  return { h, dev, db, persisted, deps, call };
}

Deno.test('handler: full snapshot persisted BEFORE it is served; if_none_match = hash → not_modified; the cheap path does no menu reads', async () => {
  const { h, db, persisted, call } = await setup();
  const first = ok<MenuSnapshot>(await call({ restaurant_id: R1, if_none_match: null }));
  assertEquals(persisted.map((p) => p.hash), [first.hash]);
  const reads = db.calls;
  assertEquals(ok(await call({ restaurant_id: R1, if_none_match: first.hash })), { not_modified: true, hash: first.hash });
  assertEquals(db.calls, reads, 'fresh cached hash → no menu reads');
  h.clock.advance(31_000);
  assertEquals(ok(await call({ restaurant_id: R1, if_none_match: first.hash })), { not_modified: true, hash: first.hash });
  assert(db.calls > reads, 'stale cache → rebuilt');
  assertEquals(persisted.length, 1, 'unchanged hash is not re-persisted');
  // a menu change shows up after the TTL
  db.t.sizes[0].price = '20.99';
  h.clock.advance(31_000);
  const changed = ok<MenuSnapshot>(await call({ restaurant_id: R1, if_none_match: first.hash }));
  assert(changed.hash !== first.hash);
  assertEquals(persisted.length, 2);
  // a stale if_none_match gets the full body
  assertEquals(ok<MenuSnapshot>(await call({ restaurant_id: R1, if_none_match: 'old' })).hash, changed.hash);
});

Deno.test('handler: identity + every auth code (SYNC §1a / §5)', async () => {
  const { h, dev, call } = await setup();
  assertEquals(err(await call({ restaurant_id: crypto.randomUUID(), if_none_match: null })).code, 'restaurant_mismatch');
  assertEquals(err(await call({ restaurant_id: R1, if_none_match: 42 })), { status: 400, code: 'invalid_payload', message: 'if_none_match must be a string or null' });
  assertEquals(err(await call({ restaurant_id: R1 }, {})), { status: 401, code: 'device_unregistered', message: 'no device token' });
  assertEquals(err(await call({ restaurant_id: R1 }, { 'x-ordr-device-token': 'odt_nope', 'x-ordr-device-id': dev.device_id })).code, 'device_unregistered');
  assertEquals(err(await call({ restaurant_id: R1 }, { 'x-ordr-device-token': dev.device_token, 'x-ordr-device-id': crypto.randomUUID() })), { status: 403, code: 'device_mismatch', message: "x-ordr-device-id is not this token's device" });
  ok(await h.admin({ action: 'revoke', device_id: dev.device_id, reason: 'test' }));
  assertEquals(err(await call({ restaurant_id: R1, if_none_match: null })), { status: 401, code: 'device_revoked', message: 'this register was revoked' });
});

Deno.test('handler: bad money → 500 snapshot_config_invalid with the field; persist failure → not served', async () => {
  const { db, deps, call } = await setup();
  db.t.toppings[1].price = '2.505';
  const r = await call({ restaurant_id: R1, if_none_match: null });
  assertEquals([r.status, (r.body as { error: { code: string; field: string } }).error.code, (r.body as { error: { field: string } }).error.field], [500, 'snapshot_config_invalid', `toppings(${ID.pepperoni}).price`]);
  db.t.toppings[1].price = '2.50';
  deps.persist = () => Promise.reject(new Error('db down'));
  await assertRejects(() => call({ restaurant_id: R1, if_none_match: null }), Error, 'db down'); // → handleDeviceHttp maps to 500 internal_error
});
