/**
 * Migration 109 semantics via MemoryOnlineStore (mirrors the plpgsql; 109_smoke.sql runs the same scenarios
 * against Postgres) + PgOnlineStore's RPC names / argument names.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { TestClock } from '../../pos-device/tests/harness.ts';
import {
  MAX_AUTO_PRINT_ATTEMPTS, MemoryOnlineStore, OnlineStoreError, PgOnlineStore, PRINT_LEASE_MS,
} from '../store.ts';
import { DEV_A, DEV_B, DEV_R2, fakeId, R1, R2 } from './fixtures.ts';

function setup() {
  const clock = new TestClock();
  const s = new MemoryOnlineStore(clock.now);
  s.devices.set(DEV_A, { id: DEV_A, restaurant_id: R1, status: 'active' });
  s.devices.set(DEV_B, { id: DEV_B, restaurant_id: R1, status: 'active' });
  s.devices.set(DEV_R2, { id: DEV_R2, restaurant_id: R2, status: 'active' });
  return { clock, s };
}

// ---- print register --------------------------------------------------------------------------------

Deno.test('register: auto-print is off until a register is set, and off again when cleared', async () => {
  const { s } = setup();
  const o = fakeId();
  assertEquals(await s.claimPrint(R1, o, DEV_A), { outcome: 'not_print_register', print_register_device_id: null });
  await s.setPrintRegister(R1, DEV_A, 'admin@example.test');
  assertEquals((await s.claimPrint(R1, o, DEV_A)).outcome, 'claimed');
  await s.setPrintRegister(R1, null, 'admin@example.test');
  assertEquals(await s.claimPrint(R1, fakeId(), DEV_A), { outcome: 'not_print_register', print_register_device_id: null });
});

Deno.test('register: must be an ACTIVE register of the SAME restaurant', async () => {
  const { s } = setup();
  const e1 = await assertRejects(() => s.setPrintRegister(R1, DEV_R2, 'admin'), OnlineStoreError);
  assertEquals(e1.code, 'invalid_print_register');
  s.devices.get(DEV_B)!.status = 'revoked';
  const e2 = await assertRejects(() => s.setPrintRegister(R1, DEV_B, 'admin'), OnlineStoreError);
  assertEquals(e2.code, 'invalid_print_register');
  await assertRejects(() => s.setPrintRegister(R1, DEV_A, ''), OnlineStoreError);
});

Deno.test('claim: only the print register; a revoked or foreign device is not allowed', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  assertEquals(await s.claimPrint(R1, o, DEV_B), { outcome: 'not_print_register', print_register_device_id: DEV_A });
  assertEquals(await s.claimPrint(R1, o, DEV_R2), { outcome: 'device_not_allowed' });
  s.devices.get(DEV_A)!.status = 'revoked';
  assertEquals(await s.claimPrint(R1, o, DEV_A), { outcome: 'device_not_allowed' });
});

// ---- claim / lease ---------------------------------------------------------------------------------

Deno.test('claim: first → attempt 1; the same register again within the lease → same attempt, no new log row', async () => {
  const { clock, s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  const first = await s.claimPrint(R1, o, DEV_A);
  assertEquals(first, { outcome: 'claimed', attempt: 1, lease_expires_at: new Date(clock.t + PRINT_LEASE_MS).toISOString(), takeover: false });
  clock.advance(10_000);
  assertEquals(await s.claimPrint(R1, o, DEV_A), first);
  assertEquals(s.log.length, 1);
});

Deno.test('claim: held while the lease runs; at exactly 60 s the next register takes over (attempt 2)', async () => {
  const { clock, s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  const t0 = clock.t;
  await s.claimPrint(R1, o, DEV_A);
  await s.setPrintRegister(R1, DEV_B, 'admin');
  clock.advance(PRINT_LEASE_MS - 1);
  assertEquals(await s.claimPrint(R1, o, DEV_B), { outcome: 'held', device_id: DEV_A, lease_expires_at: new Date(t0 + PRINT_LEASE_MS).toISOString() });
  clock.advance(1);
  const r = await s.claimPrint(R1, o, DEV_B);
  assertEquals([r.outcome, (r as { attempt: number }).attempt, (r as { takeover: boolean }).takeover], ['claimed', 2, true]);
  assertEquals(s.log.at(-1)!.detail, { takeover: true, previous_device_id: DEV_A, previous_result: 'claimed' });
});

Deno.test('finish: late finish after a takeover → lease_lost (logged, claim unchanged); recorded; duplicate; already_printed', async () => {
  const { clock, s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  await s.claimPrint(R1, o, DEV_A);
  await s.setPrintRegister(R1, DEV_B, 'admin');
  clock.advance(PRINT_LEASE_MS);
  await s.claimPrint(R1, o, DEV_B);

  assertEquals(await s.finishPrint(R1, o, DEV_A, 1, 'printed', { source: 'test' }), { outcome: 'lease_lost', device_id: DEV_B, attempt: 2, result: 'claimed' });
  assertEquals(s.claims.get(o)!.result, 'claimed');
  assertEquals(await s.finishPrint(R1, o, DEV_B, 2, 'printed'), { outcome: 'recorded', result: 'printed', attempt: 2 });
  assertEquals(await s.finishPrint(R1, o, DEV_B, 2, 'printed'), { outcome: 'duplicate', result: 'printed', attempt: 2 });
  assertEquals(await s.claimPrint(R1, o, DEV_B), { outcome: 'already_printed', device_id: DEV_B, attempt: 2 });
  assertEquals(s.log.map((l) => [l.result, l.attempt, l.detail.lease_lost ?? false, l.detail.takeover ?? false]), [
    ['claimed', 1, false, false],
    ['claimed', 2, false, true],
    ['printed', 1, true, false],
    ['printed', 2, false, false],
  ]);
});

Deno.test('finish: the current attempt finishing after its lease ran out (nobody took over) is recorded', async () => {
  const { clock, s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  await s.claimPrint(R1, o, DEV_A);
  clock.advance(5 * PRINT_LEASE_MS);
  assertEquals((await s.finishPrint(R1, o, DEV_A, 1, 'printed')).outcome, 'recorded');
});

Deno.test(`failed ${MAX_AUTO_PRINT_ATTEMPTS} times → attempts_exhausted; a printed result never re-prints`, async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  for (let a = 1; a <= MAX_AUTO_PRINT_ATTEMPTS; a++) {
    const c = await s.claimPrint(R1, o, DEV_A);
    assertEquals([c.outcome, (c as { attempt: number }).attempt, (c as { takeover: boolean }).takeover], ['claimed', a, false]);
    assertEquals((await s.finishPrint(R1, o, DEV_A, a, 'failed', { error: 'Cover open' })).outcome, 'recorded');
  }
  assertEquals(await s.claimPrint(R1, o, DEV_A), { outcome: 'attempts_exhausted', attempt: MAX_AUTO_PRINT_ATTEMPTS });
});

Deno.test('finish: unclaimed order; another restaurant\'s claim; bad result refused', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  await s.setPrintRegister(R2, DEV_R2, 'admin');
  const o = fakeId();
  assertEquals(await s.finishPrint(R1, o, DEV_A, 1, 'printed'), { outcome: 'not_claimed' });
  await s.claimPrint(R1, o, DEV_A);
  assertEquals(await s.finishPrint(R2, o, DEV_R2, 1, 'printed'), { outcome: 'restaurant_mismatch' });
  assertEquals(await s.claimPrint(R2, o, DEV_R2), { outcome: 'restaurant_mismatch' });
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => s.finishPrint(R1, o, DEV_A, 1, 'claimed' as any), OnlineStoreError);
});

// ---- actions -------------------------------------------------------------------------------------------

Deno.test('actions: started → pending → completed → duplicate (stored result); any difference → action_id_reused', async () => {
  const { s } = setup();
  const a = { actionId: fakeId('a'), restaurantId: R1, deviceId: DEV_A, staffId: null, orderId: fakeId(), action: 'ack', request: { order_id: 'x', at: 1 } };
  assertEquals(await s.beginAction(a), { outcome: 'started' });
  assertEquals(await s.beginAction({ ...a, request: { at: 1, order_id: 'x' } }), { outcome: 'pending' }); // key order irrelevant (jsonb =)
  assertEquals(await s.completeAction(a.actionId, DEV_B, { ok: true }, 200), { outcome: 'device_mismatch' });
  assertEquals(await s.completeAction(a.actionId, DEV_A, { ok: true }, 200), { outcome: 'completed' });
  assertEquals(await s.beginAction(a), { outcome: 'duplicate', result: { ok: true }, http_status: 200 });
  for (const diff of [{ request: { order_id: 'x', at: 2 } }, { action: 'accept' }, { staffId: fakeId('5') }, { deviceId: DEV_B }, { orderId: fakeId() }, { restaurantId: R2 }]) {
    assertEquals(await s.beginAction({ ...a, ...diff }), { outcome: 'action_id_reused' }, JSON.stringify(diff));
  }
  assertEquals(await s.completeAction(a.actionId, DEV_A, { ok: false }, 500), { outcome: 'already_completed', result: { ok: true }, http_status: 200 });
  assertEquals(await s.completeAction(fakeId('a'), DEV_A, {}, 200), { outcome: 'not_found' });
});

Deno.test('actions: the action name is checked (109 CHECK ^[a-z][a-z0-9_]{0,39}$)', async () => {
  const { s } = setup();
  const base = { actionId: fakeId('a'), restaurantId: R1, deviceId: DEV_A, staffId: null, orderId: fakeId(), request: {} };
  await assertRejects(() => s.beginAction({ ...base, action: 'Accept' }), OnlineStoreError);
  await assertRejects(() => s.beginAction({ ...base, action: 'a'.repeat(41) }), OnlineStoreError);
  assertEquals(await s.beginAction({ ...base, action: 'cancel_refund' }), { outcome: 'started' });
});

// ---- Pg wrapper: names must match 109 --------------------------------------------------------------

Deno.test('PgOnlineStore: RPC names + argument names match the 109 functions; 23514 → invalid_print_register', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  let next: { data: unknown; error: { code?: string; message: string } | null } = { data: { outcome: 'claimed' }, error: null };
  const pg = new PgOnlineStore({ rpc: (fn: string, args: Record<string, unknown>) => { calls.push([fn, args]); return Promise.resolve(next); } });
  const o = fakeId();
  await pg.claimPrint(R1, o, DEV_A);
  await pg.finishPrint(R1, o, DEV_A, 1, 'printed', { ms: 120 });
  await pg.beginAction({ actionId: 'act', restaurantId: R1, deviceId: DEV_A, staffId: null, orderId: o, action: 'ack', request: {} });
  await pg.completeAction('act', DEV_A, { ok: true }, 200);
  await pg.setPrintRegister(R1, DEV_A, 'admin');
  assertEquals(calls.map(([fn, args]) => [fn, Object.keys(args)]), [
    ['pos_claim_online_print', ['p_restaurant_id', 'p_order_id', 'p_device_id']],
    ['pos_finish_online_print', ['p_restaurant_id', 'p_order_id', 'p_device_id', 'p_attempt', 'p_result', 'p_detail']],
    ['pos_online_action_begin', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_staff_id', 'p_order_id', 'p_action', 'p_request']],
    ['pos_online_action_complete', ['p_action_id', 'p_device_id', 'p_result', 'p_http_status']],
    ['pos_set_print_register', ['p_restaurant_id', 'p_device_id', 'p_updated_by']],
  ]);
  next = { data: null, error: { code: '23514', message: 'print register must be an active register of this restaurant' } };
  const e = await assertRejects(() => pg.setPrintRegister(R1, DEV_R2, 'admin'), OnlineStoreError);
  assertEquals(e.code, 'invalid_print_register');
  next = { data: null, error: { message: 'boom' } };
  await assertRejects(() => pg.claimPrint(R1, o, DEV_A), Error, 'pos_claim_online_print failed');
});
