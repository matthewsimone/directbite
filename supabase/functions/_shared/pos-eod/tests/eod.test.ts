/**
 * Item 7 (server): shifts / cash movements / refunds / day close + post_z, against the memory stores.
 *
 * Ported from ordr-pos (server-behavior EOD cases that exercise FakeServer):
 *   test/db/endOfDay.test.ts:462 "a full day syncs: shift versions, refund after its order, Z; server verifies the drawer"
 *   test/db/endOfDay.test.ts:493 "refund before the server knows the payment → 409 unknown_payment → retried → applied once"
 *   test/db/endOfDay.test.ts:507 "server flags: drawer_mismatch on a tampered expected; drawer_unverified when payments are
 *                                 not synced yet; refund over payment flagged, not rejected" (+ card data in a reason → 400)
 *   test/db/endOfDay.test.ts:536 "post_z on the server: an order after Z is flagged until a supplemental Z covers it; replays are duplicates"
 *   test/db/endOfDay.test.ts:560 "a shift that arrived before its payments is re-verified when they arrive"
 *   test/db/endOfDay.test.ts:426/447 business-day cutoff 04:00 America/New_York + DST (the server-side function)
 *   test/db/staff.test.ts:585 refund / shift / Z parts of register_actor_after_staff
 *   test/sync/deviceAuth.test.ts:300 shift / refund / day close identity (restaurant ≠ → 400; device ≠ → 403)
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { contentHash, ORDER_HASH_EXCLUDES } from '../../pos-sync/canonicalJson.ts';
import type { DeviceResult } from '../../pos-sync/http.ts';
import { MemoryOrderStore, type SubmitOrderOk } from '../../pos-sync/orderStore.ts';
import { handleSubmitOrder, type SubmitOrderDeps } from '../../pos-sync/submitOrder.ts';
import type { OrderPayload } from '../../pos-sync/orderPayload.ts';
import { cash, card, next, payload, snapshot, uuid } from '../../pos-sync/tests/orderFixtures.ts';
import { err, harness, ok, R2, type Registered } from '../../pos-device/tests/harness.ts';
import { expectedCash } from '../../ordr-core-ext/drawer.ts';
import { MemoryStaffStore } from '../../pos-staff/store.ts';
import { DEFAULT_KDF } from '../../pos-staff/kdf.ts';
import { handleDayClose, handleRefund, handleShift, orderPostZ, type EodDeps } from '../handlers.ts';
import type { DayClosePayload, RefundPayload, ShiftPayload, WireCashMovement } from '../payloads.ts';
import { businessDate, type ShiftAttribution } from '../rules.ts';
import { MemoryEodStore, type EntityResponse } from '../store.ts';

const D = '2026-11-19';
const NOON = '2026-11-19T17:00:00.000Z'; // 12:00 New York

async function hashed<T extends { content_hash: string }>(p: T): Promise<T> {
  p.content_hash = await contentHash(p as unknown as Record<string, unknown>, ORDER_HASH_EXCLUDES);
  return p;
}

async function setup() {
  const h = harness();
  const A = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const B = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const orders = new MemoryOrderStore();
  const eod = new MemoryEodStore(orders);
  const staff = new MemoryStaffStore();
  const menu = await snapshot();
  orders.putSnapshot(menu);
  const orderDeps: SubmitOrderDeps = { ...h.deps, orders, current: { get: () => Promise.resolve(menu) }, staff, eod };
  const eodDeps: EodDeps = { ...h.deps, eod, staff };
  const req = (body: unknown, dev: Registered | Record<string, string>) => ({
    method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', ...('device_token' in dev ? h.asDevice(dev as Registered) : dev as Record<string, string>) }), bodyText: JSON.stringify(body), ip: null,
  });
  const order = async (p: OrderPayload, dev: Registered = A) => ok<SubmitOrderOk>(await handleSubmitOrder(req(p, dev), orderDeps));
  const shiftCall = (p: unknown, dev: Registered | Record<string, string> = A) => handleShift(req(p, dev), eodDeps);
  const refundCall = (p: unknown, dev: Registered | Record<string, string> = A) => handleRefund(req(p, dev), eodDeps);
  const zCall = (p: unknown, dev: Registered | Record<string, string> = A) => handleDayClose(req(p, dev), eodDeps);
  /** A closed cash (or card) order of `total` 2068 (pie, tax) on device A; returns ids. */
  const paidOrder = async (method: 'cash' | 'external_card' = 'cash', o: Partial<OrderPayload> = {}, dev: Registered = A) => {
    const pay = method === 'cash' ? cash(2068) : card(2068);
    const p = await payload(dev, menu, { payments: [pay], ...o });
    const r = await order(p, dev);
    return { p, id: p.order_id, paymentId: pay.id, total: 2068, r };
  };
  return { h, A, B, orders, eod, staff, menu, order, shiftCall, refundCall, zCall, paidOrder };
}

const body = (r: DeviceResult) => ok<EntityResponse>(r);
const code = (r: DeviceResult) => (r.body as { error?: { code: string } }).error?.code;

function shiftOf(dev: Registered, o: Partial<ShiftPayload> = {}): ShiftPayload {
  return {
    shift_id: uuid(), version: 1, content_hash: '', restaurant_id: dev.restaurant_id, device_id: dev.device_id, business_date: D,
    status: 'open', opened_at: '2026-11-19T15:00:00.000Z', opened_by: 'register', starting_cash_cents: 15000, closed_at: null,
    closed_by: null, close_approved_by: null, counted_cash_cents: null, expected_cash_cents: null, over_short_cents: null,
    movements: [], attribution: null, device_time: '2026-11-19T15:00:00.000Z', ...o,
  };
}
const move = (kind: 'paid_in' | 'paid_out', amount: number, o: Partial<WireCashMovement> = {}): WireCashMovement =>
  ({ id: uuid(), kind, amount_cents: amount, reason: 'Driver gas', actor: 'register', approved_by: null, created_at: '2026-11-19T16:00:00.000Z', ...o });

/** The device's closing version: expected from the attribution with the same drawer.ts. */
function closed(s: ShiftPayload, a: ShiftAttribution, counted: number, o: Partial<ShiftPayload> = {}): ShiftPayload {
  const expected = expectedCash({
    starting: s.starting_cash_cents,
    cashPayments: a.cash_payments.map((x) => x.amount_cents),
    cashPaymentVoids: a.cash_payment_voids.map((x) => x.amount_cents),
    cashRefunds: a.cash_refunds.map((x) => x.amount_cents),
    paidIns: s.movements.filter((m) => m.kind === 'paid_in').map((m) => m.amount_cents),
    paidOuts: s.movements.filter((m) => m.kind === 'paid_out').map((m) => m.amount_cents),
  });
  return { ...s, version: s.version + 1, status: 'closed', closed_at: '2026-11-19T23:00:00.000Z', closed_by: 'register', attribution: a, counted_cash_cents: counted, expected_cash_cents: expected, over_short_cents: counted - expected, device_time: '2026-11-19T23:00:00.000Z', ...o };
}
const attr = (o: Partial<ShiftAttribution> = {}): ShiftAttribution => ({ cash_payments: [], cash_payment_voids: [], cash_refunds: [], ...o });

function refundOf(dev: Registered, orderId: string, paymentId: string, o: Partial<RefundPayload> = {}): RefundPayload {
  return {
    refund_id: uuid(), version: 1, content_hash: '', restaurant_id: dev.restaurant_id, device_id: dev.device_id, order_id: orderId,
    payment_id: paymentId, method: 'cash', amount_cents: 300, reason: 'Wrong item', actor: 'register', approved_by: null,
    business_date: D, shift_id: null, created_at: '2026-11-19T18:00:00.000Z', device_time: '2026-11-19T18:00:00.000Z', ...o,
  };
}
const covered = (o: Partial<DayClosePayload['covered']> = {}): DayClosePayload['covered'] =>
  ({ order_ids: [], voided_order_ids: [], payment_ids: [], payment_void_ids: [], refund_ids: [], shift_ids: [], ...o });
function zOf(dev: Registered, o: Partial<DayClosePayload> = {}): DayClosePayload {
  return {
    day_close_id: uuid(), version: 1, content_hash: '', restaurant_id: dev.restaurant_id, device_id: dev.device_id, business_date: D,
    z_number: 1, sequence: 1, supplemental: false, closed_at: '2026-11-20T03:00:00.000Z', closed_by: 'register', approved_by: null,
    report: { net_sales_cents: 2068 }, covered: covered(), carried_over_order_ids: [], device_time: '2026-11-20T03:00:00.000Z', ...o,
  };
}

// ---- the full day + shifts ------------------------------------------------------------------------

Deno.test('a full day (endOfDay.test :462): shift versions, paid-out, refund after its order, close, Z — drawer verified, nothing flagged', async () => {
  const t = await setup();
  const s1 = shiftOf(t.A);
  assertEquals(body(await t.shiftCall(await hashed({ ...s1 }))).result, 'applied');
  const a = await t.paidOrder('cash');
  const s2 = { ...s1, version: 2, movements: [move('paid_out', 2000)] };
  assertEquals(body(await t.shiftCall(await hashed({ ...s2 }))).server_version, 2);
  const ref = refundOf(t.A, a.id, a.paymentId, { shift_id: s1.shift_id });
  const rr = body(await t.refundCall(await hashed(ref)));
  assertEquals(rr.flags, { refund_exceeds_payment: false, post_z: false, unknown_actor: false, approval_missing: false, register_actor_after_staff: false });
  const s3 = closed(s2, attr({ cash_payments: [{ payment_id: a.paymentId, order_id: a.id, amount_cents: 2068 }], cash_refunds: [{ refund_id: ref.refund_id, payment_id: a.paymentId, amount_cents: 300 }] }), 15000 + 2068 - 2000 - 300);
  const r3 = body(await t.shiftCall(await hashed(s3)));
  assertEquals(r3, { result: 'applied', id: s1.shift_id, version: 3, server_version: 3, server_time: r3.server_time, flags: { drawer_mismatch: false, drawer_unverified: false, post_z: false, unknown_actor: false, register_actor_after_staff: false, approval_missing: false } });
  const z = await hashed(zOf(t.A, { covered: covered({ order_ids: [a.id], payment_ids: [a.paymentId], refund_ids: [ref.refund_id], shift_ids: [s1.shift_id] }) }));
  const rz = body(await t.zCall(z));
  assertEquals(rz.flags, { z_mismatch: false, unknown_actor: false, approval_missing: false, register_actor_after_staff: false });
  assertEquals(t.eod.shifts.get(s1.shift_id)!.status, 'closed');
  assertEquals(t.eod.dayCloses.size, 1);
  assertEquals(t.orders.orders.get(a.id)!.version, 1, 'the refund does not touch the order');
});

Deno.test('shift: versions apply in order (lower → stale_ignored), duplicate / reuse, closed → 409 shift_closed, movements insert-only by id', async () => {
  const t = await setup();
  const s1 = shiftOf(t.A);
  const m = move('paid_in', 500);
  const v1 = await hashed({ ...s1 });
  const v2 = await hashed({ ...s1, version: 2, movements: [m] });
  const v3 = await hashed({ ...s1, version: 3, movements: [m, move('paid_out', 200)] });
  body(await t.shiftCall(v1));
  body(await t.shiftCall(v3)); // v2 still in flight
  const late = body(await t.shiftCall(v2));
  assertEquals([late.result, late.version, late.server_version], ['stale_ignored', 2, 3]);
  assertEquals((body(await t.shiftCall(v1))).result, 'duplicate');
  assertEquals([(await t.shiftCall(await hashed({ ...s1, opened_by: 'someone' }))).status, code(await t.shiftCall(await hashed({ ...s1, opened_by: 'someone' })))], [409, 'idempotency_key_reuse']);
  assertEquals(t.eod.movementInserts.get(m.id), 1, 'inserted once across versions');
  // a movement whose amount changes → 400; nothing stored
  assertEquals(code(await t.shiftCall(await hashed({ ...s1, version: 4, movements: [{ ...m, amount_cents: 501 }] }))), 'invalid_payload');
  // a movement id of another shift → 400
  assertEquals(code(await t.shiftCall(await hashed({ ...shiftOf(t.A), movements: [m] }))), 'invalid_payload');
  // closed without count / attribution → 400 (the reference's check, after the version rules)
  assertEquals(code(await t.shiftCall(await hashed({ ...s1, version: 4, status: 'closed', closed_at: NOON, closed_by: 'register' }))), 'invalid_payload');
  const c = await hashed(closed({ ...s1, version: 3, movements: v3.movements }, attr(), 15300));
  assertEquals(body(await t.shiftCall(c)).flags.drawer_mismatch, false);
  const after = await t.shiftCall(await hashed({ ...c, version: 5, counted_cash_cents: 1 }));
  assertEquals([after.status, code(after)], [409, 'shift_closed']);
  assertEquals(body(await t.shiftCall(await hashed({ ...c, version: 2, content_hash: '', device_time: NOON }))).result, 'stale_ignored', 'lower than a closed shift is still stale, not 409');
});

// ---- drawer ------------------------------------------------------------------------------------------

Deno.test('drawer (endOfDay.test :507 / :560): unverified while payments are unsynced → re-verified when the order arrives; tampered expected → mismatch; a listed id that disagrees → mismatch', async () => {
  const t = await setup();
  const s = shiftOf(t.A, { starting_cash_cents: 1000 });
  const pay = cash(2068);
  const p = await payload(t.A, t.menu, { payments: [pay] });
  const early = await hashed(closed(s, attr({ cash_payments: [{ payment_id: pay.id, order_id: p.order_id, amount_cents: 2068 }] }), 1000 + 2068));
  const r = body(await t.shiftCall(early));
  assertEquals([r.flags.drawer_unverified, r.flags.drawer_mismatch], [true, false]);
  await t.order(p); // the order + its cash payment arrive
  assertEquals([t.eod.shifts.get(s.shift_id)!.flags.drawer_unverified, t.eod.shifts.get(s.shift_id)!.flags.drawer_mismatch], [false, false]);
  assertEquals(body(await t.shiftCall(early)).result, 'duplicate', 'the replay is a duplicate (original answer)');
  // tampered expected (fresh shift id)
  const tam = await hashed({ ...early, shift_id: uuid(), expected_cash_cents: early.expected_cash_cents! + 100, over_short_cents: early.over_short_cents! - 100 });
  assertEquals(body(await t.shiftCall(tam)).flags.drawer_mismatch, true);
  // listed amount ≠ the server's payment / a card payment listed as cash → mismatch
  const off = await hashed(closed(shiftOf(t.A, { starting_cash_cents: 0 }), attr({ cash_payments: [{ payment_id: pay.id, order_id: p.order_id, amount_cents: 2000 }] }), 2000));
  assertEquals(body(await t.shiftCall(off)).flags.drawer_mismatch, true);
  const c = await t.paidOrder('external_card');
  const asCash = await hashed(closed(shiftOf(t.A, { starting_cash_cents: 0 }), attr({ cash_payments: [{ payment_id: c.paymentId, order_id: c.id, amount_cents: 2068 }] }), 2068));
  assertEquals(body(await t.shiftCall(asCash)).flags.drawer_mismatch, true);
});

Deno.test('drawer: a listed cash VOID whose payment is still captured on the server → unverified, re-verified when the voiding order version arrives; a listed refund arriving later re-verifies too', async () => {
  const t = await setup();
  const pay = cash(2068);
  const p1 = await payload(t.A, t.menu, { status: 'open', payments: [pay] });
  await t.order(p1);
  const s = shiftOf(t.A, { starting_cash_cents: 0 });
  const r = body(await t.shiftCall(await hashed(closed(s, attr({ cash_payments: [{ payment_id: pay.id, order_id: p1.order_id, amount_cents: 2068 }], cash_payment_voids: [{ payment_id: pay.id, order_id: p1.order_id, amount_cents: 2068 }] }), 0))));
  assertEquals([r.flags.drawer_unverified, r.flags.drawer_mismatch], [true, false]);
  await t.order(await next(p1, { payments: [{ ...pay, status: 'voided', voided_by: 'register' }] }));
  assertEquals(t.eod.shifts.get(s.shift_id)!.flags.drawer_unverified, false);
  // a refund listed before it synced
  const a = await t.paidOrder('cash');
  const ref = refundOf(t.A, a.id, a.paymentId);
  const s2 = shiftOf(t.A, { starting_cash_cents: 0 });
  body(await t.shiftCall(await hashed(closed(s2, attr({ cash_payments: [{ payment_id: a.paymentId, order_id: a.id, amount_cents: 2068 }], cash_refunds: [{ refund_id: ref.refund_id, payment_id: a.paymentId, amount_cents: 300 }] }), 1768))));
  assertEquals(t.eod.shifts.get(s2.shift_id)!.flags.drawer_unverified, true);
  body(await t.refundCall(await hashed(ref)));
  assertEquals([t.eod.shifts.get(s2.shift_id)!.flags.drawer_unverified, t.eod.shifts.get(s2.shift_id)!.flags.drawer_mismatch], [false, false]);
});

// ---- refunds ------------------------------------------------------------------------------------------

Deno.test('refund (endOfDay.test :493 / :507): 409 unknown_payment until the order arrives, then applied once; method mismatch / amount ≤ 0 → 400; over-refund flagged, never rejected; card data in a reason → 400', async () => {
  const t = await setup();
  const pay = card(2068);
  const p = await payload(t.A, t.menu, { payments: [pay] });
  const ref = await hashed(refundOf(t.A, p.order_id, pay.id, { method: 'external_card', amount_cents: 100, reason: 'Overcharged' }));
  const early = await t.refundCall(ref);
  assertEquals([early.status, code(early)], [409, 'unknown_payment']);
  assertEquals(t.eod.refundRows.size, 0);
  await t.order(p);
  assertEquals(body(await t.refundCall(ref)).result, 'applied');
  assertEquals(body(await t.refundCall(ref)).result, 'duplicate');
  assertEquals(t.eod.refundRows.size, 1);
  // payment on another order → unknown_payment
  assertEquals(code(await t.refundCall(await hashed(refundOf(t.A, uuid(), pay.id, { method: 'external_card' })))), 'unknown_payment');
  assertEquals(code(await t.refundCall(await hashed(refundOf(t.A, p.order_id, pay.id, { method: 'cash' })))), 'invalid_payload');
  assertEquals(code(await t.refundCall(await hashed(refundOf(t.A, p.order_id, pay.id, { method: 'external_card', amount_cents: 0 })))), 'invalid_payload');
  // Σ refunds > payment: 100 already + 2000 → 2100 > 2068 → flagged, applied
  const over = body(await t.refundCall(await hashed(refundOf(t.A, p.order_id, pay.id, { method: 'external_card', amount_cents: 2000 }))));
  assertEquals([over.result, over.flags.refund_exceeds_payment], ['applied', true]);
  const pan = await t.refundCall(await hashed(refundOf(t.A, p.order_id, pay.id, { method: 'external_card', reason: '4111 1111 1111 1111' })));
  assertEquals([pan.status, code(pan)], [400, 'card_data_rejected']);
});

// ---- day close -------------------------------------------------------------------------------------

Deno.test('day close: (register, day, sequence) taken → 409; supplemental ≠ (sequence > 1) → 400; another register may use sequence 1; replay → duplicate', async () => {
  const t = await setup();
  const z1 = await hashed(zOf(t.A));
  body(await t.zCall(z1));
  assertEquals(code(await t.zCall(await hashed(zOf(t.A)))), 'day_close_sequence_taken');
  assertEquals(code(await t.zCall(await hashed(zOf(t.A, { sequence: 2, supplemental: false })))), 'invalid_payload');
  assertEquals(code(await t.zCall(await hashed(zOf(t.A, { sequence: 1, supplemental: true, business_date: '2026-11-20' })))), 'invalid_payload');
  assertEquals(body(await t.zCall(await hashed(zOf(t.B)), t.B)).result, 'applied', 'per register');
  assertEquals(body(await t.zCall(await hashed(zOf(t.A, { sequence: 2, supplemental: true, z_number: 2 })))).result, 'applied');
  assertEquals(body(await t.zCall(z1)).result, 'duplicate');
  assertEquals(code(await t.zCall(await hashed({ ...z1, report: { net_sales_cents: 1 } }))), 'idempotency_key_reuse');
  // UUID-format *_ids values are skipped by the card guard; other text under them is scanned
  assertEquals(body(await t.zCall(await hashed(zOf(t.A, { business_date: '2026-11-21', covered: covered({ order_ids: [uuid(), uuid()] }) })))).result, 'applied');
  assertEquals(code(await t.zCall(await hashed(zOf(t.A, { business_date: '2026-11-22', covered: covered({ order_ids: ['4111 1111 1111 1111'] }) })))), 'card_data_rejected');
});

// ---- post_z -------------------------------------------------------------------------------------------

Deno.test('post_z (endOfDay.test :536): an order finalized on a day that already has a Z from its register is flagged until a supplemental Z covers it; open / carried orders never', async () => {
  const t = await setup();
  const first = await t.paidOrder('cash');
  assertEquals(first.r.flags.post_z, false);
  body(await t.zCall(await hashed(zOf(t.A, { covered: covered({ order_ids: [first.id] }) }))));
  const late = await t.paidOrder('external_card');
  assertEquals(late.r.flags.post_z, true);
  // another register's Z does not count; another register's order isn't post-Z for A's Z
  const otherDev = await t.paidOrder('cash', {}, t.B);
  assertEquals(otherDev.r.flags.post_z, false);
  // carried over: open at the Z → never post-Z; listed as carried over
  const open = await payload(t.A, t.menu, { status: 'open' });
  assertEquals((await t.order(open)).flags.post_z, false);
  body(await t.zCall(await hashed(zOf(t.A, { sequence: 2, supplemental: true, z_number: 2, covered: covered({ order_ids: [late.id] }), carried_over_order_ids: [open.order_id] }))));
  assertEquals(await orderPostZ(t.eod, t.A.device_id, D, late.id), false, 'covered by the supplemental');
  // the carried order closes the NEXT business day → that day's sale (no Z there yet)
  const closedNext = await t.order(await next(open, { status: 'closed', payments: [cash(2068)], device_time: '2026-11-20T17:00:00.000Z' }));
  assertEquals([closedNext.flags.post_z, t.orders.orders.get(open.order_id)!.sales_day], [false, '2026-11-20']);
  // sales day is sticky: a later edit on the 21st keeps the 20th
  await t.order(await next(await next(open, { status: 'closed', payments: [cash(2068)], device_time: '2026-11-20T17:00:00.000Z' }), { note: 'edit', device_time: '2026-11-21T17:00:00.000Z' }));
  assertEquals(t.orders.orders.get(open.order_id)!.sales_day, '2026-11-20');
  // a voided order covered in voided_order_ids is not post-Z
  const v = await payload(t.A, t.menu, { status: 'voided', void_reason: 'mistake', voided_by: 'register', device_time: '2026-11-19T20:00:00.000Z' });
  const rv = await t.order(v);
  assertEquals(rv.flags.post_z, true);
  body(await t.zCall(await hashed(zOf(t.A, { sequence: 3, supplemental: true, z_number: 3, covered: covered({ voided_order_ids: [v.order_id] }) }))));
  assertEquals(await orderPostZ(t.eod, t.A.device_id, D, v.order_id), false);
});

Deno.test('post_z: the 04:00 business-day cutoff (America/New_York) decides the sales day — 03:59 is still the previous day', async () => {
  const t = await setup();
  body(await t.zCall(await hashed(zOf(t.A)))); // Z #1 for 2026-11-19, covering nothing
  const at = async (iso: string) => {
    const p = await payload(t.A, t.menu, { device_time: iso, payments: [cash(2068)] });
    const r = await t.order(p);
    return [t.orders.orders.get(p.order_id)!.sales_day, r.flags.post_z];
  };
  assertEquals(await at('2026-11-20T08:59:59.000Z'), ['2026-11-19', true], '03:59:59 EST');
  assertEquals(await at('2026-11-20T09:00:00.000Z'), ['2026-11-20', false], '04:00 EST');
  // the function itself (endOfDay.test :447): DST fall back / spring forward keep the wall-clock cutoff
  assertEquals(businessDate(Date.parse('2026-11-01T07:59:00Z'), 'America/New_York', '04:00'), '2026-10-31', '02:59 EST after fall back');
  assertEquals(businessDate(Date.parse('2026-11-01T09:00:00Z'), 'America/New_York', '04:00'), '2026-11-01', '04:00 EST');
  assertEquals(businessDate(Date.parse('2026-03-08T07:59:00Z'), 'America/New_York', '04:00'), '2026-03-07', '03:59 EDT after spring forward');
  assertEquals(businessDate(Date.parse('2026-03-08T08:00:00Z'), 'America/New_York', '04:00'), '2026-03-08', '04:00 EDT');
});

Deno.test('post_z on shifts (closed only) and refunds dated a day with a Z that does not cover them', async () => {
  const t = await setup();
  const a = await t.paidOrder('cash');
  body(await t.zCall(await hashed(zOf(t.A, { covered: covered({ order_ids: [a.id] }) }))));
  const s = shiftOf(t.A, { starting_cash_cents: 0 });
  assertEquals(body(await t.shiftCall(await hashed({ ...s }))).flags.post_z, false, 'open shift: never');
  const c = body(await t.shiftCall(await hashed(closed(s, attr({ cash_payments: [{ payment_id: a.paymentId, order_id: a.id, amount_cents: 2068 }] }), 2068))));
  assertEquals(c.flags.post_z, true);
  assertEquals(body(await t.refundCall(await hashed(refundOf(t.A, a.id, a.paymentId)))).flags.post_z, true);
  assertEquals(body(await t.refundCall(await hashed(refundOf(t.A, a.id, a.paymentId, { business_date: '2026-11-20' })))).flags.post_z, false, 'next day: no Z yet');
});

// ---- staff flags on each entity (shared module; settings at the row's time) -------------------------

Deno.test('staff flags on shift / refund / Z: paid-out and over-short close need a manager; refunds always; Z per z_requires_manager at its time; register after staff; unknown actor', async () => {
  const t = await setup();
  const add = async (name: string, role: 'manager' | 'staff') => {
    const r = await t.staff.add(t.A.restaurant_id, name, role, '0'.repeat(31) + '1', 'ab'.repeat(32), DEFAULT_KDF);
    assert(r.ok);
    return r.staff_id;
  };
  const maria = await add('Maria', 'manager');
  const sam = await add('Sam', 'staff');
  const snapAt = Date.parse('2026-11-19T14:00:00Z');
  await t.staff.publish(t.A.restaurant_id, { restaurant_id: t.A.restaurant_id, version: 2, hash: 'a'.repeat(64), settings: { auto_lock_minutes: 5, over_short_approval_cents: 500, z_requires_manager: true, pin_kdf: DEFAULT_KDF }, staff: [] }, snapAt);
  // shift: a staff paid-out without approval; over-short 1000 > 500 closed by staff without approval
  const s = shiftOf(t.A, { opened_by: sam, starting_cash_cents: 0, movements: [move('paid_out', 100, { actor: sam })] });
  const r = body(await t.shiftCall(await hashed(closed(s, attr(), 1000, { closed_by: sam }))));
  assertEquals([r.flags.approval_missing, r.flags.unknown_actor, r.flags.register_actor_after_staff], [true, false, false]);
  const okShift = shiftOf(t.A, { opened_by: sam, starting_cash_cents: 0, movements: [move('paid_out', 100, { actor: sam, approved_by: maria })] });
  assertEquals(body(await t.shiftCall(await hashed(closed(okShift, attr(), -100 + 100, { closed_by: sam })))).flags.approval_missing, false, 'within threshold + approved paid-out');
  // register after staff on a shift opened after publication
  assertEquals(body(await t.shiftCall(await hashed(shiftOf(t.A))))!.flags.register_actor_after_staff, true);
  // refund by staff without a manager; by a stranger
  const a = await t.paidOrder('cash');
  const rf = body(await t.refundCall(await hashed(refundOf(t.A, a.id, a.paymentId, { actor: sam }))));
  assertEquals([rf.flags.approval_missing, rf.flags.unknown_actor], [true, false]);
  assertEquals(body(await t.refundCall(await hashed(refundOf(t.A, a.id, a.paymentId, { actor: uuid() })))).flags.unknown_actor, true);
  assertEquals(body(await t.refundCall(await hashed(refundOf(t.A, a.id, a.paymentId, { actor: sam, approved_by: maria })))).flags.approval_missing, false);
  // Z by staff: needed while z_requires_manager; after the setting flips (published later), a Z closed after it is fine
  assertEquals(body(await t.zCall(await hashed(zOf(t.A, { closed_by: sam })))).flags.approval_missing, true);
  await t.staff.publish(t.A.restaurant_id, { restaurant_id: t.A.restaurant_id, version: 3, hash: 'b'.repeat(64), settings: { auto_lock_minutes: 5, over_short_approval_cents: 500, z_requires_manager: false, pin_kdf: DEFAULT_KDF }, staff: [] }, Date.parse('2026-11-21T00:00:00Z'));
  assertEquals(body(await t.zCall(await hashed(zOf(t.A, { closed_by: sam, business_date: '2026-11-21', closed_at: '2026-11-22T03:00:00.000Z' })))).flags.approval_missing, false);
  assertEquals(body(await t.zCall(await hashed(zOf(t.A, { closed_by: sam, business_date: '2026-11-20', closed_at: '2026-11-20T23:00:00.000Z' })))).flags.approval_missing, true, 'judged at its own time');
  assertEquals(body(await t.zCall(await hashed(zOf(t.A, { business_date: '2026-11-23' })))).flags.register_actor_after_staff, true);
});

// ---- identity / envelope ----------------------------------------------------------------------------

Deno.test('identity + envelope (deviceAuth.test :300): restaurant ≠ → 400; device ≠ → 403; an id of another restaurant → 400; bad hash → 400; non-UUID id → 400; revoked → 401', async () => {
  const t = await setup();
  const s = await hashed(shiftOf(t.A));
  assertEquals(err(await t.shiftCall({ ...s, restaurant_id: R2 })).code, 'restaurant_mismatch');
  assertEquals(err(await t.shiftCall({ ...s, device_id: t.B.device_id })).status, 403);
  assertEquals(code(await t.shiftCall({ ...s, note: 'x' })), 'invalid_payload');
  assertEquals(code(await t.shiftCall(await hashed({ ...s, shift_id: 'tampered' }))), 'invalid_payload');
  assertEquals(code(await t.refundCall(await hashed(refundOf(t.A, uuid(), uuid(), { version: 2 as 1 })))), 'invalid_payload');
  body(await t.shiftCall(s));
  // a register of another restaurant names this shift id
  const r2dev = ok<Registered>(await t.h.register(t.h.req((await t.h.enroll({ restaurantId: R2 })).code)));
  assertEquals(err(await t.shiftCall(await hashed({ ...s, version: 2, restaurant_id: R2, device_id: r2dev.device_id }), r2dev)).code, 'restaurant_mismatch');
  ok(await t.h.admin({ action: 'revoke', device_id: t.A.device_id, reason: 'test' }));
  assertEquals(err(await t.zCall(await hashed(zOf(t.A)))).code, 'device_revoked');
});
