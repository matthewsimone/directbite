/**
 * Shadow pricing: translation of the client's order_data, classification of
 * every mismatch class, no PII in the record, insert failures logged.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { PricingBreakdown } from '../../ordr-core/order/index.ts';
import type { Resolved } from '../loader.ts';
import { computeShadow, runShadow, type ShadowInput } from '../shadow.ts';
import { handlePriceRequest, type QuoteResponse } from '../handler.ts';
import { addMenu, addSession, emptyTables, FakeDb, headers, id, line, NOW, pointAtMiles, restaurantRow, type Tables } from './fixtures.ts';
import type { RestaurantRow } from '../db.ts';

const CUSTOMER = {
  customer_name: 'Pat Example',
  customer_phone: '+12015550123',
  customer_email: 'pat@example.com',
  delivery_address: '12 Main St, Westwood NJ',
  special_instructions: 'ring bell',
};

function setup(rk: string, over: Partial<RestaurantRow> = {}): Tables {
  const t = emptyTables();
  t.restaurants.push(restaurantRow(id(rk), { tax_rate: '0.06625', ...over }));
  addMenu(t, rk);
  return t;
}

/** Server quote for an ID-only body (the "truth" the client is compared with). */
async function quote(t: Tables, body: Record<string, unknown>): Promise<QuoteResponse> {
  const r = await handlePriceRequest(
    { method: 'POST', headers: headers(), bodyText: JSON.stringify(body) },
    { db: new FakeDb(t), now: () => NOW, channel: 'online', log: () => {} },
  );
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body as QuoteResponse;
}

const d = (cents: number) => cents / 100;

/** order_data exactly as buildOrderData would send it for this server price (dollars). */
function webOrderData(b: PricingBreakdown, res: Resolved, extra: Record<string, unknown> = {}) {
  const items = res.lines.map((l, i) => ({
    menu_item_id: l.menuItemId,
    item_size_id: l.itemSizeId,
    item_name: 'x',
    size_name: l.sizeName,
    base_price: d(b.lines[i].unit - b.lines[i].modifiers.reduce((s, m) => s + m.charge, 0)),
    quantity: l.quantity,
    discount_exempt: l.discountExempt,
    loyalty_redemption_id: l.reward ? res.redemption!.id : null,
    toppings: l.modifiers.map((m, k) => ({
      topping_id: m.toppingId, topping_name: 't', placement: m.placement,
      price_charged: d(b.lines[i].modifiers[k].charge), placement_type: m.kind,
    })),
  }));
  return {
    restaurant_id: res.restaurantId, order_type: res.orderType, ...CUSTOMER,
    subtotal: d(b.subtotal), discount_amount: d(b.promoDiscount), discount_percentage: b.rates.promoPercent === null ? 0 : Number(b.rates.promoPercent),
    delivery_fee: d(b.deliveryFee), tax_amount: d(b.tax), tip_amount: d(b.tip), service_fee: d(b.serviceFee),
    recoup_amount: d(b.recoup), recoup_rate: Number(b.rates.recoupRate), total_amount: d(b.total),
    loyalty_redemption_id: res.redemption?.id ?? null, items, ...extra,
  };
}

function input(rk: string, orderData: unknown, amount: number, extra: Partial<ShadowInput> = {}): ShadowInput {
  return { restaurantId: id(rk), orderData, clientAmount: amount, sessionToken: null, paymentIntentId: 'pi_test', pendingOrderId: id('po'), path: 'create', ...extra };
}

const shadow = (t: Tables, i: ShadowInput, now = NOW) => computeShadow(new FakeDb(t), i, now);

// ---- parity -------------------------------------------------------------------------------------

Deno.test('parity: a client cart priced like the server → compared, no classes, delta 0', async () => {
  const rk = 'sh-parity';
  const t = setup(rk);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large', 1, [['pepperoni', 'left']]), line(rk, 'wings', '10 pc', 1, [['ranch']])] });
  const rec = await shadow(t, input(rk, webOrderData(q.breakdown, q.resolved), q.breakdown.total));
  assertEquals([rec.outcome, rec.classes, rec.delta_cents, rec.server_total_cents], ['compared', [], 0, q.breakdown.total]);
  assertEquals(rec.pricing_module_hash, q.pricingModuleHash);
});

// ---- money classes ---------------------------------------------------------------------------------

Deno.test('d3_half_topping: web float half of $1.15 = $0.57 vs exact $0.58', async () => {
  const rk = 'sh-d3';
  const t = setup(rk);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large', 1, [['extra_cheese', 'left']])] });
  const od = webOrderData(q.breakdown, q.resolved);
  od.items[0].toppings[0].price_charged = 0.57;
  od.subtotal = d(q.breakdown.subtotal - 1);
  od.total_amount = d(q.breakdown.total - 1);
  const rec = await shadow(t, input(rk, od, q.breakdown.total - 1));
  assertEquals([rec.classes, rec.delta_cents], [['d3_half_topping'], -1]);
});

Deno.test('promo: client used the UTC date (promo ended) while the restaurant-local date still applies it (D14)', async () => {
  const rk = 'sh-promo';
  const t = setup(rk);
  t.promotions.push({ id: id(`${rk}:promo`), restaurant_id: id(rk), discount_percentage: '10', is_active: true, is_perpetual: false, start_date: '2026-11-01', end_date: '2026-11-19' });
  const evening = new Date('2026-11-20T02:30:00Z'); // 21:30 ET on the 19th
  const body = { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large')] };
  // client: no promo (UTC date = the 20th)
  const t2 = setup(`${rk}-nopromo`);
  const q = await quote(t2, { ...body, restaurantId: id(`${rk}-nopromo`), lines: [line(`${rk}-nopromo`, 'pie', 'Large')] });
  const od = webOrderData(q.breakdown, q.resolved, { restaurant_id: id(rk) });
  od.items = od.items.map((it) => ({ ...it, menu_item_id: id(`${rk}:item:pie`), item_size_id: id(`${rk}:size:pie:Large`) }));
  const rec = await shadow(t, input(rk, od, q.breakdown.total), evening);
  assertEquals(rec.classes, ['promo']);
  assert(rec.delta_cents! > 0, 'customer was charged more than the server price');
  assertEquals(rec.resolved!.localDate, '2026-11-19');
});

Deno.test('percent_tip: web 15% of $122.90 = $18.43 (float) vs exact $18.44', async () => {
  const rk = 'sh-tip';
  const t = setup(rk);
  const lines = [line(rk, 'pie', 'Small'), line(rk, 'specialty', 'Large', 2), line(rk, 'knots', '6 pc', 3), line(rk, 'wings', '10 pc'), line(rk, 'caesar', 'Regular', 3), line(rk, 'soda', '2 liter', 2)];
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines, tip: { mode: 'percent', percent: '15' } });
  assertEquals([q.breakdown.discountedSubtotal, q.breakdown.tip], [12290, 1844]);
  const od = webOrderData(q.breakdown, q.resolved, { tip_amount: 18.43, total_amount: d(q.breakdown.total - 1) });
  const rec = await shadow(t, input(rk, od, q.breakdown.total - 1));
  assertEquals([rec.classes, rec.delta_cents, (rec.detail.tip as { mode: string }).mode], [['percent_tip'], -1, 'inferred_percent']);
});

Deno.test('recoup: same base, client recoup 1¢ lower (R4 float) → recoup', async () => {
  const rk = 'sh-recoup';
  const t = setup(rk, { recoup_enabled: true, recoup_rate: '0.0350' });
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large'), line(rk, 'knots', '6 pc')] });
  const b = q.breakdown;
  const od = webOrderData(b, q.resolved, { recoup_amount: d(b.recoup - 1), service_fee: d(b.serviceFee - 1), total_amount: d(b.total - 1) });
  const rec = await shadow(t, input(rk, od, b.total - 1));
  assertEquals(rec.classes, ['recoup']);
});

Deno.test('unknown: stale base price on the client; and an unexplained total', async () => {
  const rk = 'sh-unknown';
  const t = setup(rk);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large')] });
  const od = webOrderData(q.breakdown, q.resolved);
  od.items[0].base_price = 17.99;
  const stale = await shadow(t, input(rk, od, q.breakdown.total - 107));
  assertEquals(stale.classes, ['unknown']);
  const fine = webOrderData(q.breakdown, q.resolved);
  const unexplained = await shadow(t, input(rk, fine, q.breakdown.total + 500));
  assertEquals([unexplained.classes, unexplained.delta_cents], [['unknown'], 500]);
  assertEquals((unexplained.detail.diffs as Record<string, { note: string }>).total.note, 'unexplained');
});

// ---- policy classes -----------------------------------------------------------------------------------

Deno.test('no_coords: in-house delivery without coordinates is its own class (no server price)', async () => {
  const rk = 'sh-nocoords';
  const t = setup(rk, { delivery_max_radius_miles: '5', delivery_tier1_fee_cents: 299 });
  const od = { order_type: 'delivery', dropoff_lat: null, dropoff_lng: null, items: [{ menu_item_id: id(`${rk}:item:pie`), item_size_id: id(`${rk}:size:pie:Large`), quantity: 1, toppings: [] }], tip_amount: 0 };
  const rec = await shadow(t, input(rk, od, 2500));
  assertEquals([rec.outcome, rec.classes, rec.server_total_cents], ['no_coords', ['no_coords'], null]);
});

Deno.test('untranslatable: lines that cannot become IDs are logged with the field, never guessed', async () => {
  const rk = 'sh-untr';
  const t = setup(rk);
  const od = {
    order_type: 'pickup', tip_amount: 3.333,
    items: [
      { menu_item_id: null, item_size_id: null, quantity: 1, toppings: [] },
      { menu_item_id: id(`${rk}:item:pie`), item_size_id: id(`${rk}:size:pie:Large`), quantity: 0, toppings: [] },
      { menu_item_id: id(`${rk}:item:pie`), item_size_id: id(`${rk}:size:pie:Large`), quantity: 1, toppings: [{ topping_id: id(`${rk}:top:pepperoni`), placement: 'quarter', placement_type: 'pizza' }] },
    ],
  };
  const rec = await shadow(t, input(rk, od, 2000));
  assertEquals([rec.outcome, rec.classes], ['untranslatable', ['untranslatable']]);
  assertEquals((rec.detail.untranslatable as { field: string }[]).map((u) => u.field), ['items[0].menu_item_id', 'items[1].quantity', 'items[2].toppings[0].placement', 'tip_amount']);
});

Deno.test('category_window: item ordered outside its category window is flagged, still priced', async () => {
  const rk = 'sh-cat';
  const t = setup(rk);
  // Lunch only, 11:00–15:00 on Thursdays; NOW is Thu 12:00 ET → open; 20:00 ET → closed.
  t.menu_categories[0].availability = { '4': { enabled: true, start: '11:00', end: '15:00' } };
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large')] });
  const od = webOrderData(q.breakdown, q.resolved);
  const open = await shadow(t, input(rk, od, q.breakdown.total));
  assertEquals(open.classes, []);
  const closed = await shadow(t, input(rk, od, q.breakdown.total), new Date('2026-11-20T01:00:00Z'));
  assertEquals([closed.classes, closed.delta_cents], [['category_window'], 0]);
});

Deno.test('uber_dropoff: request coords farther than 0.05 mi from the quote dropoff', async () => {
  const rk = 'sh-uber';
  const t = setup(rk, { delivery_fulfillment: 'uber_direct', uber_credentials_verified_at: '2026-01-01T00:00:00Z' });
  const at = pointAtMiles(3);
  t.uber_quotes.push({ quote_id: 'dqt_1', restaurant_id: id(rk), uber_quoted_fee_cents: 699, customer_delivery_fee_cents: 699, expires_at: '2026-11-19T17:10:00Z', dropoff_lat: at.lat, dropoff_lng: at.lng });
  const q = await quote(t, { restaurantId: id(rk), orderType: 'delivery', delivery: { ...at, uberQuoteId: 'dqt_1' }, lines: [line(rk, 'pie', 'Large')], tip: { mode: 'percent', percent: '18' } });
  const same = webOrderData(q.breakdown, q.resolved, { dropoff_lat: at.lat + 0.0003, dropoff_lng: at.lng, uber_quote_id: 'dqt_1' }); // ~0.02 mi
  assertEquals((await shadow(t, input(rk, same, q.breakdown.total))).classes, []);
  const moved = webOrderData(q.breakdown, q.resolved, { ...pointAtMiles(2), uber_quote_id: 'dqt_1' });
  const odMoved = { ...moved, dropoff_lat: pointAtMiles(2).lat, dropoff_lng: pointAtMiles(2).lng };
  const rec = await shadow(t, input(rk, odMoved, q.breakdown.total));
  assertEquals(rec.classes, ['uber_dropoff']);
  assertEquals((rec.detail.uber_dropoff as { milesFromQuote: number }).milesFromQuote, 1);
});

Deno.test('cap_hit: an over-cap cart is still priced in shadow and flagged', async () => {
  const rk = 'sh-cap';
  const t = setup(rk);
  const lines = Array.from({ length: 51 }, () => line(rk, 'soda', '2 liter'));
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: lines.slice(0, 50) });
  const od = webOrderData(q.breakdown, q.resolved);
  od.items.push({ ...od.items[0] });
  od.subtotal = d(q.breakdown.subtotal + 349);
  const rec = await shadow(t, input(rk, od, 0));
  assert(rec.classes.includes('cap_hit'));
  assertEquals(rec.server_total_cents! > 0, true);
  assertEquals((rec.detail.cap_hits as { cap: string }[])[0].cap, 'lines');
});

Deno.test('server_rejected: client charged an order the server refuses (e.g. below delivery minimum)', async () => {
  const rk = 'sh-reject';
  const t = setup(rk, { delivery_max_radius_miles: '5', delivery_tier1_fee_cents: 299, delivery_minimum_in_house: '15.00' });
  const od = { order_type: 'delivery', ...pointAtMiles(1), dropoff_lat: pointAtMiles(1).lat, dropoff_lng: pointAtMiles(1).lng, tip_amount: 0,
    items: [{ menu_item_id: id(`${rk}:item:knots`), item_size_id: id(`${rk}:size:knots:6 pc`), quantity: 1, toppings: [] }] };
  const rec = await shadow(t, input(rk, od, 1000));
  assertEquals([rec.outcome, rec.server_error_code, rec.classes], ['server_rejected', 'below_delivery_minimum', ['unknown']]);
});

// ---- privacy + recording -------------------------------------------------------------------------------

Deno.test('record has no customer PII, coordinates or session token', async () => {
  const rk = 'sh-pii';
  const t = setup(rk, { delivery_max_radius_miles: '5', delivery_tier1_fee_cents: 299 });
  const token = await addSession(t, 'pii');
  const at = pointAtMiles(1.234567);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'delivery', delivery: at, lines: [line(rk, 'pie', 'Large')] });
  const od = webOrderData(q.breakdown, q.resolved, { dropoff_lat: at.lat, dropoff_lng: at.lng });
  const rec = await shadow(t, input(rk, od, q.breakdown.total, { sessionToken: token }));
  assertEquals(rec.outcome, 'compared');
  const text = JSON.stringify(rec);
  for (const v of [...Object.values(CUSTOMER), token, String(at.lat), String(at.lng)]) assert(!text.includes(v), `record contains ${v}`);
});

Deno.test('runShadow: inserts one row; an insert error (e.g. table not migrated) is logged, not thrown', async () => {
  const rk = 'sh-run';
  const t = setup(rk);
  const q = await quote(t, { restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large')] });
  const od = webOrderData(q.breakdown, q.resolved);
  const inserted: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const client = {
    from(table: string) {
      assertEquals(table, 'pricing_shadow_log'); // reads go through the injected PricingDb
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve({ error: { message: 'relation "pricing_shadow_log" does not exist' } });
        },
      };
    },
  };
  await runShadow(client, input(rk, od, q.breakdown.total), (e) => logs.push(e), new FakeDb(t)); // must not throw
  assertEquals(logs, ['shadow result', 'shadow insert failed']);
  assertEquals(inserted.length, 1);
  assertEquals([inserted[0].outcome, inserted[0].delta_cents, inserted[0].payment_intent_id], ['compared', 0, 'pi_test']);
});
