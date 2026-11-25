/**
 * pos-v1-online-order-action UBER (CP20) end to end over the device middleware, MemoryOnlineStore (= 111/113/114 SQL),
 * the in-memory PostgREST and the fakes for the shared modules (createUberDelivery / cancelUberDelivery /
 * refundUberAppFee — moneyFakes.ts). Ported from the reference (ordr-pos @ 4f729e4 test/online/delivery.test.ts — the
 * server-observable parts): dispatch :51-134 (ASAP → in progress, one booking; refused: pickup time outside 5–120,
 * in-house, a pickup order, already dispatched → 409; scheduled → booked at the customer's time → scheduled; booked at
 * checkout → schedule, never a second booking; re-quote → nothing booked, Dispatch anyway → booked once; refused (no
 * driver / bad address) → nothing changes; a lost answer → one booking), deliver yourself :183-228 (from in progress /
 * new → self-delivering, the provider leg cancelled; NOT once the driver has the food).
 * + Matt's CP20 decisions: a stale pending dispatch is NEVER re-run (booked → applied; else stored "outcome unknown");
 * Uber booked but the orders row not updated → stored 502 + one loud reconcile line; rate_limited → 503 + Retry-After,
 * not stored; prep 5–120; the stricter self_deliver status check.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { err, ok, R1 } from '../../pos-device/tests/harness.ts';
import { PENDING_STALE_MS } from '../handlers.ts';
import type { OnlineOrderWire } from '../wire.ts';
import { parseOnlineOrder } from './referenceParse.ts';
import { khRow, ordrRow, world } from './world.ts';

type W = Awaited<ReturnType<typeof world>>;
type Body = { result: string; order: OnlineOrderWire; orders: OnlineOrderWire[] };
const MIN = 60_000;

const restaurantJoin = (o: Record<string, unknown> = {}) => ({
  id: R1, name: 'Test Pizza', address: '1 Main St', phone: '5165550100', latitude: 40.7, longitude: -73.6, uber_customer_id: 'cust_test',
  uber_environment: 'sandbox', uber_billing_mode: 'self', uber_passthrough_mode: null, uber_passthrough_value: null, uber_scheduled_lead_minutes: null,
  stripe_account_id: 'acct_test_pizza', tablet_email: 'tablet@example.test', ...o,
});
/** An Uber Direct delivery order, NOT booked (the PostgREST fake returns the FK join as an embedded `restaurants`). */
function uberOrder(w: W, o: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  const row = ordrRow(w.nowIso(), {
    order_type: 'delivery', delivery_address: '9 Elm St', delivery_fulfillment_method: 'uber_direct', uber_quote_id: 'q-orig', dropoff_lat: 40.71, dropoff_lng: -73.61,
    stripe_charge_id: 'ch_test', restaurants: restaurantJoin(rest), ...o,
  });
  w.db.insertRow('orders', row);
  return row;
}
const readable = (o: unknown) => {
  assertEquals(parseOnlineOrder(o).kind, 'ok', 'the POS reads the order');
  return o as OnlineOrderWire;
};
const okBody = (r: Parameters<typeof ok>[0]) => {
  const b = ok<Body>(r);
  readable(b.order);
  return b;
};
const errBody = (r: { body: unknown }) => (r.body as { error: Record<string, unknown> }).error;
function changed(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}
const dispatch = (w: W, id: string, prep: number | null, o: Record<string, unknown> = {}) =>
  w.action({ order_id: id, action: 'dispatch_delivery', expected_status: 'new', prep_minutes: prep, ...o });
const selfDeliver = (w: W, id: string, expected: string, o: Record<string, unknown> = {}) =>
  w.action({ order_id: id, action: 'self_deliver', expected_status: expected, ...o });

// ---- dispatch (delivery.test.ts :51-134) -------------------------------------------------------------------------

Deno.test('ASAP: ready in 20 → in progress, Uber looking for a driver, pickup at now + 20, tracking, accepted_at — createUberDelivery\'s write only; one booking', async () => {
  const w = await world();
  const row = uberOrder(w);
  const before = structuredClone(w.order(row.id));
  const t0 = Date.now();
  const b = okBody(await dispatch(w, row.id, 20));
  assertEquals([b.result, b.order.status, b.order.delivery!.status, b.order.delivery!.provider_status], ['applied', 'in_progress', 'pending', 'pending']);
  assertEquals(w.money.dispatchCalls.map((c) => c.opts), [{ pickupReadyMinutes: 20, pickupDeadlineMinutes: undefined, acceptedQuoteId: undefined, postWriteStatus: 'in_progress' }]);
  const pickup = Date.parse(w.order(row.id).uber_pickup_ready_dt) - t0;
  assert(pickup >= 20 * MIN && pickup < 20 * MIN + 5_000, `pickup at now + 20 (${pickup})`);
  assertEquals(changed(before, w.order(row.id)), ['accepted_at', 'status', 'uber_delivery_id', 'uber_dispatched_at', 'uber_pickup_ready_dt', 'uber_status', 'uber_status_updated_at', 'uber_tracking_url']);
  assert(b.order.delivery!.tracking_url && b.order.delivery!.dispatched_at && b.order.accepted_at);
});

Deno.test('refused: pickup time outside 5–120, an in-house delivery, a pickup order, an already dispatched one (stale "new" → 409 with the order)', async () => {
  const w = await world();
  const row = uberOrder(w);
  for (const m of [3, 121, 20.5, null]) assertEquals(err(await dispatch(w, row.id, m)).code, 'invalid_payload', String(m));
  const own = uberOrder(w, { delivery_fulfillment_method: 'in_house' });
  const pickup = uberOrder(w, { order_type: 'pickup', delivery_address: null });
  assertEquals(err(await dispatch(w, own.id, 20)).code, 'action_not_allowed');
  assertEquals(err(await dispatch(w, pickup.id, 20)).code, 'action_not_allowed');
  okBody(await dispatch(w, row.id, 20));
  const again = await dispatch(w, row.id, 30);
  assertEquals([err(again).status, err(again).code, readable(errBody(again).order).status], [409, 'status_conflict', 'in_progress']);
  assertEquals(w.money.dispatchCalls.length, 1, 'one booking');
});

Deno.test('scheduled: books at the customer\'s time (the tablet\'s pickup_ready_dt = scheduled_for) → scheduled; the restaurant\'s lead (096) applied by the copied glue; a past slot → nothing booked', async () => {
  const w = await world();
  const at = new Date(Date.now() + 90 * MIN).toISOString();
  const row = uberOrder(w, { scheduled_for: at });
  const b = okBody(await dispatch(w, row.id, null));
  assertEquals([b.result, b.order.status, b.order.delivery!.pickup_ready_at], ['applied', 'scheduled', at]);
  assertEquals(w.money.dispatchCalls[0].opts, { pickupReadyDt: at, pickupDeadlineMinutes: undefined, acceptedQuoteId: undefined, postWriteStatus: 'scheduled' });
  // uber_scheduled_lead_minutes 30 → pickup 30 min before the slot (uber-create-delivery :266-288)
  const led = uberOrder(w, { scheduled_for: at }, { uber_scheduled_lead_minutes: 30 });
  okBody(await dispatch(w, led.id, null));
  assertEquals(w.money.dispatchCalls[1].opts.pickupReadyDt, new Date(Date.parse(at) - 30 * MIN).toISOString());
  const past = uberOrder(w, { scheduled_for: new Date(Date.now() - MIN).toISOString() });
  assertEquals(err(await dispatch(w, past.id, null)), { status: 400, code: 'action_not_allowed', message: 'the scheduled time has passed' });
  assertEquals(w.money.dispatchCalls.length, 2);
});

Deno.test('booked at checkout (uber_delivery_id already set): dispatch → action_not_allowed; schedule (CP18) files it — never a second booking', async () => {
  const w = await world();
  const row = uberOrder(w, { scheduled_for: new Date(Date.now() + 3 * 3600_000).toISOString(), uber_delivery_id: 'del_checkout', uber_status: 'pending', uber_dispatched_at: w.nowIso() });
  assertEquals(err(await dispatch(w, row.id, null)), { status: 400, code: 'action_not_allowed', message: 'already dispatched' });
  assertEquals(okBody(await w.action({ order_id: row.id, action: 'schedule', expected_status: 'new' })).order.status, 'scheduled');
  assertEquals(w.money.dispatchCalls, []);
});

Deno.test('the provider re-quotes: 409 quote_price_changed + error.quote, nothing booked; the same request again = the same stored answer; Dispatch anyway (accepted_quote_id) → booked once', async () => {
  const w = await world();
  const row = uberOrder(w);
  w.money.dispatchOutcome.set(row.id, { requote: { original_fee_cents: 799, new_fee_cents: 999, new_quote_id: 'q-new' } });
  const id = crypto.randomUUID();
  const r = await dispatch(w, row.id, 20, { action_id: id });
  assertEquals([r.status, errBody(r).code, errBody(r).quote], [409, 'quote_price_changed', { original_fee_cents: 799, new_fee_cents: 999, delta_cents: 200, new_quote_id: 'q-new' }]);
  assertEquals(w.order(row.id).status, 'new');
  const replay = await dispatch(w, row.id, 20, { action_id: id });
  assertEquals([errBody(replay).code, errBody(replay).quote], ['quote_price_changed', { original_fee_cents: 799, new_fee_cents: 999, delta_cents: 200, new_quote_id: 'q-new' }]);
  assertEquals(w.money.dispatchCalls.length, 1, 'the replay made no call');
  const b = okBody(await dispatch(w, row.id, 20, { accepted_quote_id: 'q-new' }));
  assertEquals([b.result, w.order(row.id).uber_quote_id], ['applied', 'q-new']);
  assertEquals(w.money.dispatchCalls[1].opts.acceptedQuoteId, 'q-new');
});

Deno.test('the provider refuses: no driver → 502 delivery_failed no_courier_available; bad address → bad_address; nothing changes; a lost answer → duplicate, one booking', async () => {
  const w = await world();
  const row = uberOrder(w);
  w.money.dispatchOutcome.set(row.id, 'no_uber_available');
  const a = await dispatch(w, row.id, 20);
  assertEquals([a.status, errBody(a).code, errBody(a).reason], [502, 'delivery_failed', 'no_courier_available']);
  w.money.dispatchOutcome.set(row.id, 'bad_address');
  assertEquals(errBody(await dispatch(w, row.id, 20)).reason, 'bad_address');
  w.money.dispatchOutcome.set(row.id, 'uber_unavailable');
  assertEquals(errBody(await dispatch(w, row.id, 20)).reason, 'provider_error');
  assertEquals(w.order(row.id).status, 'new');
  w.money.dispatchOutcome.set(row.id, 'ok');
  const id = crypto.randomUUID();
  okBody(await dispatch(w, row.id, 20, { action_id: id }));
  assertEquals(okBody(await dispatch(w, row.id, 20, { action_id: id, device_time: '2026-11-19T18:00:00.000Z' })).result, 'duplicate');
  assertEquals(w.money.dispatchCalls.length, 4, 'booked once (3 refusals + 1 booking)');
});

// ---- Matt's CP20 decisions ----------------------------------------------------------------------------------------

Deno.test('decision 3: rate_limited → 503 + Retry-After, NOT stored (the pending row is released); the resend is a fresh attempt', async () => {
  const w = await world();
  const row = uberOrder(w);
  w.money.dispatchOutcome.set(row.id, 'rate_limited');
  const id = crypto.randomUUID();
  const r = await dispatch(w, row.id, 20, { action_id: id });
  assertEquals([r.status, err(r).code, r.headers?.['Retry-After']], [503, 'rate_limited', '7']);
  assertEquals(w.online.actions.has(id), false, 'released — nothing stored');
  w.money.dispatchOutcome.set(row.id, 'ok');
  assertEquals(okBody(await dispatch(w, row.id, 20, { action_id: id })).result, 'applied');
});

Deno.test('decision 2: Uber booked but the orders row was not updated → stored 502 provider_error + ONE loud reconcile line (order_id + delivery_id); the resend never retries', async () => {
  const w = await world();
  const row = uberOrder(w);
  w.money.dispatchOutcome.set(row.id, 'db_error_after_booking');
  const id = crypto.randomUUID();
  const before = w.h.logs.length;
  const r = await dispatch(w, row.id, 20, { action_id: id });
  assertEquals([r.status, err(r).code, errBody(r).reason], [502, 'delivery_failed', 'provider_error']);
  const loud = w.h.logs.slice(before).map((l) => JSON.parse(l)).filter((l) => l.event === 'ONLINE_DISPATCH_UNPERSISTED_RECONCILE');
  assertEquals(loud.map((l) => [l.order_id, l.uber_delivery_id]), [[row.id, 'del_fake_1']]);
  w.money.dispatchOutcome.set(row.id, 'ok');
  assertEquals(errBody(await dispatch(w, row.id, 20, { action_id: id })).reason, 'provider_error');
  assertEquals(w.money.dispatchCalls.length, 1, 'never retried');
});

Deno.test('decision 1: a pending dispatch → 503 while fresh; STALE → never re-run: booked (uber_delivery_id saved) → applied; not booked → stored 502 "outcome unknown"', async () => {
  const w = await world();
  const req = (id: string, orderId: string) => ({
    action_id: id, restaurant_id: R1, order_id: orderId, action: 'dispatch_delivery', expected_status: 'new', quoted_ready_minutes: null, prep_minutes: 20,
    amount_cents: null, adjustment_type: null, accepted_quote_id: null, reason: null, approver_staff_id: null, actor_staff_id: 'register',
  });
  const begin = (id: string, orderId: string) => w.online.beginAction({ actionId: id, fn: 'order_action', restaurantId: R1, deviceId: w.A.device_id, channel: 'ordr', orderId, action: 'dispatch_delivery', request: req(id, orderId), actor: 'register', approver: null, deviceTime: null });
  const booked = uberOrder(w);
  const lost = uberOrder(w);
  const [a1, a2] = [crypto.randomUUID(), crypto.randomUUID()];
  await begin(a1, booked.id);
  await begin(a2, lost.id);
  Object.assign(w.order(booked.id), { uber_delivery_id: 'del_first', uber_status: 'pending', status: 'in_progress', uber_dispatched_at: w.nowIso() }); // the first attempt got this far
  const busy = await w.action({ ...req(a1, booked.id), device_time: w.nowIso() });
  assertEquals([busy.status, err(busy).code], [503, 'action_pending']);
  w.h.clock.advance(PENDING_STALE_MS);
  assertEquals(okBody(await w.action({ ...req(a1, booked.id), device_time: w.nowIso() })).result, 'applied');
  const r = await w.action({ ...req(a2, lost.id), device_time: w.nowIso() });
  assertEquals([r.status, errBody(r).reason, err(r).message], [502, 'provider_error', 'outcome unknown — check the Uber dashboard before dispatching again']);
  assertEquals(w.money.dispatchCalls, [], 'never re-run');
  assertEquals([w.online.actions.get(a1)!.outcome, w.online.actions.get(a2)!.outcome], ['applied', 'error']);
});

// ---- deliver yourself (delivery.test.ts :183-208) ----------------------------------------------------------------

Deno.test('deliver yourself: from in progress → self_delivering + restaurant_self_deliver, the Uber leg cancelled, the app fee walked back — those columns only; from new too (no Uber call)', async () => {
  const w = await world();
  const row = uberOrder(w);
  okBody(await dispatch(w, row.id, 10));
  const before = structuredClone(w.order(row.id));
  const b = okBody(await selfDeliver(w, row.id, 'in_progress'));
  // delivery.cancelled_by: the contract's "provider / restaurant / customer" (onlineContract.ts :182) — the reference
  // fake says 'restaurant_self_deliver'; the POS only tests === 'provider' (onlineModel.ts :57); the order's own
  // cancelled_by is the web's 'restaurant_self_deliver'
  assertEquals([b.result, b.order.status, b.order.delivery!.status, b.order.delivery!.cancelled_by, b.order.cancelled_by], ['applied', 'self_delivering', 'cancelled', 'restaurant', 'restaurant_self_deliver']);
  // uber_status_updated_at may land on the same millisecond as the dispatch's stamp — allowed, never required
  const diff = changed(before, w.order(row.id));
  assertEquals(diff.filter((k) => k !== 'uber_status_updated_at'), ['cancelled_by', 'status', 'uber_status']);
  assertEquals(w.money.calls.slice(-2), [`uber:${row.id}`, `appfee:${row.id}`], 'cancel first, then the app fee (uber-self-deliver order)');
  const fresh = uberOrder(w);
  assertEquals(okBody(await selfDeliver(w, fresh.id, 'new')).order.status, 'self_delivering');
  assertEquals(w.order(fresh.id).uber_status, null, 'never dispatched: nothing to cancel');
});

Deno.test('deliver yourself refused: the driver has the food → 502 cannot_cancel, nothing changes; complete / cancelled / self_delivering / in-house / KitchenHub → action_not_allowed; 409 on a stale status', async () => {
  const w = await world({ restaurant: { dsp_orders_enabled: true } });
  const late = uberOrder(w, { status: 'in_progress', uber_delivery_id: 'del_late', uber_status: 'pickup_complete', uber_dispatched_at: w.nowIso() });
  w.money.uberOutcome.set(late.id, 'uber_cancel_failed');
  const r = await selfDeliver(w, late.id, 'in_progress');
  assertEquals([r.status, errBody(r).code, errBody(r).reason], [502, 'delivery_failed', 'cannot_cancel']);
  assertEquals([w.order(late.id).status, w.order(late.id).uber_status], ['in_progress', 'pickup_complete']);
  for (const st of ['complete', 'cancelled', 'self_delivering']) {
    const x = uberOrder(w, { status: st });
    assertEquals(err(await selfDeliver(w, x.id, st)).code, 'action_not_allowed', st);
  }
  const own = uberOrder(w, { delivery_fulfillment_method: 'in_house' });
  assertEquals(err(await selfDeliver(w, own.id, 'new')).code, 'action_not_allowed');
  const moved = uberOrder(w);
  assertEquals(err(await selfDeliver(w, moved.id, 'in_progress')).code, 'status_conflict');
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  assertEquals(err(await selfDeliver(w, kh.id, 'new')).code, 'action_not_allowed');
});

Deno.test('deliver yourself: rate_limited → 503 not stored; a STALE pending self_deliver IS re-run (every step idempotent); not configured → 501', async () => {
  const w = await world();
  const row = uberOrder(w, { status: 'in_progress', uber_delivery_id: 'del_x', uber_status: 'pending', uber_dispatched_at: w.nowIso() });
  w.money.uberOutcome.set(row.id, 'rate_limited');
  const id = crypto.randomUUID();
  const r = await selfDeliver(w, row.id, 'in_progress', { action_id: id });
  assertEquals([r.status, err(r).code, r.headers?.['Retry-After'], w.online.actions.has(id)], [503, 'rate_limited', '7', false]);
  w.money.uberOutcome.set(row.id, 'ok');
  const req = { action_id: id, restaurant_id: R1, order_id: row.id, action: 'self_deliver', expected_status: 'in_progress', quoted_ready_minutes: null, prep_minutes: null, amount_cents: null, adjustment_type: null, accepted_quote_id: null, reason: null, approver_staff_id: null, actor_staff_id: 'register' };
  await w.online.beginAction({ actionId: id, fn: 'order_action', restaurantId: R1, deviceId: w.A.device_id, channel: 'ordr', orderId: row.id, action: 'self_deliver', request: req, actor: 'register', approver: null, deviceTime: null });
  assertEquals((await w.action({ ...req, device_time: w.nowIso() })).status, 503, 'fresh pending: in flight');
  w.h.clock.advance(PENDING_STALE_MS);
  assertEquals(okBody(await w.action({ ...req, device_time: w.nowIso() })).order.status, 'self_delivering');
  w.deps.refund = undefined;
  assertEquals(err(await selfDeliver(w, uberOrder(w).id, 'new')).status, 501);
  assertEquals(err(await dispatch(w, uberOrder(w).id, 20)).status, 501);
});
