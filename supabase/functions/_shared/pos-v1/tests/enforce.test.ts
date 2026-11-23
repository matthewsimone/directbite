/**
 * CP8 checkout enforcement (enforce.ts) + the zero-import guard (enforceGuard.ts).
 * The guard tests are the proof that a restaurant NOT on POS_V1_ENFORCE_RESTAURANTS is untouched:
 * no run(), no DB call, no import.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { PricingBreakdown } from '../../ordr-core/order/index.ts';
import type { RestaurantRow } from '../db.ts';
import { enforceCheckout, type ServiceInfo } from '../enforce.ts';
import { guardCheckout, isEnforced, parseEnforceList } from '../enforceGuard.ts';
import { handlePriceRequest, type QuoteResponse } from '../handler.ts';
import type { Resolved } from '../loader.ts';
import { addMenu, emptyTables, FakeDb, headers, id, line, NOW, pointAtMiles, restaurantRow, type Tables } from './fixtures.ts';

// NOW = 2026-11-19T17:00Z = Thursday 12:00 America/New_York

function setup(rk: string, over: Partial<RestaurantRow> = {}): Tables {
  const t = emptyTables();
  t.restaurants.push(restaurantRow(id(rk), { tax_rate: '0.06625', ...over }));
  addMenu(t, rk);
  return t;
}

async function quote(t: Tables, body: Record<string, unknown>): Promise<QuoteResponse> {
  const r = await handlePriceRequest({ method: 'POST', headers: headers(), bodyText: JSON.stringify(body) }, { db: new FakeDb(t), now: () => NOW, channel: 'online', log: () => {} });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body as QuoteResponse;
}

const d = (c: number) => c / 100;

/** order_data as buildOrderData sends it for this server price. */
function webOrderData(b: PricingBreakdown, res: Resolved, extra: Record<string, unknown> = {}) {
  return {
    restaurant_id: res.restaurantId,
    order_type: res.orderType,
    subtotal: d(b.subtotal), discount_amount: d(b.promoDiscount), delivery_fee: d(b.deliveryFee), tax_amount: d(b.tax),
    tip_amount: d(b.tip), service_fee: d(b.serviceFee), total_amount: d(b.total), scheduled_for: null,
    items: res.lines.map((l, i) => ({
      menu_item_id: l.menuItemId, item_size_id: l.itemSizeId, quantity: l.quantity,
      base_price: d(b.lines[i].unit - b.lines[i].modifiers.reduce((s, m) => s + m.charge, 0)),
      toppings: l.modifiers.map((m, k) => ({ topping_id: m.toppingId, placement: m.placement, placement_type: m.kind, price_charged: d(b.lines[i].modifiers[k].charge) })),
    })),
    ...extra,
  };
}

const OPEN_HOURS = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ day_of_week: dow, is_open: true, open_time: '11:00:00', close_time: '22:00:00' }));
const info = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({ is_open: true, delivery_available: true, pickup_schedule: null, delivery_schedule: null, timezone: 'America/New_York', hours: OPEN_HOURS, ...over });

async function pickupCase(rk: string) {
  const t = setup(rk);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large', 2, [['pepperoni', 'left']])] });
  return { t, q, od: webOrderData(q.breakdown, q.resolved) };
}

const run = (t: Tables, rk: string, od: unknown, amount: unknown, inf: ServiceInfo | null = info(), now = NOW) =>
  enforceCheckout({ restaurantId: id(rk), orderData: od, clientAmount: amount, sessionToken: null, now }, { db: new FakeDb(t), loadServiceInfo: () => Promise.resolve(inf) });

// ---- the guard: non-enforced restaurants are untouched ----------------------------------------

Deno.test('GUARD: empty / unset / blank POS_V1_ENFORCE_RESTAURANTS → nothing enforced, run() never called (no DB, no import)', async () => {
  for (const raw of [undefined, null, '', ' ', ',,']) {
    const list = parseEnforceList(raw);
    assertEquals(list.size, 0);
    let called = false;
    const r = await guardCheckout(list, id('any'), () => {
      called = true;
      throw new Error('must not run');
    });
    assertEquals([r, called], [null, false], String(raw));
  }
});

Deno.test('GUARD: only listed ids are enforced (case-insensitive, trimmed); others return null without run()', async () => {
  const list = parseEnforceList(` ${id('a').toUpperCase()} , ${id('b')}`);
  assert(isEnforced(list, id('a')) && isEnforced(list, id('b')));
  assert(!isEnforced(list, id('c')) && !isEnforced(list, null) && !isEnforced(list, 42));
  let calls = 0;
  const verdict = { status: 409, body: { error: 'restaurant_closed' } };
  assertEquals(await guardCheckout(list, id('c'), () => { calls++; return Promise.resolve(verdict); }), null);
  assertEquals(calls, 0);
  assertEquals(await guardCheckout(list, id('a'), () => { calls++; return Promise.resolve(verdict); }), verdict);
  assertEquals(calls, 1);
});

Deno.test('GUARD: a throw inside an enforced run (incl. a failed dynamic import) → 503 pricing_unavailable, fail closed', async () => {
  const logs: string[] = [];
  const r = await guardCheckout(parseEnforceList(id('a')), id('a'), () => Promise.reject(new Error('module not found')), (e) => logs.push(e));
  assertEquals(r, { status: 503, body: { error: 'pricing_unavailable', reason: 'internal_error' } });
  assertEquals(logs, ['enforce failed']);
});

// ---- price (G1-lite) ------------------------------------------------------------------------------

Deno.test('price: exact amount ok; underpay > 2¢ → 409 price_changed + server_total_cents; ≤ 2¢ under ok; overpay unchanged', async () => {
  const rk = 'enf-price';
  const { t, q, od } = await pickupCase(rk);
  const total = q.breakdown.total;
  assertEquals(await run(t, rk, od, total), null);
  assertEquals(await run(t, rk, od, total - 2), null);
  assertEquals(await run(t, rk, od, total - 3), { status: 409, body: { error: 'price_changed', server_total_cents: total } });
  assertEquals(await run(t, rk, od, 50), { status: 409, body: { error: 'price_changed', server_total_cents: total } }, 'tampered amount');
  assertEquals(await run(t, rk, od, total + 500), null, 'paying more is left alone');
  for (const bad of ['1000', 12.5, null, NaN]) assertEquals((await run(t, rk, od, bad))?.body.error, 'price_changed', String(bad));
});

Deno.test('price: the client\'s line prices / subtotal are ignored — the server prices from ids', async () => {
  const rk = 'enf-ids';
  const { t, q, od } = await pickupCase(rk);
  const tampered = { ...od, subtotal: 0.01, items: od.items.map((i) => ({ ...i, base_price: 0.01 })) };
  assertEquals((await run(t, rk, tampered, 1))?.body, { error: 'price_changed', server_total_cents: q.breakdown.total });
});

Deno.test('price: untranslatable cart / in-house delivery without coords / pricer rejection → 503 pricing_unavailable with a reason (fail closed)', async () => {
  const rk = 'enf-503';
  const { t, q, od } = await pickupCase(rk);
  assertEquals(await run(t, rk, { ...od, items: 'nope' }, q.breakdown.total), { status: 503, body: { error: 'pricing_unavailable', reason: 'untranslatable' } });
  assertEquals(await run(t, rk, { ...od, order_type: 'delivery', dropoff_lat: null, dropoff_lng: null }, q.breakdown.total), { status: 503, body: { error: 'pricing_unavailable', reason: 'no_coords' } });
  t.menu_items.find((m) => m.id === id(`${rk}:item:pie`))!.is_available = false;
  assertEquals(await run(t, rk, od, q.breakdown.total), { status: 503, body: { error: 'pricing_unavailable', reason: 'item_unavailable' } });
  assertEquals(await run(t, rk, { ...od, order_type: 'dine_in' }, 1), { status: 503, body: { error: 'pricing_unavailable', reason: 'order_type' } });
  assertEquals(await run(t, rk, od, 1, null), { status: 503, body: { error: 'pricing_unavailable', reason: 'restaurant_info' } });
  assertEquals(await run(t, rk, od, 1, info({ timezone: 'Mars/Base' })), { status: 503, body: { error: 'pricing_unavailable', reason: 'timezone' } });
});

Deno.test('price: in-house delivery priced from coords (tier fee included)', async () => {
  const rk = 'enf-deliv';
  const t = setup(rk, { delivery_max_radius_miles: '5', delivery_tier1_fee_cents: 299 });
  const p = pointAtMiles(1);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'delivery', lines: [line(rk, 'pie', 'Large')], delivery: { lat: p.lat, lng: p.lng } });
  const od = webOrderData(q.breakdown, q.resolved, { dropoff_lat: p.lat, dropoff_lng: p.lng });
  assert(q.breakdown.deliveryFee > 0);
  assertEquals(await run(t, rk, od, q.breakdown.total), null);
  assertEquals((await run(t, rk, { ...od, delivery_fee: 0 }, q.breakdown.total - q.breakdown.deliveryFee))?.body.error, 'price_changed', 'dropping the delivery fee (P1)');
});

// ---- pause / delivery switch / hours (P2, P6, decision A) --------------------------------------------

Deno.test('pause (decision A): is_open=false → 409 restaurant_closed for ASAP AND scheduled; checked before price', async () => {
  const rk = 'enf-pause';
  const { t, od } = await pickupCase(rk);
  assertEquals(await run(t, rk, od, 1, info({ is_open: false })), { status: 409, body: { error: 'restaurant_closed', reason: 'paused' } });
  assertEquals(await run(t, rk, { ...od, scheduled_for: '2026-11-20T23:00:00.000Z' }, 1, info({ is_open: false })), { status: 409, body: { error: 'restaurant_closed', reason: 'paused' } });
});

Deno.test('delivery switch (P2): delivery while delivery_available=false → 409 delivery_unavailable; pickup unaffected', async () => {
  const rk = 'enf-switch';
  const { t, q, od } = await pickupCase(rk);
  assertEquals(await run(t, rk, { ...od, order_type: 'delivery' }, 1, info({ delivery_available: false })), { status: 409, body: { error: 'delivery_unavailable' } });
  assertEquals(await run(t, rk, od, q.breakdown.total, info({ delivery_available: false })), null);
});

Deno.test('hours (P6): ASAP outside the type\'s schedule → restaurant_closed; per-service schedules; no hours at all = closed', async () => {
  const rk = 'enf-hours';
  const { t, q, od } = await pickupCase(rk);
  const night = new Date('2026-11-19T08:00:00Z'); // Thu 03:00 NY
  assertEquals(await run(t, rk, od, q.breakdown.total, info(), night), { status: 409, body: { error: 'restaurant_closed', reason: 'outside_hours' } });
  // delivery schedule closes at 14:00 while pickup (hours) is open until 22:00
  const deliverySchedule = { '4': { enabled: true, windows: [{ start: '11:00', end: '11:30' }] } };
  const p = pointAtMiles(1);
  const deliveryOd = { ...od, order_type: 'delivery', dropoff_lat: p.lat, dropoff_lng: p.lng };
  assertEquals((await run(t, rk, deliveryOd, 1, info({ delivery_schedule: deliverySchedule })))?.body, { error: 'restaurant_closed', reason: 'outside_hours' });
  assertEquals(await run(t, rk, od, q.breakdown.total, info({ delivery_schedule: deliverySchedule })), null, 'pickup follows its own schedule');
  assertEquals((await run(t, rk, od, 1, info({ hours: [] })))?.body, { error: 'restaurant_closed', reason: 'outside_hours' });
});

Deno.test('scheduled (P6): inside a future window → ok even when closed now; outside / before the open buffer / > 7 days / past / unparseable → slot_unavailable', async () => {
  const rk = 'enf-slot';
  const { t, q, od } = await pickupCase(rk);
  const night = new Date('2026-11-19T08:00:00Z'); // Thu 03:00 NY — closed for ASAP
  const at = (iso: string) => ({ ...od, scheduled_for: iso });
  assertEquals(await run(t, rk, at('2026-11-19T23:00:00.000Z'), q.breakdown.total, info(), night), null, 'today 18:00');
  assertEquals(await run(t, rk, at('2026-11-19T16:15:00.000Z'), q.breakdown.total, info(), night), { status: 409, body: { error: 'slot_unavailable', reason: 'outside_hours' } }, '11:15 < 11:30 buffer');
  assertEquals((await run(t, rk, at('2026-11-20T04:00:00.000Z'), 1, info(), night))?.body, { error: 'slot_unavailable', reason: 'outside_hours' }, '23:00');
  assertEquals((await run(t, rk, at('2026-11-26T23:00:00.000Z'), 1, info(), night))?.body, { error: 'slot_unavailable', reason: 'too_far' });
  assertEquals((await run(t, rk, at('2026-11-18T23:00:00.000Z'), 1, info(), night))?.body, { error: 'slot_unavailable', reason: 'past' });
  assertEquals((await run(t, rk, at('tomorrow at six'), 1, info(), night))?.body, { error: 'slot_unavailable', reason: 'invalid' });
  assertEquals((await run(t, rk, at('2026-11-20T23:00:00.000Z'), 1, info({ hours: [] }), night))?.body, { error: 'slot_unavailable', reason: 'no_schedule' });
});
