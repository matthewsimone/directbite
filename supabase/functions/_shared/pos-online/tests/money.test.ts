/**
 * pos-v1-online-order-action MONEY (CP19) end to end over the device middleware, MemoryOnlineStore (= 111 + 113 SQL),
 * the in-memory PostgREST and the money fakes (Stripe refunds / uberCancel / refundUberAppFee). Ported from the
 * reference (ordr-pos @ 4f729e4 test/online/money.test.ts — the server-observable parts):
 *   Cancel & Refund = admin-refund {type: full} unchanged :80-184 (refund columns + cancelled_by; only from the live
 *   statuses — complete → not allowed, delivered → already_delivered; compare-and-set → 409 with the order; Uber
 *   cancelled FIRST, refused → nothing refunded; Stripe refuses → refund_status failed + refund_reason, the resend is
 *   the SAME answer, a fresh tap tries again, one refund; a lost answer / a restart → duplicate, one refund),
 *   Adjust = the tablet's ADJUST :186-249 (complete orders only, a PENDING request, nothing charged; refused: not
 *   complete, $0, no note, card numbers, KitchenHub; a lost answer → one row).
 * Matt's decisions (CP19): no Stripe call for Adjust; the glue is admin-refund's, hash-pinned (adminRefundPin.json).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { err, ok, R1 } from '../../pos-device/tests/harness.ts';
import { PENDING_STALE_MS } from '../handlers.ts';
import type { OnlineOrderWire } from '../wire.ts';
import { parseOnlineOrder } from './referenceParse.ts';
import { khRow, ordrRow, world } from './world.ts';

type Body = { result: string; order: OnlineOrderWire; orders: OnlineOrderWire[] };
type W = Awaited<ReturnType<typeof world>>;

const STRIPE_ACCT = 'acct_test_pizza';
async function moneyWorld() {
  return await world({ restaurant: { stripe_account_id: STRIPE_ACCT, uber_customer_id: null, uber_environment: null, uber_billing_mode: 'self' } });
}
function paid(w: W, o: Record<string, unknown> = {}) {
  const row = ordrRow(w.nowIso(), { status: 'in_progress', stripe_payment_intent_id: `pi_test_${crypto.randomUUID().slice(0, 8)}`, ...o });
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
  assertEquals(b.orders, []);
  return b;
};
const errOrder = (r: { body: unknown }) => readable((r.body as { error: { order: unknown } }).error.order);
function changed(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}
const cancel = (w: W, id: string, expected: string, o: Record<string, unknown> = {}) =>
  w.action({ order_id: id, action: 'cancel_refund', expected_status: expected, ...o });
const adjust = (w: W, id: string, type: string, cents: unknown, note: unknown = 'Extra cheese', o: Record<string, unknown> = {}) =>
  w.action({ order_id: id, action: 'adjustment_request', expected_status: 'complete', adjustment_type: type, amount_cents: cents, reason: note, ...o });

// ---- Cancel & Refund (money.test.ts :80-184) --------------------------------------------------------------------

Deno.test('Cancel & Refund = admin-refund {type: full}: refund_status completed, refund_amount = the total (dollars), refunded_at, cancelled + restaurant_refund — those columns only', async () => {
  const w = await moneyWorld();
  const row = paid(w);
  const before = structuredClone(w.order(row.id));
  const maria = crypto.randomUUID();
  const id = crypto.randomUUID();
  const b = okBody(await cancel(w, row.id, 'in_progress', { action_id: id, approver_staff_id: maria }));
  assertEquals([b.result, b.order.status, b.order.cancelled_by, b.order.refund.status, b.order.refund.amount_cents], ['applied', 'cancelled', 'restaurant_refund', 'completed', 3492]);
  const after = w.order(row.id);
  assertEquals(changed(before, after), ['cancelled_by', 'refund_amount', 'refund_status', 'refunded_at', 'status']);
  assertEquals([after.refund_amount, after.refund_status, after.status, after.cancelled_by], [34.92, 'completed', 'cancelled', 'restaurant_refund']);
  assertEquals(w.money.stripeCalls, [{ params: { payment_intent: row.stripe_payment_intent_id }, opts: { stripeAccount: STRIPE_ACCT, idempotencyKey: `pos-cancel-refund-${id}` } }]);
  assertEquals(w.money.appFee.map((a) => a.order_id), [row.id], 'the fronted app fee is walked back (a no-op inside for self mode)');
  assertEquals(w.money.calls.filter((c) => c.startsWith('uber:')), [], 'in-house: no Uber call');
  const a = w.online.actions.get(id)!;
  assertEquals([a.fn, a.action, a.outcome, a.approver], ['order_action', 'cancel_refund', 'applied', maria]);
});

Deno.test('only where the tablet offers it: new / scheduled / in_progress / self_delivering; complete → action_not_allowed; Uber delivered → already_delivered (no refund, no Stripe call)', async () => {
  const w = await moneyWorld();
  for (const st of ['new', 'scheduled', 'in_progress', 'self_delivering']) {
    const row = paid(w, { status: st });
    assertEquals(okBody(await cancel(w, row.id, st)).result, 'applied', st);
  }
  const done = paid(w, { status: 'complete' });
  assertEquals(err(await cancel(w, done.id, 'complete')).code, 'action_not_allowed');
  const ub = paid(w, { order_type: 'delivery', delivery_address: '1 Test St', delivery_fulfillment_method: 'uber_direct', uber_delivery_id: 'del_1', uber_status: 'delivered', uber_dispatched_at: w.nowIso() });
  assertEquals(err(await cancel(w, ub.id, 'in_progress')), { status: 400, code: 'already_delivered', message: 'the order was already delivered — no refund' });
  assertEquals([w.order(done.id).refund_status, w.order(ub.id).refund_status], [null, null]);
  assertEquals(w.money.stripeCalls.length, 4, 'only the four live ones');
});

Deno.test('compare-and-set: the tablet moved it first → 409 with the order; the tablet already cancelled + refunded → 409 with the cancelled order (= done on the POS)', async () => {
  const w = await moneyWorld();
  const moved = paid(w, { status: 'new' });
  w.order(moved.id).status = 'in_progress';
  const r = await cancel(w, moved.id, 'new');
  assertEquals([err(r).status, err(r).code, errOrder(r).status, errOrder(r).refund.status], [409, 'status_conflict', 'in_progress', 'none']);
  const gone = paid(w, { status: 'new' });
  Object.assign(w.order(gone.id), { status: 'cancelled', refund_status: 'completed', refund_amount: 34.92, refunded_at: w.nowIso() });
  assertEquals(errOrder(await cancel(w, gone.id, 'new')).status, 'cancelled');
  assertEquals(w.money.stripeCalls, [], 'nothing refunded');
});

Deno.test('Uber: the delivery is cancelled FIRST (uber_status canceled), then Stripe; Uber refuses (driver has the food) → 502 delivery_failed cannot_cancel, NOTHING refunded; another Uber error → provider_error', async () => {
  const w = await moneyWorld();
  const uber = { order_type: 'delivery', delivery_address: '1 Test St', delivery_fulfillment_method: 'uber_direct', uber_delivery_id: 'del_ok', uber_status: 'pending', uber_dispatched_at: w.nowIso() };
  const ok1 = paid(w, uber);
  assertEquals(okBody(await cancel(w, ok1.id, 'in_progress')).result, 'applied');
  assertEquals(w.money.calls, [`uber:${ok1.id}`, `stripe:${ok1.stripe_payment_intent_id}`, `appfee:${ok1.id}`]);
  assertEquals([w.order(ok1.id).uber_status, w.order(ok1.id).status], ['canceled', 'cancelled']);
  const food = paid(w, { ...uber, uber_delivery_id: 'del_food', uber_status: 'pickup_complete' });
  w.money.uberOutcome.set(food.id, 'uber_cancel_failed');
  assertEquals(err(await cancel(w, food.id, 'in_progress')), { status: 502, code: 'delivery_failed', message: 'Uber could not cancel the delivery — NOT refunded' });
  const reason = (await cancel(w, food.id, 'in_progress', { action_id: crypto.randomUUID() })).body as { error: { reason: string } };
  assertEquals(reason.error.reason, 'cannot_cancel');
  assertEquals([w.order(food.id).status, w.order(food.id).refund_status], ['in_progress', null]);
  const other = paid(w, { ...uber, uber_delivery_id: 'del_other' });
  w.money.uberOutcome.set(other.id, 'uber_unavailable');
  assertEquals(((await cancel(w, other.id, 'in_progress')).body as { error: { reason: string } }).error.reason, 'provider_error');
  assertEquals(w.money.stripeCalls.length, 1, 'only the order Uber released was refunded');
});

Deno.test('Stripe refuses: refund_status failed + refund_reason, the status stands, 502 refund_failed with the order; the resend is the SAME answer (stored); a fresh tap tries again → one refund', async () => {
  const w = await moneyWorld();
  const row = paid(w);
  w.money.stripeOutcome.set(row.id, 'fail');
  const id = crypto.randomUUID();
  const r1 = await cancel(w, row.id, 'in_progress', { action_id: id });
  assertEquals([err(r1).status, err(r1).code, errOrder(r1).refund.status, errOrder(r1).status], [502, 'refund_failed', 'failed', 'in_progress']);
  assertEquals([w.order(row.id).refund_status, w.order(row.id).refund_reason], ['failed', 'Your card was declined for this refund.']);
  w.money.stripeOutcome.set(row.id, 'ok'); // even if Stripe would work now, the resend is the same attempt
  const r2 = await cancel(w, row.id, 'in_progress', { action_id: id });
  assertEquals([err(r2).code, err(r2).message], ['refund_failed', 'Your card was declined for this refund.']);
  assertEquals(w.money.stripeCalls.length, 1, 'no second Stripe call for the resend');
  const fresh = okBody(await cancel(w, row.id, 'in_progress'));
  assertEquals([fresh.result, fresh.order.refund.status, fresh.order.status], ['applied', 'completed', 'cancelled']);
  assertEquals(w.money.refunds.size, 1, 'refunded once');
});

Deno.test('a lost answer: the same request again → duplicate (no second refund); another body under the id → 409', async () => {
  const w = await moneyWorld();
  const row = paid(w);
  const id = crypto.randomUUID();
  okBody(await cancel(w, row.id, 'in_progress', { action_id: id, device_time: '2026-11-19T17:00:00.000Z' }));
  const again = okBody(await cancel(w, row.id, 'in_progress', { action_id: id, device_time: '2026-11-19T17:01:00.000Z' }));
  assertEquals([again.result, again.order.status], ['duplicate', 'cancelled']);
  assertEquals(err(await cancel(w, row.id, 'new', { action_id: id })).code, 'action_id_reused');
  assertEquals(w.money.stripeCalls.length, 1);
});

Deno.test('in flight: a resend while the first attempt is pending → 503 action_pending (Retry-After); a CRASHED attempt (pending past the stale time) is re-run — the Stripe idempotency key returns the SAME refund', async () => {
  const w = await moneyWorld();
  const row = paid(w);
  const id = crypto.randomUUID();
  const body = { action_id: id, restaurant_id: R1, order_id: row.id, action: 'cancel_refund', expected_status: 'in_progress', quoted_ready_minutes: null, prep_minutes: null, amount_cents: null, adjustment_type: null, accepted_quote_id: null, reason: null, approver_staff_id: null, actor_staff_id: 'register' };
  // the first attempt: begun, Stripe refunded (its idempotency key), then the function died before the orders update
  await w.online.beginAction({ actionId: id, fn: 'order_action', restaurantId: R1, deviceId: w.A.device_id, channel: 'ordr', orderId: row.id, action: 'cancel_refund', request: body, actor: 'register', approver: null, deviceTime: null });
  const first = await w.money.stripe.refunds.create({ payment_intent: row.stripe_payment_intent_id }, { stripeAccount: STRIPE_ACCT, idempotencyKey: `pos-cancel-refund-${id}` });
  const busy = await w.action({ ...body, device_time: w.nowIso() });
  assertEquals([busy.status, err(busy).code, busy.headers?.['Retry-After']], [503, 'action_pending', '5']);
  w.h.clock.advance(PENDING_STALE_MS + 1);
  const rerun = okBody(await w.action({ ...body, device_time: w.nowIso() }));
  assertEquals([rerun.result, rerun.order.status, rerun.order.refund.status], ['applied', 'cancelled', 'completed']);
  assertEquals(w.money.refunds.size, 1, 'one refund');
  assert(w.h.logs.some((l) => l.includes('online_refund_rerun')));
  assertEquals(w.online.actions.get(id)!.outcome, 'applied');
  void first;
});

Deno.test('no payment intent / no connected Stripe account → 400 action_not_allowed (stored), nothing written; not configured → 501; a KitchenHub order → action_not_allowed', async () => {
  const w = await moneyWorld();
  const unpaid = paid(w, { stripe_payment_intent_id: null });
  assertEquals(err(await cancel(w, unpaid.id, 'in_progress')), { status: 400, code: 'action_not_allowed', message: 'No payment intent found for this order' });
  const w2 = await world();
  const row2 = paid(w2);
  assertEquals(err(await cancel(w2, row2.id, 'in_progress')).message, 'Restaurant has no connected Stripe account');
  w2.deps.refund = undefined;
  assertEquals(err(await cancel(w2, paid(w2).id, 'in_progress')).status, 501);
  const w3 = await world({ restaurant: { dsp_orders_enabled: true } });
  const kh = khRow(w3.nowIso(), { status: 'accepted' });
  w3.db.insertRow('external_orders', kh);
  assertEquals(err(await cancel(w3, kh.id, 'in_progress')).code, 'action_not_allowed');
  assertEquals(w.money.stripeCalls.length + w2.money.stripeCalls.length + w3.money.stripeCalls.length, 0);
  assertEquals(w.order(unpaid.id).status, 'in_progress');
});

// ---- Adjust (money.test.ts :186-249) ----------------------------------------------------------------------------

Deno.test('Adjust: complete orders only → the tablet\'s insert (order_id, order_number, restaurant_id, type, amount in DOLLARS, note trimmed) PENDING; nothing charged, the order row untouched', async () => {
  const w = await moneyWorld();
  const row = paid(w, { status: 'complete' });
  const before = structuredClone(w.order(row.id));
  const b = okBody(await adjust(w, row.id, 'charge', 500, '  Extra cheese  '));
  assertEquals(b.result, 'applied');
  const [adj] = w.db.rows('adjustment_requests');
  assertEquals([adj.order_id, adj.order_number, adj.restaurant_id, adj.type, adj.amount, adj.note, adj.status], [row.id, row.order_number, R1, 'charge', 5, 'Extra cheese', 'pending']);
  assertEquals(b.order.adjustments.map((a) => [a.type, a.amount_cents, a.note, a.status]), [['charge', 500, 'Extra cheese', 'pending']]);
  assertEquals(changed(before, w.order(row.id)), ['adjustment_requests'], 'only the (fake) embedded list — no orders column');
  assertEquals([w.money.stripeCalls.length, w.money.calls.length], [0, 0], 'no Stripe / Uber call from the POS');
  // after Complete a refund is a request too
  assertEquals(okBody(await adjust(w, row.id, 'refund', 1999, 'cold')).result, 'applied');
  assertEquals(w.db.rows('adjustment_requests').map((a) => [a.type, a.amount]), [['charge', 5], ['refund', 19.99]]);
});

Deno.test('Adjust refused: not complete (stored, 400 action_not_allowed), $0 / not an integer → amount_invalid, no / blank / > 200 note, card numbers → card_data_rejected, bad type, KitchenHub — nothing inserted', async () => {
  const w = await moneyWorld();
  const live = paid(w, { status: 'in_progress' });
  const r = await adjust(w, live.id, 'charge', 500, 'x', { expected_status: 'in_progress' });
  assertEquals(err(r).code, 'action_not_allowed');
  const done = paid(w, { status: 'complete' });
  for (const [args, code] of [
    [['charge', 0], 'amount_invalid'], [['charge', 2.5], 'amount_invalid'], [['charge', '500'], 'amount_invalid'],
    [['charge', 500, '   '], 'invalid_payload'], [['charge', 500, null], 'invalid_payload'], [['charge', 500, 'x'.repeat(201)], 'invalid_payload'],
    [['charge', 500, 'card 4242 4242 4242 4242'], 'card_data_rejected'], [['refund', 500, '4111-1111-1111-1111 please'], 'card_data_rejected'],
    [['bonus', 500], 'invalid_payload'],
  ] as const) {
    assertEquals(err(await adjust(w, done.id, args[0], args[1], args.length > 2 ? args[2] : 'Extra cheese')).code, code, JSON.stringify(args));
  }
  assertEquals(err(await adjust(w, done.id, 'charge', 500, 'x', { expected_status: 'in_progress' })).code, 'status_conflict');
  const w3 = await world({ restaurant: { dsp_orders_enabled: true } });
  const kh = khRow(w3.nowIso(), { status: 'completed' });
  w3.db.insertRow('external_orders', kh);
  assertEquals(err(await adjust(w3, kh.id, 'charge', 500)).code, 'action_not_allowed');
  assertEquals([w.db.rows('adjustment_requests').length, w3.db.rows('adjustment_requests').length], [0, 0]);
  assertEquals(okBody(await adjust(w, done.id, 'charge', 200, 'x'.repeat(200))).result, 'applied', '200 characters is fine');
});

Deno.test('Adjust: a lost answer → the same request again = duplicate, ONE row; a stored refusal replays the same error (+ the order now)', async () => {
  const w = await moneyWorld();
  const done = paid(w, { status: 'complete' });
  const id = crypto.randomUUID();
  assertEquals(okBody(await adjust(w, done.id, 'refund', 400, 'cold', { action_id: id })).result, 'applied');
  assertEquals(okBody(await adjust(w, done.id, 'refund', 400, 'cold', { action_id: id, device_time: '2026-11-19T18:00:00.000Z' })).result, 'duplicate');
  assertEquals(w.db.rows('adjustment_requests').length, 1);
  const live = paid(w, { status: 'in_progress' });
  const id2 = crypto.randomUUID();
  const r1 = await adjust(w, live.id, 'charge', 500, 'x', { action_id: id2 });
  assertEquals([err(r1).status, err(r1).code, errOrder(r1).status], [409, 'status_conflict', 'in_progress']);
  w.order(live.id).status = 'complete';
  const r2 = await adjust(w, live.id, 'charge', 500, 'x', { action_id: id2 });
  assertEquals([err(r2).code, errOrder(r2).status], ['status_conflict', 'complete'], 'the stored answer, with the order as it is now');
  assertEquals(w.db.rows('adjustment_requests').length, 1);
});
