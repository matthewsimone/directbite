/**
 * Item 8 (server): staff snapshot, staff events, staff flags on submit-order, the pos-staff script logic.
 *
 * Ported from ordr-pos (server-behavior staff cases that exercise FakeServer):
 *   test/db/staff.test.ts:528 "events sync once; actor / approver accepted; a gated action without
 *       approval or an unknown actor is flagged, never refused"
 *   test/db/staff.test.ts:585 "register_actor_after_staff: a 'register' row timed after the first staff
 *       snapshot is flagged (never refused)" — the ORDER parts (created after / voided after / rung entirely
 *       before); its refund / shift / Z parts run through the item 7 helpers (shift/refund/dayClose flags).
 *   test/db/staff.test.ts:199/215 (device install rules the server must make true: version increasing,
 *       hash verifies, restaurant, never a list without an active manager once PINs are on)
 *   test/sync/deviceAuth.test.ts:300 (staff snapshot body restaurant ≠ → 400; staff event identity)
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { contentHash, ORDER_HASH_EXCLUDES } from '../../pos-sync/canonicalJson.ts';
import type { DeviceResult } from '../../pos-sync/http.ts';
import { MemoryOrderStore, type SubmitOrderOk } from '../../pos-sync/orderStore.ts';
import { handleSubmitOrder, type SubmitOrderDeps } from '../../pos-sync/submitOrder.ts';
import { cash, IDS, line, next, payload, snapshot, uuid } from '../../pos-sync/tests/orderFixtures.ts';
import type { OrderPayload } from '../../pos-sync/orderPayload.ts';
import { err, harness, ok, R1, R2, type Registered } from '../../pos-device/tests/harness.ts';
import { runPosStaff, type AdminIO } from '../admin.ts';
import { dayCloseStaffFlags, knownActor, missingApproval, refundStaffFlags, registerAfterStaff, settingsAt, shiftStaffFlags, type StaffContext } from '../flags.ts';
import { handleStaffEvent, handleStaffSnapshot } from '../handlers.ts';
import { DEFAULT_KDF, newSaltHex, pinHashHex } from '../pin.ts';
import { STAFF_SNAPSHOT_HASH_EXCLUDES, type StaffSnapshot } from '../snapshot.ts';
import { MemoryStaffStore } from '../store.ts';

const T0 = Date.parse('2026-11-19T17:00:00Z'); // harness clock start
const iso = (ms: number) => new Date(ms).toISOString();

async function addStaff(store: MemoryStaffStore, name: string, role: 'manager' | 'staff', pin = '2580', rid = R1): Promise<string> {
  const salt = newSaltHex();
  const r = await store.add(rid, name, role, salt, pinHashHex(pin, salt, DEFAULT_KDF), DEFAULT_KDF);
  assert(r.ok);
  return r.staff_id;
}

async function setup() {
  const h = harness();
  const A = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const staff = new MemoryStaffStore();
  staff.restaurants.set('test', { id: R1, name: 'Test Pizza' });
  staff.restaurants.set('other', { id: R2, name: 'Other' });
  const deps = { ...h.deps, staff };
  const call = (fn: typeof handleStaffSnapshot, body: unknown, hdr: Record<string, string> = h.asDevice(A)) =>
    fn({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', ...hdr }), bodyText: JSON.stringify(body), ip: null }, deps);
  const snap = (body: unknown = { restaurant_id: R1, if_none_match: null }, hdr?: Record<string, string>) => call(handleStaffSnapshot, body, hdr);
  const event = (body: unknown, hdr?: Record<string, string>) => call(handleStaffEvent, body, hdr);
  return { h, A, staff, deps, snap, event };
}

async function staffEvent(dev: Registered, o: Record<string, unknown> = {}) {
  const p: Record<string, unknown> = {
    event_id: uuid(), version: 1, content_hash: '', restaurant_id: dev.restaurant_id, device_id: dev.device_id,
    type: 'sign_in', staff_id: null, by_staff_id: null, purpose: null, target_id: null,
    created_at: '2026-11-19T17:00:00.000Z', device_time: '2026-11-19T17:00:00.000Z', ...o,
  };
  p.content_hash = await contentHash(p, ORDER_HASH_EXCLUDES);
  return p;
}

const body = <T>(r: DeviceResult) => ok<T>(r);
const code = (r: DeviceResult) => (r.body as { error?: { code: string } }).error?.code;

// ---- pos-v1-staff-snapshot ---------------------------------------------------------------------------

Deno.test('staff snapshot: 404 no_staff until staff exist; then the §3b body — hex salt / hash, canonical hash, published BEFORE it is served; if_none_match → not_modified', async () => {
  const t = await setup();
  assertEquals([(await t.snap()).status, code(await t.snap())], [404, 'no_staff']);
  const maria = await addStaff(t.staff, 'Maria', 'manager', '1357');
  const s = body<StaffSnapshot>(await t.snap());
  assertEquals(Object.keys(s).sort(), ['hash', 'restaurant_id', 'server_time', 'settings', 'staff', 'version']);
  assertEquals([s.restaurant_id, s.version, s.server_time], [R1, 1, iso(T0)]);
  assertEquals(s.settings, { auto_lock_minutes: 5, over_short_approval_cents: 500, z_requires_manager: true, pin_kdf: { alg: 'scrypt', n: 8192, r: 7, p: 1, dk_len: 32 } });
  assertEquals(s.staff.length, 1);
  const m = s.staff[0];
  assertEquals([m.id, m.name, m.role, m.active, m.sort_order], [maria, 'Maria', 'manager', true, 1]);
  assert(/^[0-9a-f]{32}$/.test(m.pin.salt) && /^[0-9a-f]{64}$/.test(m.pin.hash));
  // the device's check: scrypt(PIN, salt, settings.pin_kdf) = the snapshot hash
  assertEquals(pinHashHex('1357', m.pin.salt, s.settings.pin_kdf), m.pin.hash);
  assertEquals(s.hash, await contentHash(s as unknown as Record<string, unknown>, STAFF_SNAPSHOT_HASH_EXCLUDES));
  assertEquals(t.staff.published.get(R1)!.map((p) => [p.version, p.hash, p.published_at]), [[1, s.hash, T0]]);
  // again: served from the published row (same hash, nothing new published), not_modified on its hash
  t.h.clock.advance(60_000);
  assertEquals(body<StaffSnapshot>(await t.snap()).hash, s.hash);
  assertEquals(t.staff.published.get(R1)!.length, 1);
  assertEquals(body(await t.snap({ restaurant_id: R1, if_none_match: s.hash })), { not_modified: true, hash: s.hash });
  assertEquals(body<StaffSnapshot>(await t.snap({ restaurant_id: R1, if_none_match: 'old' })).hash, s.hash);
});

Deno.test('staff snapshot: version strictly increases with EVERY change (add, set-pin, deactivate, settings); each gets a new hash; inactive staff stay in the list', async () => {
  const t = await setup();
  const maria = await addStaff(t.staff, 'Maria', 'manager');
  const seen: [number, string][] = [];
  const pull = async () => {
    const s = body<StaffSnapshot>(await t.snap());
    seen.push([s.version, s.hash]);
    return s;
  };
  await pull();
  const sam = await addStaff(t.staff, 'Sam', 'staff');
  await pull();
  const salt = newSaltHex();
  assert((await t.staff.setPin(sam, salt, pinHashHex('9012', salt, DEFAULT_KDF), DEFAULT_KDF)).ok);
  await pull();
  assert((await t.staff.deactivate(sam)).ok);
  const s4 = await pull();
  assert((await t.staff.setSettings(R1, { over_short_approval_cents: 1000 })).ok);
  const s5 = await pull();
  assertEquals(seen.map((x) => x[0]), [1, 2, 3, 4, 5]);
  assertEquals(new Set(seen.map((x) => x[1])).size, 5);
  assertEquals(s4.staff.map((x) => [x.name, x.active, x.sort_order]), [['Maria', true, 1], ['Sam', false, 2]]);
  assertEquals(s5.settings.over_short_approval_cents, 1000);
  assertEquals(t.staff.published.get(R1)!.map((p) => p.version), [1, 2, 3, 4, 5]);
  void maria;
});

Deno.test('staff snapshot: identity + auth codes (deviceAuth.test :300); a PIN hashed with other kdf params → 500 staff_config_invalid (never a list the device can\'t verify)', async () => {
  const t = await setup();
  const maria = await addStaff(t.staff, 'Maria', 'manager');
  assertEquals(err(await t.snap({ restaurant_id: R2, if_none_match: null })).code, 'restaurant_mismatch');
  assertEquals(code(await t.snap({ restaurant_id: R1, if_none_match: 7 })), 'invalid_payload');
  assertEquals(err(await t.snap(undefined, {})).code, 'device_unregistered');
  assertEquals(err(await t.snap(undefined, { 'x-ordr-device-token': t.A.device_token, 'x-ordr-device-id': uuid() })).status, 403);
  // tampered row (e.g. hand-edited SQL): kdf ≠ pin_kdf
  t.staff.staff.get(maria)!.kdf = { ...DEFAULT_KDF, n: 1024 };
  t.staff.settingsRows.get(R1)!.version += 1;
  const r = await t.snap();
  assertEquals([r.status, code(r)], [500, 'staff_config_invalid']);
  ok(await t.h.admin({ action: 'revoke', device_id: t.A.device_id, reason: 'test' }));
  assertEquals(err(await t.snap()).code, 'device_revoked');
});

// ---- pos-v1-submit-staff-events -----------------------------------------------------------------

Deno.test('staff events: applied once (same hash → duplicate + ORIGINAL response; other hash → 409 idempotency_key_reuse); drawer_kick fields stored', async () => {
  const t = await setup();
  const maria = await addStaff(t.staff, 'Maria', 'manager');
  body(await t.snap());
  const e = await staffEvent(t.A, { type: 'drawer_kick', staff_id: maria, purpose: 'no_sale', target_id: null });
  const r1 = body<Record<string, unknown>>(await t.event(e));
  assertEquals(r1, { result: 'applied', id: e.event_id, version: 1, server_version: 1, flags: { unknown_actor: false }, server_time: iso(T0) });
  t.h.clock.advance(5_000);
  assertEquals(body(await t.event(e)), { ...r1, result: 'duplicate' });
  const changed = await staffEvent(t.A, { ...e, purpose: 'test', content_hash: '' });
  assertEquals([(await t.event(changed)).status, code(await t.event(changed))], [409, 'idempotency_key_reuse']);
  const row = t.staff.events.get(e.event_id as string)!;
  assertEquals([row.payload.type, row.payload.purpose, row.payload.staff_id, row.device_id], ['drawer_kick', 'no_sale', maria, t.A.device_id]);
  assertEquals(t.staff.events.size, 1);
});

Deno.test('staff events: unknown_actor — staff ids of the restaurant (deactivated included), \'register\' and null are known; strangers and another restaurant\'s staff are not', async () => {
  const t = await setup();
  const maria = await addStaff(t.staff, 'Maria', 'manager');
  const sam = await addStaff(t.staff, 'Sam', 'staff');
  assert((await t.staff.deactivate(sam)).ok);
  const elsewhere = await addStaff(t.staff, 'Eve', 'manager', '2580', R2);
  const flag = async (staff_id: string | null, by_staff_id: string | null = null) =>
    (body<{ flags: { unknown_actor: boolean } }>(await t.event(await staffEvent(t.A, { type: 'approval_granted', staff_id, by_staff_id, purpose: 'void_line', target_id: uuid() })))).flags.unknown_actor;
  assertEquals(await flag(maria, sam), false, 'deactivated staff still resolve');
  assertEquals(await flag('register'), false);
  assertEquals(await flag(null), false);
  assertEquals(await flag(uuid()), true, 'stranger');
  assertEquals(await flag(maria, elsewhere), true, "another restaurant's staff");
});

Deno.test('staff events: content hash / card guard (with the _id / actor skip rules) / shape / identity → 400 / 403, nothing stored', async () => {
  const t = await setup();
  const PAN = '4111 1111 1111 1111';
  const tampered = { ...(await staffEvent(t.A)), type: 'lock' };
  assertEquals(code(await t.event(tampered)), 'invalid_payload');
  assertEquals(code(await t.event(await staffEvent(t.A, { purpose: PAN }))), 'card_data_rejected');
  // the reference's skip rules: *_id keys are machine data (staff_id / by_staff_id / target_id)
  assertEquals((await t.event(await staffEvent(t.A, { target_id: '4111111111111111' }))).status, 200);
  assertEquals(code(await t.event(await staffEvent(t.A, { version: 2 }))), 'invalid_payload');
  assertEquals(code(await t.event(await staffEvent(t.A, { type: 'clock_in' }))), 'invalid_payload');
  assertEquals(code(await t.event(await staffEvent(t.A, { created_at: 'yesterday' }))), 'invalid_payload');
  assertEquals(code(await t.event({ event_id: 'e-1' })), 'invalid_payload');
  assertEquals(err(await t.event(await staffEvent(t.A, { restaurant_id: R2 }))).code, 'restaurant_mismatch');
  assertEquals(err(await t.event(await staffEvent({ ...t.A, device_id: uuid() }))).status, 403);
  // an event id another restaurant already used
  const other = await staffEvent(t.A);
  t.staff.events.set(other.event_id as string, { event_id: other.event_id as string, restaurant_id: R2, device_id: uuid(), payload: other, content_hash: other.content_hash as string, flags: {}, response: {}, received_at: iso(T0) });
  assertEquals(err(await t.event(other)).code, 'restaurant_mismatch');
  assertEquals(t.staff.events.size, 2, 'only the _id-skip event and the seeded one');
});

// ---- flag rules (shared module) ------------------------------------------------------------------

function ctxOf(roles: [string, 'manager' | 'staff'][], history: [number, Partial<StaffContext['settingsHistory'][number]['settings']>][] = [[T0, {}]]): StaffContext {
  const base = { auto_lock_minutes: 5, over_short_approval_cents: 500, z_requires_manager: true, pin_kdf: DEFAULT_KDF };
  return {
    firstPublishedAt: history.length ? history[0][0] : null,
    roles: new Map(roles),
    settingsHistory: history.map(([publishedAt, s]) => ({ publishedAt, settings: { ...base, ...s } })),
  };
}

Deno.test('flag rules: knownActor / missingApproval (manager acts alone; staff need a manager approver; register never) / register boundary is strictly after the first publication', () => {
  const ctx = ctxOf([['m', 'manager'], ['s', 'staff'], ['s2', 'staff']]);
  assertEquals([knownActor(ctx, 'm'), knownActor(ctx, 'register'), knownActor(ctx, null), knownActor(ctx, 'x')], [true, true, true, false]);
  assertEquals(missingApproval(ctx, 'm', null), false, 'a manager approves themselves');
  assertEquals(missingApproval(ctx, 's', null), true);
  assertEquals(missingApproval(ctx, 's', 's2'), true, 'approved by a non-manager');
  assertEquals(missingApproval(ctx, 's', 'm'), false);
  assertEquals(missingApproval(ctx, 'register', null), false);
  assertEquals(missingApproval(ctxOf([['s', 'staff']], []), 's', null), false, 'no staff snapshot ever published → no approvals');
  assertEquals(registerAfterStaff(ctx, 'register', iso(T0)), false, 'at the publication instant: not after');
  assertEquals(registerAfterStaff(ctx, 'register', iso(T0 + 1)), true);
  assertEquals(registerAfterStaff(ctx, 'register', iso(T0 - 1)), false);
  assertEquals(registerAfterStaff(ctx, 's', iso(T0 + 1)), false);
  assertEquals(registerAfterStaff(ctxOf([], []), 'register', iso(T0 + 1)), false);
});

Deno.test('flag rules: settings IN EFFECT AT THE ROW\'S TIME — Z / over-short judged with the snapshot published at or before the row (item 7 helpers; refund / shift / Z parts of staff.test :585)', () => {
  const T1 = T0 + 3_600_000;
  const ctx = ctxOf([['m', 'manager'], ['s', 'staff']], [[T0, { z_requires_manager: true, over_short_approval_cents: 500 }], [T1, { z_requires_manager: false, over_short_approval_cents: 2000 }]]);
  assertEquals(settingsAt(ctx, iso(T0 + 1))!.z_requires_manager, true);
  assertEquals(settingsAt(ctx, iso(T1))!.z_requires_manager, false, 'published at T1 applies from T1');
  assertEquals(settingsAt(ctx, iso(T0 - 5))!.z_requires_manager, true, 'before the first: the first');
  // a staff Z without approval: needed before T1, not after
  assertEquals(dayCloseStaffFlags(ctx, { closed_by: 's', approved_by: null, closed_at: iso(T0 + 60_000) }).approval_missing, true);
  assertEquals(dayCloseStaffFlags(ctx, { closed_by: 's', approved_by: null, closed_at: iso(T1 + 60_000) }).approval_missing, false);
  // shift closed $10 over: beyond 500 at T0, within 2000 at T1
  const shift = (closedAt: number) => ({ status: 'closed', opened_by: 's', opened_at: iso(T0), closed_by: 's', closed_at: iso(closedAt), close_approved_by: null, over_short_cents: 1000, movements: [] });
  assertEquals(shiftStaffFlags(ctx, shift(T0 + 60_000)).approval_missing, true);
  assertEquals(shiftStaffFlags(ctx, shift(T1 + 60_000)).approval_missing, false);
  // paid-out needs a manager always; register rows after staff flagged on shift / refund / Z
  const paidOut = { ...shift(T0 + 60_000), over_short_cents: 0, movements: [{ kind: 'paid_out', actor: 's', approved_by: null, created_at: iso(T0 + 1) }] };
  assertEquals(shiftStaffFlags(ctx, paidOut).approval_missing, true);
  assertEquals(shiftStaffFlags(ctx, { ...shift(T0 + 5), opened_by: 'register', closed_by: 'register' }).register_actor_after_staff, true);
  assertEquals(refundStaffFlags(ctx, { actor: 'register', approved_by: null, created_at: iso(T0 + 5) }), { unknown_actor: false, approval_missing: false, register_actor_after_staff: true });
  assertEquals(refundStaffFlags(ctx, { actor: 's', approved_by: null, created_at: iso(T0 + 5) }).approval_missing, true);
  assertEquals(dayCloseStaffFlags(ctx, { closed_by: 'register', approved_by: null, closed_at: iso(T0 + 5) }).register_actor_after_staff, true);
});

// ---- staff flags on pos-v1-submit-order -----------------------------------------------------------

async function orderSetup() {
  const t = await setup();
  const orders = new MemoryOrderStore();
  const menu = await snapshot();
  orders.putSnapshot(menu);
  const deps: SubmitOrderDeps = { ...t.h.deps, orders, current: { get: () => Promise.resolve(menu) }, staff: t.staff };
  const submit = async (p: OrderPayload) =>
    body<SubmitOrderOk>(await handleSubmitOrder({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', ...t.h.asDevice(t.A) }), bodyText: JSON.stringify(p), ip: null }, deps));
  return { ...t, orders, menu, submit };
}

Deno.test('submit-order (staff.test :528): staff actors + a manager-approved void → no flags; approver stripped → approval_missing; a stranger → unknown_actor — both still applied', async () => {
  const t = await orderSetup();
  const maria = await addStaff(t.staff, 'Maria', 'manager');
  const sam = await addStaff(t.staff, 'Sam', 'staff');
  body(await t.snap());
  const l1 = line(IDS.pie, IDS.pieLarge, { status: 'voided', void_reason: 'x', voided_by: sam, void_approved_by: maria });
  const p = await payload(t.A, t.menu, { created_by: sam, closed_by: sam, lines: [l1, line(IDS.soda, IDS.sodaReg)], payments: [cash(380, { taken_by: sam })] });
  const r1 = await t.submit(p);
  assertEquals([r1.flags.unknown_actor, r1.flags.approval_missing, r1.flags.register_actor_after_staff], [false, false, false]);
  const tampered = structuredClone(p);
  tampered.lines[0].void_approved_by = null;
  tampered.created_by = 'stranger';
  const r2 = await t.submit(await next(tampered));
  assertEquals([r2.result, r2.flags.approval_missing, r2.flags.unknown_actor], ['applied', true, true]);
  assertEquals(t.orders.orders.get(p.order_id)!.flags.approval_missing, true, 'stored');
  // a payment void by staff without a manager; a delivery-less order voided by a manager alone
  const pay = cash(380, { taken_by: sam });
  const pv = await payload(t.A, t.menu, { status: 'open', payments: [{ ...pay, status: 'voided', voided_by: sam }] });
  assertEquals((await t.submit(pv)).flags.approval_missing, true);
  const ov = await payload(t.A, t.menu, { status: 'voided', void_reason: 'mistake', voided_by: maria, void_approved_by: null });
  assertEquals((await t.submit(ov)).flags.approval_missing, false);
  // a deactivated manager's earlier approval still resolves (known; role manager)
  assert((await t.staff.add(R1, 'Lee', 'manager', newSaltHex(), 'ab'.repeat(32), DEFAULT_KDF)).ok);
  assert((await t.staff.deactivate(maria)).ok);
  const later = await payload(t.A, t.menu, { lines: [{ ...l1, id: uuid() }], created_by: sam });
  assertEquals([(await t.submit(later)).flags.unknown_actor, (await t.submit(later)).flags.approval_missing], [false, false]);
});

Deno.test("submit-order (staff.test :585): 'register' after the first staff snapshot → register_actor_after_staff (never refused); rung entirely before → not; newly-register paths only; sticky; boundary strictly after", async () => {
  const t = await orderSetup();
  // rung in register mode BEFORE any staff snapshot, synced
  const before = await payload(t.A, t.menu, { status: 'open', device_time: iso(T0 - 60_000) });
  assertEquals((await t.submit(before)).flags.register_actor_after_staff, false);
  const quiet = await payload(t.A, t.menu, { device_time: iso(T0 - 30_000) });
  assertEquals((await t.submit(quiet)).flags.register_actor_after_staff, false);
  // staff published at T0
  await addStaff(t.staff, 'Maria', 'manager');
  body(await t.snap());
  // replay of the pre-staff order: duplicate → its original (unflagged) response
  const dup = await t.submit(quiet);
  assertEquals([dup.result, dup.flags.register_actor_after_staff], ['duplicate', false]);
  // the pre-staff order gets voided by 'register' after staff → flagged (voided_by is newly 'register')
  const voided = await next(before, { version: 3, status: 'voided', void_reason: 'mistake', voided_by: 'register', device_time: iso(T0 + 60_000) });
  const rv = await t.submit(voided);
  assertEquals([rv.result, rv.flags.register_actor_after_staff], ['applied', true]);
  // an unchanged 'register' created_by in a later version is not "new" — but the flag is sticky
  const again = await next(voided, { note: 'n', device_time: iso(T0 + 120_000) });
  assertEquals((await t.submit(again)).flags.register_actor_after_staff, true, 'sticky');
  // an order created after staff
  assertEquals((await t.submit(await payload(t.A, t.menu, { device_time: iso(T0 + 1) }))).flags.register_actor_after_staff, true);
  // exactly at the publication instant: not after
  assertEquals((await t.submit(await payload(t.A, t.menu, { device_time: iso(T0) }))).flags.register_actor_after_staff, false);
  // stale_ignored echoes the stored staff flags (v2 was never sent; v4 is stored)
  const stale = await t.submit(await next(before, { note: 'late v2', device_time: iso(T0 + 30_000) }));
  assertEquals([stale.result, stale.flags.register_actor_after_staff], ['stale_ignored', true]);
});

// ---- the pos-staff script (no DB, no terminal) ------------------------------------------------------

function io(pins: string[], confirms: boolean[] = []) {
  const out: string[] = [];
  const asked: string[] = [];
  const x: AdminIO = {
    out: (l) => out.push(l),
    promptPin: (label) => (asked.push(label), Promise.resolve(pins.shift() ?? '')),
    confirm: (q) => (asked.push(q), Promise.resolve(confirms.shift() ?? false)),
  };
  return { out, asked, io: x };
}

Deno.test('pos-staff add / list / set-pin: PIN typed twice, hashed with pin_kdf, published; output never carries the PIN, a salt or a hash', async () => {
  const t = await setup();
  const run = (argv: string[], x: ReturnType<typeof io>) => runPosStaff(argv, { store: t.staff, io: x.io, now: t.h.clock.now });
  const a = io(['1357', '1357']);
  assertEquals(await run(['add', 'test', 'Maria', 'manager'], a), 0);
  const id = [...t.staff.staff.keys()][0];
  const row = structuredClone(t.staff.staff.get(id)!);
  assertEquals(pinHashHex('1357', row.salt, DEFAULT_KDF), row.hash);
  assertEquals(t.staff.published.get(R1)!.map((p) => p.version), [1]);
  const l = io([]);
  assertEquals(await run(['list', 'test'], l), 0);
  assertEquals(l.out, ['Test Pizza: 1 staff', `  1. Maria — manager — ${id}`]);
  const s = io(['9012', '9012']);
  assertEquals(await run(['set-pin', id], s), 0);
  assertNotEquals(t.staff.staff.get(id)!.salt, row.salt, 'a new salt per set');
  assertEquals(pinHashHex('9012', t.staff.staff.get(id)!.salt, DEFAULT_KDF), t.staff.staff.get(id)!.hash);
  const all = [...a.out, ...l.out, ...s.out].join('\n');
  for (const secret of ['1357', '9012', row.salt, row.hash, t.staff.staff.get(id)!.salt, t.staff.staff.get(id)!.hash]) assert(!all.includes(secret), 'leaked');
  // a first staff without a manager: allowed, with a warning (registers stay in register mode)
  const o = io(['2468', '2468']);
  assertEquals(await run(['add', 'other', 'Sam', 'staff'], o), 0);
  assert(o.out.some((x) => x.includes('NO active manager yet')));
});

Deno.test('pos-staff PIN validation: not 4–6 digits / mismatch → nothing written; weak PIN warns + asks, never refuses', async () => {
  const t = await setup();
  const run = (argv: string[], x: ReturnType<typeof io>) => runPosStaff(argv, { store: t.staff, io: x.io, now: t.h.clock.now });
  for (const bad of ['123', '1234567', '12a4', '']) assertEquals(await run(['add', 'test', 'Maria', 'manager'], io([bad, bad])), 1, bad);
  assertEquals(await run(['add', 'test', 'Maria', 'manager'], io(['1357', '1358'])), 1, 'mismatch');
  const weakNo = io(['1234', '1234'], [false]);
  assertEquals(await run(['add', 'test', 'Maria', 'manager'], weakNo), 1);
  assert(weakNo.asked.some((q) => q.includes('weak PIN (sequential digits (ascending))')));
  assertEquals(t.staff.staff.size, 0, 'nothing written so far');
  assertEquals(await run(['add', 'test', 'Maria', 'manager'], io(['0000', '0000'], [true])), 0, 'confirmed weak PIN is accepted');
  assertEquals(t.staff.staff.size, 1);
});

Deno.test('pos-staff deactivate: the last active manager is refused once PINs are on; with a second manager it works; usage errors exit 2', async () => {
  const t = await setup();
  const run = (argv: string[], x = io([])) => runPosStaff(argv, { store: t.staff, io: x.io, now: t.h.clock.now });
  const maria = await addStaff(t.staff, 'Maria', 'manager');
  const sam = await addStaff(t.staff, 'Sam', 'staff');
  const x = io([]);
  assertEquals(await run(['deactivate', maria], x), 1);
  assert(x.out[0].includes('without an active manager'));
  assertEquals(t.staff.staff.get(maria)!.active, true);
  assertEquals(await run(['deactivate', sam]), 0);
  await addStaff(t.staff, 'Lee', 'manager');
  assertEquals(await run(['deactivate', maria]), 0);
  // before PINs are on (no manager ever), a lone staff can be deactivated
  const lone = await addStaff(t.staff, 'Ann', 'staff', '2580', R2);
  assertEquals(await run(['deactivate', lone]), 0);
  for (const argv of [[], ['nope'], ['add', 'test', 'Dan', 'driver'], ['add', 'test', 'Dan'], ['settings', 'test', '--auto-lock', '-1'], ['settings', 'test', '--z-requires-manager', 'yes'], ['settings', 'test', '--colour', 'red']]) {
    assertEquals(await run(argv), 2, JSON.stringify(argv));
  }
  assertEquals(await run(['add', 'nowhere', 'Dan', 'staff'], io(['2580', '2580'])), 1);
});

Deno.test('pos-staff settings: show; update bumps the version and publishes; a Z requirement change applies to rows after its publication', async () => {
  const t = await setup();
  const run = (argv: string[], x = io([])) => runPosStaff(argv, { store: t.staff, io: x.io, now: t.h.clock.now });
  await addStaff(t.staff, 'Maria', 'manager');
  const show = io([]);
  assertEquals(await run(['settings', 'test'], show), 0);
  assertEquals(show.out, ['Test Pizza: auto_lock_minutes 5, over_short_approval_cents 500, z_requires_manager true, pin_kdf scrypt n 8192 r 7 p 1 dk_len 32']);
  body(await t.snap()); // v1 published at T0
  t.h.clock.advance(3_600_000);
  assertEquals(await run(['settings', 'test', '--auto-lock', '0', '--over-short-cents', '1000', '--z-requires-manager', 'false']), 0);
  const s = await t.staff.settings(R1);
  assertEquals([s.auto_lock_minutes, s.over_short_approval_cents, s.z_requires_manager], [0, 1000, false]);
  assertEquals(t.staff.published.get(R1)!.map((p) => [p.version, p.published_at]), [[1, T0], [2, T0 + 3_600_000]]);
  const ctx = await t.staff.context(R1);
  assertEquals(settingsAt(ctx, iso(T0 + 60_000))!.z_requires_manager, true);
  assertEquals(settingsAt(ctx, iso(T0 + 3_700_000))!.z_requires_manager, false);
});
