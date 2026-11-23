/**
 * pos-v1-submit-order (SYNC-CONTRACT §1a, §3; handoff items 2, 3, 6) against the in-memory store.
 *
 * Ported from ordr-pos (server-behavior cases that exercise FakeServer submit-order; same fixture
 * numbers — pie large 1899, tax 0.08875 → 2068):
 *   test/sync/worker.test.ts       — offline sale (number, server wins, no flags); lost response →
 *                                    duplicate; 409 version_conflict; 409 idempotency_key_reuse;
 *                                    stale_price not mismatch; tampered price → mismatch + per-field diff;
 *                                    unknown snapshot → current + 2285; module drift; availability ×3;
 *                                    reward inside a line; promo-exempt category
 *   test/adversarial/scenarios.test.ts case 7 (ownership passes / stale copy 409 / higher foreign
 *                                    version → conflict / never-synced base 0 → conflict), case 8
 *                                    (every redemption shape → 400)
 *   test/sync/deviceAuth.test.ts   — identity rules (:255) + writer = principal, in-person pricing (:274)
 *   test/db/externalCard.test.ts   — mixed tender stored; refund captured → voided insert-only; card
 *                                    number anywhere → 400 nothing stored; payment shape → 400
 *   test/db/delivery.test.ts       — override flat fee + delivery_override; pending closed →
 *                                    delivery_fee_missing; below minimum flagged never 400; device fee ≠
 *                                    source → delivery_fee_mismatch + money mismatch; unknown quote →
 *                                    delivery_quote_unknown (server fee = offline fee here, no geocoder yet)
 *   test/db/orderDetails.test.ts   — note / ready_at / void_reason accepted + stored
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { SnapshotError, type MenuSnapshot } from '../menuSnapshot.ts';
import type { OrderPayload, WirePayment } from '../orderPayload.ts';
import { priceAgainstSnapshot } from '../orderPricing.ts';
import { MemoryOrderStore, type SubmitOrderOk } from '../orderStore.ts';
import { NO_STAFF } from '../../pos-staff/flags.ts';
import { handleSubmitOrder, type SubmitOrderDeps } from '../submitOrder.ts';
import { sizePricesToMap } from '../sizePrices.ts';
import { cents, parseRate, ZERO, ZERO_RATE } from '../../ordr-core/money.ts';
import { card, cash, IDS, line, mod, next, payload, rehash, snapshot, uuid } from './orderFixtures.ts';
import { priceOrder } from '../../ordr-core/order/index.ts';
import { PRICING_MODULE_HASH } from '../../pos-v1/moduleInfo.ts';
import { err, harness, ok, R2, type Registered } from '../../pos-device/tests/harness.ts';
import type { DeviceResult } from '../http.ts';

// ---- the harness -----------------------------------------------------------------------------------

async function setup(o: { snap?: MenuSnapshot } = {}) {
  const h = harness();
  const A = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const B = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const orders = new MemoryOrderStore();
  const snap = o.snap ?? (await snapshot());
  orders.putSnapshot(snap);
  const state = { current: snap as MenuSnapshot, currentError: null as SnapshotError | null };
  const deps: SubmitOrderDeps = {
    ...h.deps,
    orders,
    current: {
      get: () => {
        if (state.currentError) return Promise.reject(state.currentError);
        orders.putSnapshot(state.current);
        return Promise.resolve(state.current);
      },
    },
    staff: { context: () => Promise.resolve(NO_STAFF) },
  };
  /** Publish a new current menu (the server's snapshot moves on). */
  const publish = (s: MenuSnapshot) => { state.current = s; };
  const forget = (hash: string) => { orders.snapshots.delete(hash); };
  async function submit(p: unknown, as: Registered | Record<string, string> = A): Promise<DeviceResult> {
    const headers = 'device_token' in as ? h.asDevice(as as Registered) : (as as Record<string, string>);
    return await handleSubmitOrder({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', ...headers }), bodyText: JSON.stringify(p), ip: null }, deps);
  }
  return { h, A, B, orders, snap, deps, state, publish, forget, submit };
}

const okBody = (r: DeviceResult) => ok<SubmitOrderOk>(r);
const errBody = (r: DeviceResult) => (r.body as { error: Record<string, unknown> }).error;

// ---- §3.1, row by row --------------------------------------------------------------------------

Deno.test('§3.1 row 1: unknown order, base 0 → 200 applied; order number; server pricing of record; no flags (worker: offline sale)', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap, { payments: [cash(2068)] });
  const r = okBody(await t.submit(p));
  assertEquals([r.result, r.version, r.server_version, r.order_number, r.priced_against_hash], ['applied', 1, 1, 5_000_001, t.snap.hash]);
  assertEquals(r.pricing.total_cents, 2068);
  assertEquals(r.flags, { mismatch: false, stale_price: false, unknown_snapshot: false, availability_flag: false, unknown_actor: false, approval_missing: false, register_actor_after_staff: false });
  assertEquals(r.diff, {});
  assertEquals(r.pricing_module_hash, PRICING_MODULE_HASH);
  assertEquals(r.server_time, '2026-11-19T17:00:00.000Z');
  assertEquals(t.orders.applied.length, 1);
  assertEquals(t.orders.orders.get(p.order_id)!.writer_device_id, t.A.device_id);
});

Deno.test('§3.1 row 2: unknown order, base > 0 → 409 version_conflict (no server version)', async () => {
  const t = await setup();
  const r = await t.submit(await payload(t.A, t.snap, { version: 3, base_server_version: 2 }));
  assertEquals(err(r).status, 409);
  assertEquals(errBody(r).code, 'version_conflict');
  assert(!('server_version' in errBody(r)));
  assertEquals(t.orders.applied.length, 0);
});

Deno.test('§3.1 row 3: same device, n > c → applied; order number kept', async () => {
  const t = await setup();
  const p1 = await payload(t.A, t.snap, { status: 'open' });
  const r1 = okBody(await t.submit(p1));
  const r2 = okBody(await t.submit(await next(p1, { status: 'closed', payments: [cash(2068)] })));
  assertEquals([r2.result, r2.server_version, r2.order_number], ['applied', 2, r1.order_number]);
});

Deno.test('§3.1 row 4 + scenarios case 7: another device with base == c → applied, ownership passes; the stale copy then 409s (never last-write-wins)', async () => {
  const t = await setup();
  const p1 = await payload(t.A, t.snap, { status: 'open' });
  okBody(await t.submit(p1));
  // B edits A's order (keeps A's ticket prefix — §1a), base = 1
  const pb = await next(p1, { device_id: t.B.device_id, base_server_version: 1, note: 'B edit' });
  const rb = okBody(await t.submit(pb, t.B));
  assertEquals(rb.result, 'applied');
  assertEquals(t.orders.orders.get(p1.order_id)!.writer_device_id, t.B.device_id);
  // A edited a stale copy: version even higher than B's, base still 1
  const pa = await next(p1, { version: 5, base_server_version: 1, note: 'A edit' });
  const ra = await t.submit(pa);
  assertEquals(err(ra).status, 409);
  assertEquals(errBody(ra), { code: 'version_conflict', message: 'order was changed by another device', server_version: 2, server_writer_device_id: t.B.device_id });
  const so = t.orders.orders.get(p1.order_id)!;
  assertEquals([so.version, so.writer_device_id, so.payload.content_hash], [2, t.B.device_id, pb.content_hash], 'server keeps B');
});

Deno.test('§3.1 row 5: another device, base < c → 409 version_conflict with server_version + server_writer_device_id', async () => {
  const t = await setup();
  const p1 = await payload(t.A, t.snap, { status: 'open' });
  okBody(await t.submit(p1));
  okBody(await t.submit(await next(p1)));
  const r = await t.submit(await next(p1, { device_id: t.B.device_id, version: 3, base_server_version: 1 }), t.B);
  assertEquals(errBody(r).server_version, 2);
  assertEquals(errBody(r).server_writer_device_id, t.A.device_id);
});

Deno.test('scenarios case 7: a higher foreign version (other writer, n ≤ c) → conflict, not stale_ignored; B seeded first, A pushes its own v1 (base 0) → conflict', async () => {
  const t = await setup();
  const p1 = await payload(t.A, t.snap, { status: 'open' });
  okBody(await t.submit(p1));
  okBody(await t.submit(await next(p1, { device_id: t.B.device_id, version: 6, base_server_version: 1 }), t.B));
  const r = await t.submit(await next(p1)); // A: v2 < 6, writer B
  assertEquals([err(r).status, errBody(r).code, errBody(r).server_version], [409, 'version_conflict', 6]);
  // never synced by A: the server already has v1 of this order id from B (the reference seeds it past
  // identity and the idempotency store; through the wire B's new order carries B's prefix and stores the
  // key (order, 1)). A pushes v1 base 0 keeping the stored prefix → the key check comes first → 409
  // idempotency_key_reuse (the reference's seeded order gives 409 version_conflict; both → device
  // "conflict"); A's v2 base 0 → 409 version_conflict naming B; with A's own prefix → prefix_mismatch.
  const q = await payload(t.B, t.snap, { status: 'open' });
  okBody(await t.submit(q, t.B));
  const ra = await t.submit(await rehash({ ...structuredClone(q), device_id: t.A.device_id, note: 'A own v1' }));
  assertEquals([err(ra).status, errBody(ra).code], [409, 'idempotency_key_reuse']);
  const rv = await t.submit(await rehash({ ...structuredClone(q), version: 2, device_id: t.A.device_id, note: 'A own v2' }));
  assertEquals([err(rv).status, errBody(rv).code, errBody(rv).server_writer_device_id], [409, 'version_conflict', t.B.device_id]);
  const rp = await t.submit(await rehash({ ...structuredClone(q), device_id: t.A.device_id, ticket: { ...q.ticket, prefix: t.A.prefix } }));
  assertEquals(errBody(rp).code, 'prefix_mismatch');
});

Deno.test('§3.1 row 6: key already applied, same hash → 200 duplicate + the ORIGINAL response (worker: lost response retried, applied once)', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap, { payments: [cash(2068)] });
  const first = okBody(await t.submit(p));
  t.h.clock.advance(10 * 60_000);
  t.publish(await snapshot({ piePriceLarge: 2099 })); // even if the menu moved since
  const again = okBody(await t.submit(p));
  assertEquals(again, { ...first, result: 'duplicate' });
  assertEquals(t.orders.applied.length, 1);
  assertEquals(t.orders.paymentInserts.get(p.payments[0].id), 1);
});

Deno.test('§3.1 row 7: key already applied, different hash → 409 idempotency_key_reuse', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  okBody(await t.submit(p));
  const r = await t.submit(await rehash({ ...structuredClone(p), note: 'different' }));
  assertEquals([err(r).status, errBody(r).code], [409, 'idempotency_key_reuse']);
});

Deno.test('§3.1 row 8: same device, n < c, key never seen → 200 stale_ignored: server_version = c, pricing of c', async () => {
  const t = await setup();
  const p1 = await payload(t.A, t.snap, { status: 'open' });
  const p2 = await next(p1, { lines: [line(IDS.pie, IDS.pieLarge), line(IDS.soda, IDS.sodaReg)] }, t.snap);
  const p3 = await next(p2, { status: 'closed' });
  okBody(await t.submit(p1));
  const r3 = okBody(await t.submit(p3)); // v3 lands first (coalesced)
  const r2 = okBody(await t.submit(p2)); // the late v2
  assertEquals([r2.result, r2.version, r2.server_version, r2.order_number], ['stale_ignored', 2, 3, r3.order_number]);
  assertEquals(r2.pricing, r3.pricing);
  assertEquals(r2.flags, { mismatch: false, stale_price: false, unknown_snapshot: false, availability_flag: false, unknown_actor: false, approval_missing: false, register_actor_after_staff: false });
  assertEquals(t.orders.orders.get(p1.order_id)!.version, 3);
});

Deno.test('§3.1 race: a concurrent submission lands between the pre-check and the apply → the apply re-decides (duplicate, applied once)', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  t.orders.beforeApply = async () => { okBody(await t.submit(p)); };
  const r = okBody(await t.submit(p));
  assertEquals(r.result, 'duplicate');
  assertEquals(t.orders.applied.length, 1);
});

// ---- content hash, redemption, card data, payment shape (reference order) ---------------------------

Deno.test('content_hash: mismatch → 400 invalid_payload; non-canonical JSON (fraction, uppercase key) → 400 invalid_payload; nothing stored', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  const tampered = { ...structuredClone(p), note: 'changed after hashing' };
  assertEquals(err(await t.submit(tampered)), { status: 400, code: 'invalid_payload', message: 'content_hash does not match the canonical payload' });
  assertEquals(errBody(await t.submit({ ...structuredClone(p), tip: { mode: 'amount', percent: null, amount_cents: 1.5 } })).code, 'invalid_payload');
  assertEquals(errBody(await t.submit({ ...structuredClone(p), Reward: true })).code, 'invalid_payload', 'an uppercase key never reaches the redemption scan');
  assertEquals(t.orders.applied.length, 0);
});

Deno.test('redemption / reward keys at every depth → 400 redemption_not_allowed (scenarios case 8 + CP4 reward-in-a-line); provisional_pricing is exempt', async () => {
  const t = await setup();
  const base = await payload(t.A, t.snap, { payments: [cash(2068)] });
  const shapes: [string, (p: Record<string, unknown> & OrderPayload) => void][] = [
    ['top: loyalty_redemption', (p) => { p.loyalty_redemption = { reward_id: 'r1', points: 100 }; }],
    ['top: loyalty_redemption_id', (p) => { p.loyalty_redemption_id = 'red-1'; }],
    ['lines[0].reward', (p) => { (p.lines[0] as unknown as Record<string, unknown>).reward = { kind: 'item' }; }],
    ['modifiers[0].reward_id', (p) => { p.lines[0].modifiers = [mod(IDS.pepperoni)]; (p.lines[0].modifiers[0] as unknown as Record<string, unknown>).reward_id = 'x'; }],
    ['payments[0].redemption_points', (p) => { (p.payments[0] as unknown as Record<string, unknown>).redemption_points = 1; }],
    ['customer.rewards_member', (p) => { (p.customer as Record<string, unknown>).rewards_member = true; }],
    ['deep (depth 9): pricing_config.a.b.c.d.e.f.g.reward', (p) => { p.pricing_config.a = { b: { c: { d: { e: { f: { g: { reward: 1 } } } } } } }; }],
  ];
  for (const [name, f] of shapes) {
    const p = structuredClone(base) as Record<string, unknown> & OrderPayload;
    f(p);
    if (name.startsWith('modifiers')) p.provisional_pricing = priceAgainstSnapshot(p, t.snap).pricing;
    const r = await t.submit(await rehash(p));
    assertEquals([r.status, errBody(r)?.code], [400, 'redemption_not_allowed'], name);
  }
  assertEquals(t.orders.applied.length, 0);
  // loyalty_* breakdown fields are pricing output, not a redemption (they're always in provisional_pricing)
  const allowed = structuredClone(base) as OrderPayload & { provisional_pricing: Record<string, unknown> };
  allowed.provisional_pricing.loyalty_reward_note = 0;
  assertEquals(okBody(await t.submit(await rehash(allowed))).result, 'applied');
});

Deno.test('card data in any free text → 400 card_data_rejected, nothing stored (externalCard: "card number anywhere")', async () => {
  const t = await setup();
  const PAN = '4111 1111 1111 1111';
  const places: [string, (p: OrderPayload) => void][] = [
    ['note', (p) => { p.note = `card ${PAN}`; }],
    ['customer.name', (p) => { p.customer.name = '4111-1111-1111-1111'; }],
    ['lines[0].special_instructions (13 contiguous)', (p) => { p.lines[0].special_instructions = '4111111111111'; }],
    ['payments[0].external_ref', (p) => { p.payments = [card(2068, { external_ref: '4111111111111111' })]; }],
    ['void_reason', (p) => { p.void_reason = `refund to ${PAN}`; }],
    ['an actor field holding a number', (p) => { p.closed_by = PAN; }],
    ['delivery address instructions', (p) => { p.order_type = 'delivery'; p.delivery = deliveryOf('override', 499, { instructions: `gate ${PAN}` }); }],
    ['delivery override reason', (p) => { p.order_type = 'delivery'; p.delivery = deliveryOf('override', 499); p.delivery.overrides.radius!.reason = PAN; }],
  ];
  for (const [name, f] of places) {
    const p = structuredClone(await payload(t.A, t.snap));
    f(p);
    const r = await t.submit(await rehash(p));
    assertEquals([r.status, errBody(r)?.code], [400, 'card_data_rejected'], name);
  }
  assertEquals(t.orders.applied.length, 0);
  // skipped: ids / hashes / timestamps, staff UUIDs and 'register', a phone number, short digit groups
  const fine = await payload(t.A, t.snap, {
    customer: { name: 'Ann', phone_e164: '+12015550100' }, note: 'call 201 555 0100, table 12 13 14 15 16 17 18',
    created_by: uuid(), closed_by: 'register', payments: [card(2068, { last4: '4242', external_ref: 'AUTH 004211' })],
  });
  assertEquals(okBody(await t.submit(fine)).result, 'applied');
});

Deno.test('external_card shape → 400 invalid_payload (externalCard: "payment shape violations"); valid card + cash mixed tender stored as sent', async () => {
  const t = await setup();
  const bad: [string, WirePayment][] = [
    ['tendered ≠ amount', card(2068, { tendered_cents: 2100 })],
    ['change ≠ 0', card(2068, { tendered_cents: 2068, change_cents: 5 })],
    ['last4 3 digits', card(2068, { last4: '123' })],
    ['last4 letters', card(2068, { last4: 'abcd' })],
    ['ref 41 chars', card(2068, { external_ref: 'x'.repeat(41) })],
    ['cash with last4', cash(2068, { last4: '1234' })],
    ['cash with ref', cash(2068, { external_ref: 'AUTH' })],
    ['unknown method', cash(2068, { method: 'card' as never })],
  ];
  for (const [name, pay] of bad) {
    const r = await t.submit(await payload(t.A, t.snap, { payments: [pay] }));
    assertEquals([r.status, errBody(r)?.code], [400, 'invalid_payload'], name);
  }
  assertEquals(t.orders.applied.length, 0);
  // mixed tender: part cash (with change), part card (null last4 / ref allowed)
  const c1 = cash(1000, { tendered_cents: 2000, change_cents: 1000 });
  const c2 = card(1068, { last4: null, external_ref: null });
  const p = await payload(t.A, t.snap, { payments: [c1, c2] });
  okBody(await t.submit(p));
  const stored = t.orders.payments.get(c2.id)!;
  assertEquals([stored.method, stored.last4, stored.external_ref, stored.amount_cents, stored.change_cents], ['external_card', null, null, 1068, 0]);
  assertEquals(t.orders.payments.get(c1.id)!.change_cents, 1000);
});

Deno.test('payments insert-only: refund = captured → voided (inserted once); un-void / amount / method / last4 changes → 400 invalid_payload, nothing written', async () => {
  const t = await setup();
  const pay = card(2068);
  const p1 = await payload(t.A, t.snap, { status: 'open', payments: [pay] });
  okBody(await t.submit(p1));
  const p2 = await next(p1, { payments: [{ ...pay, status: 'voided', voided_by: 'register', void_reason: 'refunded on the terminal' }] });
  okBody(await t.submit(p2));
  const s = t.orders.payments.get(pay.id)!;
  assertEquals([s.status, s.void_reason, t.orders.paymentInserts.get(pay.id)], ['voided', 'refunded on the terminal', 1]);
  for (const [name, change] of [
    ['un-void', { status: 'captured' }],
    ['amount', { amount_cents: 2000, tendered_cents: 2000, status: 'voided' }],
    ['last4', { last4: '9999', status: 'voided' }],
    ['method', { method: 'cash', last4: null, external_ref: null, status: 'voided' }],
  ] as [string, Partial<WirePayment>][]) {
    const r = await t.submit(await next(p2, { payments: [{ ...pay, ...change }] }));
    assertEquals([r.status, errBody(r)?.code], [400, 'invalid_payload'], name);
  }
  assertEquals(t.orders.orders.get(p1.order_id)!.version, 2);
  // a payment id of another order
  const other = await payload(t.A, t.snap, { payments: [pay] });
  assertEquals(errBody(await t.submit(other)).code, 'invalid_payload');
});

// ---- identity (§1a) ---------------------------------------------------------------------------

Deno.test('identity (deviceAuth.test :255): restaurant ≠ → 400; device ≠ → 403; new-order prefix ≠ → 400 prefix_mismatch; existing order keeps its prefix; order of another restaurant → 400; channel not in person → 400 — all before the content hash', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  const bad = (o: Partial<OrderPayload>) => ({ ...structuredClone(p), ...o, content_hash: 'not-checked-yet' });
  assertEquals(err(await t.submit(bad({ restaurant_id: R2 }))).code, 'restaurant_mismatch');
  assertEquals(err(await t.submit(bad({ device_id: t.B.device_id }))), { status: 403, code: 'device_mismatch', message: 'device_id is not this device' });
  assertEquals(err(await t.submit(bad({ ticket: { ...p.ticket, prefix: t.B.prefix } }))).code, 'prefix_mismatch');
  assertEquals(err(await t.submit(bad({ channel: 'online' as never }))).code, 'invalid_payload');
  okBody(await t.submit(p));
  // B writes A's order: must keep A's prefix
  const viaB = await next(p, { device_id: t.B.device_id, base_server_version: 1 });
  assertEquals(errBody(await t.submit(await rehash({ ...structuredClone(viaB), ticket: { ...viaB.ticket, prefix: t.B.prefix } }), t.B)).code, 'prefix_mismatch');
  assertEquals(okBody(await t.submit(viaB, t.B)).result, 'applied');
  // a register of another restaurant names this order id
  const r2dev = ok<Registered>(await t.h.register(t.h.req((await t.h.enroll({ restaurantId: R2 })).code)));
  const foreign = await rehash({ ...structuredClone(p), version: 9, restaurant_id: R2, device_id: r2dev.device_id, ticket: { ...p.ticket, prefix: r2dev.prefix } });
  assertEquals(err(await t.submit(foreign, r2dev)), { status: 400, code: 'restaurant_mismatch', message: 'the order belongs to another restaurant' });
});

Deno.test('middleware: no token → 401 device_unregistered; header device ≠ token → 403; revoked → 401 device_revoked', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  assertEquals(err(await t.submit(p, {})).code, 'device_unregistered');
  assertEquals(err(await t.submit(p, { 'x-ordr-device-token': t.A.device_token, 'x-ordr-device-id': t.B.device_id })).status, 403);
  ok(await t.h.admin({ action: 'revoke', device_id: t.A.device_id, reason: 'test' }));
  assertEquals(err(await t.submit(p)), { status: 401, code: 'device_revoked', message: 'this register was revoked' });
});

Deno.test('writer = principal; in-person pricing from the principal whatever pricing_config / channel claim (deviceAuth.test :274)', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap, {
    channel: 'phone',
    pricing_config: { tax_rate: '0.5', promo_percent: '50', base_service_fee_cents: 150, recoup_rate: '0.03', delivery_minimum_cents: 0 },
  });
  const r = okBody(await t.submit(p));
  assertEquals([r.pricing.service_fee_cents, r.pricing.recoup_cents, r.pricing.total_cents, r.flags.mismatch], [0, 0, 2068, false]);
  assertEquals(t.orders.orders.get(p.order_id)!.payload.pricing_config.base_service_fee_cents, 150, 'stored for reporting');
});

// ---- pricing: pinned / unknown / stale / mismatch / module hash --------------------------------

Deno.test('stale_price: a price change during an outage → stale_price, NOT mismatch; total of record = pinned snapshot (worker)', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap, { payments: [cash(2068)] });
  t.publish(await snapshot({ piePriceLarge: 2099, taxRate: '0.09' }));
  const r = okBody(await t.submit(p));
  assertEquals([r.flags.stale_price, r.flags.mismatch, r.flags.unknown_snapshot, r.pricing.total_cents, r.priced_against_hash], [true, false, false, 2068, t.snap.hash]);
});

Deno.test('unknown snapshot → repriced against the current one + unknown_snapshot (not stale_price); the current one is persisted first (worker: 2285)', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  const cur = await snapshot({ piePriceLarge: 2099 });
  t.publish(cur);
  t.forget(t.snap.hash);
  const r = okBody(await t.submit(p));
  assertEquals([r.flags.unknown_snapshot, r.flags.stale_price, r.flags.mismatch, r.pricing.total_cents, r.priced_against_hash], [true, false, true, 2285, cur.hash]);
  assert(t.orders.snapshots.has(cur.hash));
  // a hash of ANOTHER restaurant's stored snapshot counts as unknown too
  const t2 = await setup();
  const foreign = await snapshot({ restaurantId: R2 });
  t2.orders.putSnapshot(foreign);
  const r2 = okBody(await t2.submit(await payload(t2.A, t2.snap, { menu_snapshot_hash: foreign.hash }, t2.snap)));
  assertEquals([r2.flags.unknown_snapshot, r2.priced_against_hash], [true, t2.snap.hash]);
});

Deno.test('no snapshot to price against: unknown hash + the current one cannot be built → 500 snapshot_config_invalid (retryable); a known pinned one still prices (stale_price false)', async () => {
  const t = await setup();
  t.state.currentError = new SnapshotError('snapshot_config_invalid', 'item_sizes(x).price: bad', 'item_sizes(x).price');
  const known = okBody(await t.submit(await payload(t.A, t.snap)));
  assertEquals([known.result, known.flags.stale_price], ['applied', false]);
  t.forget(t.snap.hash);
  const r = await t.submit(await payload(t.A, t.snap));
  assertEquals([r.status, errBody(r).code, errBody(r).field], [500, 'snapshot_config_invalid', 'item_sizes(x).price']);
});

Deno.test('mismatch: a tampered device price → mismatch + per-field diff of ONLY the differing money fields; server total wins (worker: 2068)', async () => {
  const t = await setup();
  const cheap = await snapshot({ piePriceLarge: 999 });
  const p = await payload(t.A, t.snap, {}, cheap); // provisional priced from a tampered row
  const r = okBody(await t.submit(p));
  assertEquals(r.flags.mismatch, true);
  assertEquals(r.pricing.total_cents, 2068);
  assertEquals(r.diff.subtotal_cents, { provisional: 999, server: 1899, delta: 900 });
  assert('tax_cents' in r.diff && 'total_cents' in r.diff && 'lines[0].unit_cents' in r.diff);
  assert(!('tip_cents' in r.diff) && !('delivery_fee_cents' in r.diff) && !('service_fee_cents' in r.diff), 'equal fields are not listed');
});

Deno.test('module drift vs mismatch: the server returns ITS pricing_module_hash and classifies by diff only; module_drift is the device\'s call (worker :413, sync.ts:128-142)', async () => {
  const t = await setup();
  t.deps.moduleHash = 'f'.repeat(64);
  const p = await payload(t.A, t.snap, {}, await snapshot({ piePriceLarge: 999 }));
  const r = okBody(await t.submit(p));
  assertEquals(r.pricing_module_hash, 'f'.repeat(64));
  assertEquals([r.flags.mismatch, r.pricing.total_cents, 'module_drift' in r.flags], [true, 2068, false]);
  // the device's rule on this response: drift (hash ≠ its build) → keep the diff, don't call it a mismatch
  const deviceMismatch = Object.keys(r.diff).length > 0 && r.pricing_module_hash === PRICING_MODULE_HASH;
  assertEquals(deviceMismatch, false);
});

Deno.test('promo by category: an exempt-category item is not discounted on the server (no mismatch; 190)', async () => {
  const t = await setup({ snap: await snapshot({ promoPercent: '10' }) });
  const p = await payload(t.A, t.snap, { lines: [line(IDS.pie, IDS.pieLarge), line(IDS.soda, IDS.sodaReg, { quantity: 2, discount_exempt: false })] });
  const r = okBody(await t.submit(p));
  assertEquals([r.pricing.promo_discount_cents, r.flags.mismatch], [190, false]);
});

Deno.test('pricing errors → 400 with the reference codes; voided lines are not priced', async () => {
  const t = await setup();
  const cases: [string, Partial<OrderPayload>, string][] = [
    ['quantity 0', { lines: [line(IDS.pie, IDS.pieLarge, { quantity: 0 })] }, 'pricing_error:invalid_quantity'],
    ['tip 150 %', { tip: { mode: 'percent', percent: '150', amount_cents: null } }, 'pricing_error:invalid_tip'],
    ['unknown item', { lines: [line('item-gone', IDS.pieLarge)] }, 'unknown_menu_item'],
    ['size of another item', { lines: [line(IDS.soda, IDS.pieLarge)] }, 'unknown_menu_item'],
    ['no size', { lines: [line(IDS.pie, null)] }, 'unknown_menu_item'],
    ['unknown topping', { lines: [line(IDS.pie, IDS.pieLarge, { modifiers: [mod('top-gone')] })] }, 'unknown_topping'],
    ['pizza topping without placement', { lines: [line(IDS.pie, IDS.pieLarge, { modifiers: [mod(IDS.pepperoni, null)] })] }, 'invalid_payload'],
  ];
  for (const [name, o, code] of cases) {
    const p = structuredClone(await payload(t.A, t.snap, { provisional_pricing: (await payload(t.A, t.snap)).provisional_pricing, ...o }));
    const r = await t.submit(await rehash(p));
    assertEquals([r.status, errBody(r)?.code], [400, code], name);
  }
  const voided = await payload(t.A, t.snap, { lines: [line(IDS.pie, IDS.pieLarge), line('item-gone', null, { status: 'voided', quantity: 0 })] });
  assertEquals(okBody(await t.submit(voided)).result, 'applied');
});

Deno.test('size_prices (CP9b): the snapshot array prices exactly like the module map form; a size named Large 16" uses its per-size price; device arrays are validated', async () => {
  const sp = [{ size_key: 'large 16"', price_cents: 300, half_cents: 160 }, { size_key: 'small', price_cents: 175, half_cents: null }];
  const t = await setup({ snap: await snapshot({ largeName: 'Large 16"', mushroomSizePrices: sp }) });
  const lines = [line(IDS.pie, IDS.pieLarge, { modifiers: [mod(IDS.mushrooms, 'left', { size_prices: sp }), mod(IDS.mushrooms, 'whole'), mod(IDS.ranch, null, { kind: 'addon' })] })];
  const r = okBody(await t.submit(await payload(t.A, t.snap, { lines })));
  assertEquals(r.pricing.lines[0].modifiers.map((m) => m.charge_cents), [160, 300, 75]);
  // the same order through priceOrder with the map form
  const mapForm = sizePricesToMap(sp)!;
  assertEquals(mapForm, { 'large 16"': { price: 300, half: 160 }, small: { price: 175, half: null } } as never);
  const direct = priceOrder(
    {
      orderType: 'pickup', tip: { mode: 'none' }, delivery: null, loyaltyRedemption: null,
      lines: [{ quantity: 1, basePrice: cents(1899), sizeName: 'Large 16"', discountExempt: false, reward: null, modifiers: [
        { kind: 'pizza', placement: 'left', topping: { price: cents(225), priceHalf: cents(125), sizePrices: mapForm } },
        { kind: 'pizza', placement: 'whole', topping: { price: cents(225), priceHalf: cents(125), sizePrices: mapForm } },
        { kind: 'addon', price: cents(75) },
      ] }],
    },
    { taxRate: parseRate('0.08875'), promoPercent: null, baseServiceFee: ZERO, recoupRate: ZERO_RATE, deliveryMinimum: cents(1500), loyalty: { enabled: true, earnBasis: 'subtotal', pointsPerDollar: parseRate('1') } },
  );
  assertEquals(r.pricing.total_cents, direct.total);
  // the request's modifier size_prices must be the sorted, normalized array (stored only, never priced)
  for (const [name, v] of [
    ['map form', { large: { price_cents: 1, half_cents: null } }],
    ['unsorted', [sp[1], sp[0]]],
    ['not normalized', [{ size_key: 'Large', price_cents: 1, half_cents: null }]],
    ['empty array', []],
  ] as [string, unknown][]) {
    const bad = structuredClone(await payload(t.A, t.snap, { lines }));
    (bad.lines[0].modifiers[0] as unknown as Record<string, unknown>).size_prices = v;
    const rr = await t.submit(await rehash(bad));
    assertEquals([rr.status, errBody(rr)?.code, errBody(rr)?.field], [400, 'invalid_payload', 'lines[0].modifiers[0].size_prices'], name);
  }
});

// ---- availability_flag (item 3) ----------------------------------------------------------------

Deno.test('availability_flag: judged at device_time across the window edge (Thu 11:00–15:00 New York); applied + flagged, never 400 (worker)', async () => {
  const t = await setup({ snap: await snapshot({ sidesAvailability: { '4': { start: '11:00', end: '15:00' } } }) });
  const knots = () => [line(IDS.knots, IDS.knotsReg)];
  const at = async (deviceTime: string) => okBody(await t.submit(await payload(t.A, t.snap, { lines: knots(), device_time: deviceTime })));
  assertEquals((await at('2026-11-19T19:59:59Z')).flags.availability_flag, false, '14:59:59 local');
  const late = await at('2026-11-19T20:01:00Z');
  assertEquals([late.result, late.flags.availability_flag, late.flags.mismatch], ['applied', true, false], '15:01 local');
  assertEquals((await at('2026-11-19T15:59:00Z')).flags.availability_flag, true, '10:59 local');
  // received the next day — still judged at device_time
  t.h.clock.advance(24 * 3600_000);
  assertEquals((await at('2026-11-19T17:00:00Z')).flags.availability_flag, false);
  // Mondays only, device time Thursday → flagged
  const mon = await setup({ snap: await snapshot({ sidesAvailability: { '1': { start: '11:00', end: '15:00' } } }) });
  const r = okBody(await mon.submit(await payload(mon.A, mon.snap, { lines: [line(IDS.pie, IDS.pieLarge), line(IDS.knots, IDS.knotsReg)] })));
  assertEquals([r.flags.availability_flag, mon.orders.applied.length], [true, 1]);
});

Deno.test('availability_flag: against the PINNED snapshot, not the current menu at receipt; unavailable item / topping flag; voided lines don\'t', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap, { lines: [line(IDS.knots, IDS.knotsReg)] });
  t.publish(await snapshot({ knotsUnavailable: true })); // 86'd after the sale
  const r = okBody(await t.submit(p));
  assertEquals([r.flags.availability_flag, r.flags.stale_price], [false, true]);
  const off = await setup({ snap: await snapshot({ knotsUnavailable: true, mushroomsUnavailable: true }) });
  assertEquals(okBody(await off.submit(await payload(off.A, off.snap, { lines: [line(IDS.knots, IDS.knotsReg)] }))).flags.availability_flag, true, 'item');
  assertEquals(okBody(await off.submit(await payload(off.A, off.snap, { lines: [line(IDS.pie, IDS.pieLarge, { modifiers: [mod(IDS.mushrooms)] })] }))).flags.availability_flag, true, 'topping');
  assertEquals(okBody(await off.submit(await payload(off.A, off.snap, { lines: [line(IDS.pie, IDS.pieLarge), line(IDS.knots, IDS.knotsReg, { status: 'voided' })] }))).flags.availability_flag, false, 'voided line');
});

// ---- delivery (item 5 later: accept + store; fee per source; flags, never 400) ---------------------

function deliveryOf(source: 'pending' | 'quoted' | 'offline' | 'override', feeCents: number, addr: { instructions?: string } = {}): NonNullable<OrderPayload['delivery']> {
  return {
    address: { street: '1 River St', unit: null, city: 'Hoboken', state: 'NJ', zip: '07030', instructions: addr.instructions ?? null },
    fee_source: source, fee_cents: feeCents, fee_attached_at: source === 'pending' ? null : '2026-11-19T16:59:00Z',
    quote_id: source === 'quoted' ? 'dq_1' : null, quote_expires_at: null, normalized_address: null, lat: null, lng: null,
    distance_miles: source === 'quoted' ? '1.20' : null, tier: source === 'quoted' ? 1 : null, delivery_unverified: false, driver_type: 'in_house',
    overrides: { radius: source === 'override' ? { reason: 'regular customer', actor: 'register', approved_by: null } : null, minimum: null },
    uber: { quote_id: null, customer_fee_cents: null, quote_expires_at: null, delivery_id: null, status: null },
  };
}

Deno.test('delivery: fee from server data per source + review flags; never a 400 for a delivery reason (delivery.test.ts server cases)', async () => {
  const t = await setup();
  const flags = async (d: NonNullable<OrderPayload['delivery']>, o: Partial<OrderPayload> = {}) => {
    const p = await payload(t.A, t.snap, { order_type: 'delivery', delivery: d, ...o });
    const r = okBody(await t.submit(p));
    return { r, f: r.flags.delivery as Record<string, unknown> };
  };
  // override: flat offline fee, delivery_override, nothing else
  const ov = await flags(deliveryOf('override', 499));
  assertEquals([ov.r.pricing.delivery_fee_cents, ov.f.delivery_override, ov.f.delivery_fee_mismatch, ov.r.flags.mismatch], [499, true, false, false]);
  // offline: the snapshot's offline fee
  assertEquals((await flags(deliveryOf('offline', 499))).r.pricing.delivery_fee_cents, 499);
  // closed with a pending fee → priced with 0 + delivery_fee_missing
  const pend = await flags(deliveryOf('pending', 0));
  assertEquals([pend.r.pricing.delivery_fee_cents, pend.f.delivery_fee_missing], [0, true]);
  // below the minimum, closed, no override → applied + delivery_below_minimum (small pie 1399 < 1500)
  const small = await flags(deliveryOf('offline', 499), { lines: [line(IDS.pie, IDS.pieSmall)] });
  assertEquals([small.r.result, small.f.delivery_below_minimum], ['applied', true]);
  const open = await flags(deliveryOf('offline', 499), { lines: [line(IDS.pie, IDS.pieSmall)], status: 'open' });
  assertEquals(open.f.delivery_below_minimum, false, 'the minimum is judged at Close only');
  // device fee ≠ its source → delivery_fee_mismatch + money mismatch; server number wins
  const p = await payload(t.A, t.snap, { order_type: 'delivery', delivery: deliveryOf('offline', 299) });
  const tampered = structuredClone(p.provisional_pricing);
  tampered.delivery_fee_cents = 299;
  tampered.total_cents -= 200;
  const fm = okBody(await t.submit(await rehash({ ...p, provisional_pricing: tampered })));
  assertEquals([(fm.flags.delivery as Record<string, unknown>).delivery_fee_mismatch, fm.flags.mismatch, fm.pricing.delivery_fee_cents], [true, true, 499]);
  // quoted: no quotes table yet → delivery_quote_unknown, priced at the offline fee
  const q = await flags(deliveryOf('quoted', 499));
  assertEquals([q.f.delivery_quote_unknown, q.r.pricing.delivery_fee_cents, q.f.server_fee_cents], [true, 499, null]);
  // malformed payloads still 400 (as the reference)
  const prov = (await payload(t.A, t.snap)).provisional_pricing;
  assertEquals(errBody(await t.submit(await payload(t.A, t.snap, { provisional_pricing: prov, order_type: 'delivery', delivery: { ...deliveryOf('offline', 499), fee_source: 'drone' as never } }))).code, 'invalid_payload');
  assertEquals(errBody(await t.submit(await payload(t.A, t.snap, { provisional_pricing: prov, order_type: 'delivery', delivery: null }))).code, 'invalid_payload');
  // non-delivery orders carry no delivery flags
  assert(!('delivery' in okBody(await t.submit(await payload(t.A, t.snap))).flags));
});

// ---- stored fields (items 2, 6, 8 columns) ---------------------------------------------------------

Deno.test('note / ready_at / void_reason / actors / delivery / table accepted and stored as sent; note > 500 → 400 (orderDetails)', async () => {
  const t = await setup();
  const staff = uuid();
  const p = await payload(t.A, t.snap, {
    status: 'voided', note: 'extra crispy', ready_at: '2026-11-19T23:35:00.000Z', void_reason: 'customer left',
    created_by: staff, voided_by: staff, void_approved_by: uuid(), table: { label: null, guest_count: null },
  });
  okBody(await t.submit(p));
  const s = t.orders.orders.get(p.order_id)!.payload;
  assertEquals([s.note, s.ready_at, s.void_reason, s.created_by, s.voided_by], ['extra crispy', '2026-11-19T23:35:00.000Z', 'customer left', staff, staff]);
  assertEquals(errBody(await t.submit(await payload(t.A, t.snap, { note: 'x'.repeat(501) }))).field, 'note');
  assertEquals(errBody(await t.submit(await payload(t.A, t.snap, { ready_at: 'tomorrow' }))).field, 'ready_at');
  assertEquals(errBody(await t.submit(await payload(t.A, t.snap, { device_time: 'now' }))).field, 'device_time');
  // reserved table-service fields are not required
  const lean = structuredClone(await payload(t.A, t.snap)) as unknown as Record<string, unknown>;
  delete lean.table;
  for (const l of lean.lines as Record<string, unknown>[]) for (const k of ['seat', 'course', 'check_no', 'fired_seq', 'voided_by', 'void_approved_by']) delete l[k];
  assertEquals(okBody(await t.submit(await rehash(lean as unknown as OrderPayload))).result, 'applied');
});

Deno.test('structural guards: order_id must be a UUID; duplicate child ids; absurd nesting → 400 invalid_payload before anything is read', async () => {
  const t = await setup();
  const p = await payload(t.A, t.snap);
  assertEquals(errBody(await t.submit({ ...p, order_id: 'ord-1' })).field, 'order_id');
  const l = line(IDS.pie, IDS.pieLarge);
  assertEquals(errBody(await t.submit(await payload(t.A, t.snap, { lines: [l, { ...l }] }))).message, 'lines[1].id: duplicate id in the request');
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  assertEquals(errBody(await t.submit({ ...p, pricing_config: { deep } })).code, 'invalid_payload');
  assertEquals(t.orders.applied.length, 0);
});
