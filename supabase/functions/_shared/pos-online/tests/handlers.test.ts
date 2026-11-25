/**
 * pos-v1-online-orders + pos-v1-online-print end to end over the device middleware, MemoryOnlineStore (= 110 SQL)
 * and an in-memory PostgREST (fakeSupabase.ts). Scenarios ported from the reference (ordr-pos @ 7798d52):
 *   test/support/fakeOnline.ts poll :501-537 / print :273-316 / served :540-545 (server behaviour),
 *   test/online/print.test.ts — "exactly once" :110-235, "arrival + copies + reprint" :237-269, "NOT PRINTED + Print"
 *   :271-329, "STATION ROUTING" :369-550 (the server-observable parts: claims, per-station results, print_status,
 *   print_logs), test/online/feed.test.ts (not_modified token, settings hash).
 * Every served row / settings blob is checked with the POS's own parser (referenceParse.ts) — never unreadable.
 * Test Pizza (R1), negative order numbers, made-up ids.
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { err, FAKE_IP, ok, R1, R2 } from '../../pos-device/tests/harness.ts';
import { handleOnlineOrders } from '../handlers.ts';
import { contentHash } from '../../pos-sync/canonicalJson.ts';
import { UNCONFIRMED_ERROR } from '../printRules.ts';
import type { OnlineOrderWire, OnlineSettingsWire } from '../wire.ts';
import { parseOnlineOrder, settingsProblem } from './referenceParse.ts';
import { CAT_PIZZA, CAT_SIDES, COUNTER, ITEM_CHEESE, ITEM_KNOTS, khRow, ordrRow, OVEN, served, uid, world } from './world.ts';

// ---- feed --------------------------------------------------------------------------------------------

Deno.test('feed: the §3c wire — every key, cents, per-line menu_item_id + CURRENT category_id; the POS parser reads it', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const body = ok<Record<string, unknown>>(await w.poll());
  const [o] = served(body);
  assertEquals(Object.keys(body).sort(), ['menu_snapshot_hash', 'not_modified', 'orders', 'server_time', 'settings', 'token']);
  assertEquals(Object.keys(o).sort(), [
    'accepted_at', 'acknowledged_at', 'adjustments', 'cancelled_by', 'channel', 'channel_status', 'created_at', 'customer', 'delivery', 'external', 'id',
    'include_utensils', 'items', 'items_written_at', 'money', 'order_number', 'order_type', 'print', 'quoted_for', 'refund', 'restaurant_id',
    'scheduled_for', 'special_instructions', 'status', 'stuck_acknowledged_at',
  ]);
  assertEquals(o.items.map((i) => [i.menu_item_id, i.category_id, i.item_name, i.line_total_cents, i.mapped]), [
    [ITEM_CHEESE, CAT_PIZZA, 'Cheese Pizza', 2099, true],
    [ITEM_KNOTS, CAT_SIDES, 'Garlic Knots', 599, true],
  ]);
  assertEquals(o.items[0].toppings, [{ name: 'Pepperoni', placement: 'whole', placement_type: 'pizza', price_cents: 200, qty: 1, group: null, depth: 0 }]);
  assertEquals(o.money, { subtotal_cents: 2698, discount_cents: 0, discount_percentage: null, loyalty_discount_cents: 0, delivery_fee_cents: 0, tax_cents: 239, service_fee_cents: 150, tip_cents: 405, total_cents: 3492, problems: [] });
  assertEquals(o.customer, { name: 'Test Customer', phone: '+15165550142' });
  assertEquals([o.channel, o.channel_status, o.order_number, o.delivery, o.external, o.refund.status], ['ordr', 'new', row.order_number, null, null, 'none']);
  assertEquals(o.print, { stations: [], claimed_by_device_id: null, claimed_at: null, result: null, printed_at: null, attempts: [], print_status: 'pending', print_attempts: 0 });
  assertEquals((body as { menu_snapshot_hash: unknown }).menu_snapshot_hash, null);
});

Deno.test('feed: a line whose menu item is gone / a loyalty discount line → null ids; adjustments oldest first, cents', async () => {
  const w = await world();
  const at = w.nowIso();
  const row = ordrRow(at, { status: 'complete' });
  row.order_items[1] = { ...row.order_items[1], menu_item_id: null, menu_items: null, item_name: 'Reward: $5 off', base_price: 0, loyalty_redemption_id: uid('d') };
  row.order_items[0] = { ...row.order_items[0], menu_items: null }; // the item was deleted from the menu since
  row.adjustment_requests = [
    { id: uid('9'), type: 'refund', amount: 3.5, note: 'cold', status: 'approved', created_at: '2026-11-19T17:05:00Z', approved_at: '2026-11-19T17:10:00Z' },
    { id: uid('9'), type: 'charge', amount: 2, note: 'extra sauce', status: 'pending', created_at: '2026-11-19T17:01:00Z', approved_at: null },
  ];
  w.db.insertRow('orders', row);
  const [o] = served(ok(await w.poll()));
  assertEquals(o.items.map((i) => [i.menu_item_id, i.category_id, i.loyalty_reward]), [[ITEM_CHEESE, null, false], [null, null, true]]);
  assertEquals(o.adjustments.map((a) => [a.type, a.amount_cents, a.status]), [['charge', 200, 'pending'], ['refund', 350, 'approved']]);
});

Deno.test('feed: only WRITTEN orders of the principal\'s restaurant (items_written_at set — D6)', async () => {
  const w = await world();
  const at = w.nowIso();
  const mine = ordrRow(at);
  w.db.insertRow('orders', mine);
  w.db.insertRow('orders', ordrRow(at, { items_written_at: null }));
  w.db.insertRow('orders', ordrRow(at, { restaurant_id: R2 }));
  assertEquals(served(ok(await w.poll())).map((o) => o.id), [mine.id]);
  assertEquals(err(await w.poll({ restaurant_id: R2 })), { status: 400, code: 'restaurant_mismatch', message: "not this device's restaurant" });
});

Deno.test('feed: a booked scheduled Uber order reads delivery.status scheduled; refund columns → cents', async () => {
  const w = await world();
  const at = w.nowIso();
  w.db.insertRow('orders', ordrRow(at, {
    status: 'scheduled', order_type: 'delivery', scheduled_for: '2026-11-19T23:00:00Z', delivery_address: '41 Glen Cove Ave, Glen Cove, NY 11542',
    delivery_fulfillment_method: 'uber_direct', uber_delivery_id: 'del_test', uber_status: 'pending', uber_tracking_url: 'https://delivery.example/t',
    uber_pickup_ready_dt: '2026-11-19T22:45:00Z', refund_status: 'partial', refund_amount: 5.25, refunded_at: at, refund_reason: 'cold',
  }));
  const [o] = served(ok(await w.poll()));
  assertEquals([o.delivery!.provider, o.delivery!.status, o.delivery!.provider_status, o.delivery!.pickup_ready_at], ['uber_direct', 'scheduled', 'pending', '2026-11-19T22:45:00.000Z']);
  assert(o.delivery!.dispatched_at !== null); // set ⇔ booked
  assertEquals(o.refund, { status: 'partial', amount_cents: 525, refunded_at: at, reason: 'cold' });
});

Deno.test('feed: opaque token → not_modified with no orders; a print result changes it', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const first = ok<{ token: string }>(await w.poll());
  const again = ok<{ not_modified: boolean; orders: unknown[]; token: string }>(await w.poll({ if_none_match: first.token }));
  assertEquals([again.not_modified, again.orders, again.token], [true, [], first.token]);
  ok(await w.print({ order_id: row.id, op: 'result', variant: 'manual', result: 'printed', station: COUNTER }));
  const after = ok<{ not_modified: boolean; token: string }>(await w.poll({ if_none_match: first.token }));
  assertEquals(after.not_modified, false);
  assertNotEquals(after.token, first.token);
});

Deno.test('feed: settings — the POS flags from pos_restaurant_settings (defaults without a row), canonical hash, not_modified', async () => {
  const w = await world();
  const s1 = ok<{ settings: OnlineSettingsWire }>(await w.poll()).settings;
  assertEquals(settingsProblem(s1), null);
  assertEquals([s1.online_print_device_id, s1.online_auto_print_enabled, s1.kitchenhub_auto_print_enabled, s1.pos_online_orders_enabled], [null, false, false, false]);
  assertEquals([s1.timezone, s1.business_day_cutoff, s1.print_trigger, s1.receipt_font, s1.auto_print_copies], ['America/New_York', '04:00', 'received', 'normal', 1]);
  assertEquals(s1.service_windows.pickup!['1'], [{ start: '11:00', end: '22:00' }]);
  assertEquals(s1.delivery_providers, [{ id: 'in_house', label: 'In-house', active: true }, { id: 'uber_direct', label: 'Uber Direct', active: true }]);
  const { hash, ...rest } = s1;
  assertEquals(hash, await contentHash(rest as unknown as Record<string, unknown>, []));
  assertEquals(ok<{ settings: unknown }>(await w.poll({ if_none_match_settings: hash })).settings, { not_modified: true, hash });
  await w.autoOn();
  const s2 = ok<{ settings: OnlineSettingsWire }>(await w.poll({ if_none_match_settings: hash })).settings;
  assertEquals([s2.online_print_device_id, s2.online_auto_print_enabled, s2.kitchenhub_auto_print_enabled, s2.pos_online_orders_enabled], [w.A.device_id, true, true, true]);
  assertNotEquals(s2.hash, hash);
});

Deno.test('feed: KitchenHub rows only when dsp_orders_enabled — §3c mapping (mapped false, null prices, charges → cents / problems)', async () => {
  const off = await world();
  off.db.insertRow('external_orders', khRow(off.nowIso()));
  assertEquals(served(ok(await off.poll())), []);
  assert(!off.db.calls.some(([t]) => t === 'external_orders'));

  const w = await world({ restaurant: { dsp_orders_enabled: true } });
  const at = w.nowIso();
  const kh = khRow(at);
  w.db.insertRow('external_orders', kh);
  w.db.insertRow('dsp_provider_status', { restaurant_id: R1, provider_id: 'doordash', pause_until: '2026-11-19T18:00:00Z' });
  const body = ok<{ settings: OnlineSettingsWire }>(await w.poll());
  const [o] = served(body);
  assertEquals([o.channel, o.channel_status, o.status, o.order_number, o.items_written_at, o.created_at], ['kitchenhub', 'new', 'new', kh.kh_order_id, at, at]);
  assertEquals(o.items.map((i) => [i.menu_item_id, i.category_id, i.mapped, i.line_total_cents, i.quantity, i.special_instructions]), [
    [null, null, false, null, 1, null],
    [null, null, false, null, 2, 'No onions'],
  ]);
  assertEquals(o.items[0].toppings.map((t) => [t.name, t.group, t.depth, t.qty, t.price_cents]), [
    ['Half & Half', 'Style', 0, 1, null], ['Left: Pepperoni', 'Half & Half', 1, 1, null], ['Right: Mushroom', 'Half & Half', 1, 1, null], ['Extra cheese', 'Extras', 0, 2, null],
  ]);
  assertEquals(o.money, { subtotal_cents: 4147, discount_cents: null, discount_percentage: null, loyalty_discount_cents: null, delivery_fee_cents: null, tax_cents: 368, service_fee_cents: null, tip_cents: 500, total_cents: 5015, problems: ['service_fee'] });
  assertEquals(o.external, {
    provider: 'doordash', provider_order_code: 'A1B2C', asap: true, pickup_at: null, placed_at: at, completed_at: null, cancelled_at: null,
    prep_time_minutes: null, paid: true, payment_method: 'card', delivery_type: 'provider', courier: { name: 'Sam', phone: null, status: 'assigned' },
  });
  assertEquals([o.adjustments, o.refund.status, o.delivery], [[], 'none', null]);
  assertEquals(JSON.stringify(o).includes('never'), false); // raw is never read or served
  assertEquals(body.settings.kitchenhub_providers, [{ id: 'doordash', label: 'DoorDash', paused_until: '2026-11-19T18:00:00.000Z' }]);
  // accepted → in_progress
  w.db.rows('external_orders')[0].status = 'accepted';
  assertEquals(served(ok(await w.poll()))[0].status, 'in_progress');
});

Deno.test('feed: > 500 rows → 503 feed_too_large (never a truncated list)', async () => {
  const w = await world();
  const at = w.nowIso();
  for (let i = 0; i < 501; i++) w.db.insertRow('orders', ordrRow(at, { order_items: [], adjustment_requests: [] }));
  assertEquals(err(await w.poll()), { status: 503, code: 'feed_too_large', message: 'too many online orders to send at once' });
});

Deno.test('feed: history { business_date } — read-only, token history:D, bad date 400; device auth + body checks', async () => {
  const w = await world();
  w.db.insertRow('orders', ordrRow(w.nowIso()));
  const hb = ok<{ token: string; not_modified: boolean }>(await w.poll({ history: { business_date: '2026-11-18' }, if_none_match: 'history:2026-11-18' }));
  assertEquals([hb.token, hb.not_modified], ['history:2026-11-18', false]);
  assert(w.db.calls.some(([t, op, f]) => t === 'orders' && op === 'or' && String(f).includes('scheduled_for.is.null')));
  assertEquals(err(await w.poll({ history: { business_date: '2026-02-30' } })).code, 'invalid_payload');
  assertEquals(err(await w.poll({ if_none_match: 5 })).code, 'invalid_payload');
  const noAuth = await handleOnlineOrders({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1' }), bodyText: '{}', ip: FAKE_IP }, w.deps);
  assertEquals(noAuth.status, 401);
});

// ---- print -------------------------------------------------------------------------------------------

Deno.test('print: exactly once — the print register claims every station (counter first); the other register never does', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  assertEquals(err(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] })).code, 'not_designated');
  await w.online.setPrintRegister(R1, w.A.device_id, 'admin');
  assertEquals(err(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] })).code, 'auto_print_off'); // flags default false
  await w.autoOn();
  const c1 = ok<{ result: string; claimed: boolean; order: OnlineOrderWire }>(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] }));
  assertEquals([c1.result, c1.claimed, c1.order.print.claimed_by_device_id], ['applied', true, w.A.device_id]);
  assertEquals(c1.order.print.stations.map((s) => [s.station, s.name, s.lines, s.result]), [['p-counter', 'Counter', [0, 1], null], ['p-oven', 'Pizza oven', [0], null]]);
  assertEquals(parseOnlineOrder(c1.order).kind, 'ok');
  const c2 = ok<{ result: string; claimed: boolean }>(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] }));
  assertEquals([c2.result, c2.claimed], ['noop', true]);
  assertEquals(err(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER] }, w.B)).code, 'not_designated');
  // no takeover: the register moves to B; A's claim stands
  await w.online.setPrintRegister(R1, w.B.device_id, 'admin');
  const c3 = ok<{ result: string; claimed: boolean }>(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER] }, w.B));
  assertEquals([c3.result, c3.claimed], ['noop', false]);
  assertEquals(w.logs(row.id), []); // a claim writes nothing on the tablet's side
});

Deno.test('print: print_status waits for EVERY station — a print_logs row + print_attempts + 1 per station; printed on the last', async () => {
  const w = await world();
  await w.autoOn();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  ok(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] }));
  const r1 = ok<{ order: OnlineOrderWire }>(await w.print({ order_id: row.id, op: 'result', variant: 'auto', result: 'printed', station: COUNTER }));
  assertEquals([w.order(row.id).print_status, w.order(row.id).print_attempts], ['pending', 1]); // untouched while the oven prints
  assertEquals([r1.order.print.result, r1.order.print.print_status], [null, 'pending']);
  const r2 = ok<{ order: OnlineOrderWire }>(await w.print({ order_id: row.id, op: 'result', variant: 'auto', result: 'printed', station: OVEN }));
  assertEquals([w.order(row.id).print_status, w.order(row.id).print_attempts], ['printed', 2]);
  assertEquals(w.logs(row.id).map((l) => [l.attempt_number, l.status, l.error_message, l.order_number, l.restaurant_id]), [[1, 'success', null, row.order_number, R1], [2, 'success', null, row.order_number, R1]]);
  assertEquals([r2.order.print.result, r2.order.print.print_status, r2.order.print.attempts.map((a) => a.station)], ['printed', 'printed', ['p-counter', 'p-oven']]);
  assertEquals(parseOnlineOrder(r2.order).kind, 'ok');
});

Deno.test('print: a station that failed → print_status failed; NOT CONFIRMED → failed "printer did not confirm"; Print settles it', async () => {
  const w = await world();
  await w.autoOn();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  ok(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] }));
  ok(await w.print({ order_id: row.id, op: 'result', variant: 'auto', result: 'printed', station: COUNTER }));
  const r = ok<{ order: OnlineOrderWire }>(await w.print({ order_id: row.id, op: 'result', variant: 'auto', result: 'printed_unconfirmed', station: OVEN }));
  assertEquals(r.order.print.result, 'printed_unconfirmed');
  assertEquals(w.order(row.id).print_status, 'failed');
  assertEquals(w.logs(row.id).at(-1)!.error_message, UNCONFIRMED_ERROR);
  // staff press Print on another register (POSSIBLE DUPLICATE) — THAT station only; it prints → settled
  const m = ok<{ order: OnlineOrderWire; claimed: boolean }>(await w.print({ order_id: row.id, op: 'result', variant: 'manual', result: 'printed', station: OVEN }, w.B));
  assertEquals([m.order.print.result, m.claimed, w.order(row.id).print_status, w.order(row.id).print_attempts], ['printed', false, 'printed', 3]);

  const row2 = ordrRow(w.nowIso());
  w.db.insertRow('orders', row2);
  ok(await w.print({ order_id: row2.id, op: 'claim', stations: [COUNTER] }));
  ok(await w.print({ order_id: row2.id, op: 'result', variant: 'auto', result: 'failed', error: 'Cover open', station: COUNTER }));
  assertEquals([w.order(row2.id).print_status, w.logs(row2.id)[0].error_message], ['failed', 'Cover open']);
});

Deno.test('print: NOT PRINTED → a manual Print on an unclaimed order claims it for that register; no auto ticket follows', async () => {
  const w = await world();
  await w.autoOn();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const m = ok<{ claimed: boolean; order: OnlineOrderWire }>(await w.print({ order_id: row.id, op: 'result', variant: 'manual', result: 'printed', station: COUNTER }, w.B));
  assertEquals([m.claimed, m.order.print.claimed_by_device_id, m.order.print.result], [true, w.B.device_id, 'printed']);
  const c = ok<{ result: string; claimed: boolean }>(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] }));
  assertEquals([c.result, c.claimed], ['noop', false]);
});

Deno.test('print: a legacy order the tablet printed (print_status printed) → served as printed, never claimed', async () => {
  const w = await world();
  await w.autoOn();
  const row = ordrRow(w.nowIso(), { print_status: 'printed', print_attempts: 1 });
  w.db.insertRow('orders', row);
  const [o] = served(ok(await w.poll()));
  assertEquals([o.print.result, o.print.claimed_by_device_id], ['printed', null]);
  const c = ok<{ result: string; claimed: boolean }>(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER] }));
  assertEquals([c.result, c.claimed], ['noop', false]);
});

Deno.test('print: a reprint follows the tablet — print_trigger in_progress + still new → only the log row; taken → columns too', async () => {
  const w = await world({ restaurant: { print_trigger: 'in_progress' } });
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  ok(await w.print({ order_id: row.id, op: 'result', variant: 'reprint', result: 'printed', station: COUNTER }));
  assertEquals([w.logs(row.id).length, w.order(row.id).print_status, w.order(row.id).print_attempts], [1, 'pending', 0]);
  w.order(row.id).status = 'in_progress';
  ok(await w.print({ order_id: row.id, op: 'result', variant: 'reprint', result: 'printed', station: COUNTER }));
  assertEquals([w.logs(row.id).length, w.order(row.id).print_status, w.order(row.id).print_attempts], [2, 'printed', 1]);
});

Deno.test('print: KitchenHub — external_orders\' four columns, no print_logs row', async () => {
  const w = await world({ restaurant: { dsp_orders_enabled: true } });
  await w.autoOn();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  const counter = { station: 'p-counter', name: 'Counter', lines: [0, 1] };
  ok(await w.print({ order_id: kh.id, op: 'claim', stations: [counter] }));
  const r = ok<{ order: OnlineOrderWire }>(await w.print({ order_id: kh.id, op: 'result', variant: 'auto', result: 'printed', station: counter }));
  const x = w.db.rows('external_orders')[0];
  assertEquals([x.print_status, x.print_attempts, x.printed_at !== null, x.last_print_error], ['printed', 1, true, null]);
  assertEquals(w.db.rows('print_logs'), []);
  assertEquals([r.order.channel, r.order.print.result], ['kitchenhub', 'printed']);
});

Deno.test('print: idempotent by action_id — same body → duplicate (nothing written twice); another body → 409 action_id_reused', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const body = { action_id: crypto.randomUUID(), order_id: row.id, op: 'result', variant: 'manual', result: 'printed', station: COUNTER };
  assertEquals(ok<{ result: string }>(await w.print(body)).result, 'applied');
  const dup = ok<{ result: string; claimed: boolean }>(await w.print({ ...body, device_time: '2030-01-01T00:00:00Z' })); // device_time is not part of the key
  assertEquals([dup.result, dup.claimed], ['duplicate', true]);
  assertEquals([w.logs(row.id).length, w.order(row.id).print_attempts], [1, 1]);
  assertEquals(err(await w.print({ ...body, result: 'failed' })), { status: 409, code: 'action_id_reused', message: 'this action_id was used for another request' });
});

Deno.test('print: a resend of a pending action whose SQL already committed — recorded once, the tablet write is not repeated', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const body = { action_id: crypto.randomUUID(), order_id: row.id, op: 'result', variant: 'manual', result: 'printed', station: COUNTER };
  // the first attempt died after pos_record_online_print committed and before the action was completed
  const { device_time: _d, ...req } = { ...body, restaurant_id: R1, stations: null, error: null, device_time: null };
  void _d;
  await w.online.beginAction({ actionId: body.action_id, fn: 'print', restaurantId: R1, deviceId: w.A.device_id, channel: 'ordr', orderId: row.id, action: 'print_result', request: req, actor: null, approver: null, deviceTime: null });
  await w.online.recordPrint({ restaurantId: R1, channel: 'ordr', orderId: row.id, deviceId: w.A.device_id, actionId: body.action_id, variant: 'manual', result: 'printed', station: COUNTER, error: null, deviceTime: null });
  const r = ok<{ result: string; order: OnlineOrderWire }>(await w.print(body));
  assertEquals([r.result, r.order.print.attempts.length, w.logs(row.id).length], ['applied', 1, 0]);
});

Deno.test('print: unknown / unwritten order, another restaurant\'s order, bad payloads', async () => {
  const w = await world();
  const at = w.nowIso();
  const unwritten = ordrRow(at, { items_written_at: null });
  const theirs = ordrRow(at, { restaurant_id: R2 });
  const row = ordrRow(at);
  for (const r of [unwritten, theirs, row]) w.db.insertRow('orders', r);
  const res = (o: Record<string, unknown>) => ({ op: 'result', variant: 'manual', result: 'printed', station: COUNTER, ...o });
  assertEquals(err(await w.print(res({ order_id: uid() }))).code, 'unknown_order');
  assertEquals(err(await w.print(res({ order_id: unwritten.id }))).code, 'unknown_order');
  assertEquals(err(await w.print(res({ order_id: theirs.id }))).code, 'restaurant_mismatch');
  assertEquals(err(await w.print(res({ order_id: row.id, restaurant_id: R2 }))).code, 'restaurant_mismatch');
  for (const bad of [
    res({ order_id: row.id, station: null }), // a result names its station
    res({ order_id: row.id, station: { station: 'p', name: 'P', lines: [2] } }), // past the order's 2 items
    res({ order_id: row.id, variant: 'bogus' }),
    res({ order_id: row.id, result: 'claimed' }),
    { order_id: row.id, op: 'claim', stations: [] },
    { order_id: row.id, op: 'claim', stations: [COUNTER, COUNTER] },
    { order_id: row.id, op: 'nope' },
    res({ order_id: row.id, action_id: 'not-a-uuid' }),
  ]) assertEquals(err(await w.print(bad)).code, 'invalid_payload', JSON.stringify(bad));
  assertEquals(w.logs(row.id), []);
});

// ---- logging (status / code / field only) ------------------------------------------------------

Deno.test('print RESULT calls log no request / response body (the temporary RESULT_DEBUG_LOG is gone) — never a token', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const before = w.h.logs.length;
  const body = { action_id: crypto.randomUUID(), order_id: row.id, op: 'result', variant: 'manual', result: 'printed', station: COUNTER };
  ok(await w.print(body));
  await w.print({ ...body, action_id: 'pr-not-a-uuid' }); // a 400
  const logs = w.h.logs.slice(before);
  assert(!logs.some((l) => l.includes('print_result_debug')), 'no debug line');
  assert(!logs.some((l) => l.includes(COUNTER.station) || l.includes(body.action_id)), 'no body / ids from the request');
  assert(!logs.some((l) => l.includes('odt_')), 'no device token');
});

Deno.test('logErrorResponse: every 4xx / 5xx → status + code + field (no body); 200 → nothing; not JSON → status only', async () => {
  const { logErrorResponse } = await import('../handlers.ts');
  const logs: Record<string, unknown>[] = [];
  const log = (event: string, data: Record<string, unknown> = {}) => void logs.push({ event, ...data });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const r400 = json(400, { error: { code: 'invalid_payload', message: 'action_id must be a UUID', field: 'action_id' } });
  assertEquals(await logErrorResponse(log, r400), r400);
  assertEquals(await r400.json(), { error: { code: 'invalid_payload', message: 'action_id must be a UUID', field: 'action_id' } }, 'the body still reads');
  await logErrorResponse(log, json(500, { error: { code: 'internal_error', message: 'x' } }));
  await logErrorResponse(log, json(200, { ok: true }));
  await logErrorResponse(log, new Response('oops', { status: 502 }));
  assertEquals(logs, [
    { event: 'error_response', status: 400, code: 'invalid_payload', field: 'action_id' },
    { event: 'error_response', status: 500, code: 'internal_error', field: null },
    { event: 'error_response', status: 502, code: null, field: null },
  ]);
});

// ---- the live 400 (Test Pizza, 2026-11-24): the POS's real RESULT request ----------------------------------

/**
 * ordr-pos @ 4f729e4: src/db/repo/onlinePrint.ts :186-199 queues a print_result with action_id
 * `pr-${job.id}-${result}` (job.id = a uuid, print.ts :170 / :351) and payload {variant, result, error, station,
 * device_time}; src/sync/onlineFeed.ts :136-151 sends {action_id, restaurant_id, order_id, op: 'result',
 * stations: null, station, variant, result, error, device_time}.
 */
function posResultRequest(orderId: string, jobId: string, result: 'printed' | 'failed', station: typeof COUNTER, at: string) {
  return {
    action_id: `pr-${jobId}-${result}`, restaurant_id: R1, order_id: orderId, op: 'result', stations: null, station,
    variant: 'auto', result, error: result === 'failed' ? 'did not print' : null, device_time: at,
  };
}

Deno.test('LIVE BUG repro: the POS\'s real result request → 400 invalid_payload field action_id (pr-<job>-<result> is not a UUID); the same request with a UUID action_id → 200 recorded', async () => {
  const w = await world();
  await w.autoOn();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  assertEquals(ok<{ result: string }>(await w.print({ order_id: row.id, op: 'claim', stations: [COUNTER, OVEN] })).result, 'applied');
  for (const [res, st] of [['printed', COUNTER], ['failed', OVEN]] as const) {
    const real = posResultRequest(row.id, crypto.randomUUID(), res, st, w.nowIso());
    const r = await w.print(real);
    assertEquals([r.status, (r.body as { error: { code: string; field: string } }).error.code, (r.body as { error: { field: string } }).error.field], [400, 'invalid_payload', 'action_id']);
    // every other field of the real request passes: only the action_id differs
    assertEquals(ok<{ result: string }>(await w.print({ ...real, action_id: crypto.randomUUID() })).result, 'applied', res);
  }
  assertEquals(w.logs(row.id).length, 2, 'the UUID versions were recorded (tablet print_logs)');
});

// ---- CP23: pos_delivery_dispatch_enabled in the settings block (additive) ---------------------------------------

Deno.test('settings: pos_delivery_dispatch_enabled travels in the feed settings (default false; on → true, a new hash); the POS parser still reads it', async () => {
  const w = await world();
  const s1 = ok<{ settings: OnlineSettingsWire }>(await w.poll()).settings;
  assertEquals([s1.pos_delivery_dispatch_enabled, settingsProblem(s1)], [false, null]);
  w.online.setFlags(R1, { pos_delivery_dispatch_enabled: true });
  const s2 = ok<{ settings: OnlineSettingsWire }>(await w.poll({ if_none_match_settings: s1.hash })).settings;
  assertEquals([s2.pos_delivery_dispatch_enabled, settingsProblem(s2)], [true, null]);
  assertNotEquals(s2.hash, s1.hash);
});
