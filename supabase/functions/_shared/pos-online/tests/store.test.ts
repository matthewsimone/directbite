/**
 * Migrations 109 + 110 semantics via MemoryOnlineStore (mirrors the plpgsql; 110_smoke.sql runs the same
 * scenarios against Postgres), checked against the PORTED reference rules (printRules.ts = ordr-pos @ 7798d52
 * src/dev/onlinePrintRules.ts) by a randomized differential test, + PgOnlineStore's RPC / argument names.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { TestClock } from '../../pos-device/tests/harness.ts';
import { applyClaim, applyPrintResult, orderPrintResult, type OnlinePrintWire, type OnlineStationRef, type PrintResult, type PrintVariant } from '../printRules.ts';
import { MemoryOnlineStore, OnlineStoreError, PgOnlineStore, type ActionBegin, type RecordInput } from '../store.ts';
import { DEV_A, DEV_B, DEV_R2, fakeId, R1, R2 } from './fixtures.ts';

const COUNTER: OnlineStationRef = { station: 'p-counter', name: 'Counter', lines: [0, 1] };
const OVEN: OnlineStationRef = { station: 'p-oven', name: 'Pizza oven', lines: [0] };
const BAR: OnlineStationRef = { station: 'p-bar', name: 'Bar', lines: [1] };

function setup(o: { flags?: boolean } = {}) {
  const clock = new TestClock();
  const s = new MemoryOnlineStore(clock.now);
  s.devices.set(DEV_A, { id: DEV_A, restaurant_id: R1, status: 'active' });
  s.devices.set(DEV_B, { id: DEV_B, restaurant_id: R1, status: 'active' });
  s.devices.set(DEV_R2, { id: DEV_R2, restaurant_id: R2, status: 'active' });
  if (o.flags !== false) {
    s.setFlags(R1, { online_auto_print_enabled: true, kitchenhub_auto_print_enabled: true });
  }
  return { clock, s };
}
const claim = (s: MemoryOnlineStore, orderId: string, deviceId = DEV_A, o: { stations?: OnlineStationRef[]; printed?: boolean; channel?: 'ordr' | 'kitchenhub'; restaurantId?: string } = {}) =>
  s.claimPrint({ restaurantId: o.restaurantId ?? R1, channel: o.channel ?? 'ordr', orderId, deviceId, stations: o.stations ?? [COUNTER, OVEN], printStatusPrinted: o.printed ?? false });
const rec = (s: MemoryOnlineStore, orderId: string, deviceId: string, variant: PrintVariant, result: PrintResult, station: OnlineStationRef, o: Partial<RecordInput> = {}) =>
  s.recordPrint({ restaurantId: R1, channel: 'ordr', orderId, deviceId, actionId: fakeId('a'), variant, result, station, error: null, deviceTime: null, ...o });

// ---- print register + flags ------------------------------------------------------------------------

Deno.test('claim: not_designated until a register is set (and again when cleared); auto_print_off per channel', async () => {
  const { s } = setup({ flags: false });
  const o = fakeId();
  assertEquals(await claim(s, o), { outcome: 'not_designated' });
  await s.setPrintRegister(R1, DEV_A, 'admin@example.test');
  assertEquals(await claim(s, o), { outcome: 'auto_print_off' }); // both flags default false (handoff DDL)
  s.setFlags(R1, { online_auto_print_enabled: true });
  assertEquals(await claim(s, fakeId(), DEV_A, { channel: 'kitchenhub' }), { outcome: 'auto_print_off' });
  assertEquals(await claim(s, o), { outcome: 'ok', applied: true, claimed: true });
  s.setFlags(R1, { kitchenhub_auto_print_enabled: true });
  assertEquals((await claim(s, fakeId(), DEV_A, { channel: 'kitchenhub' })).outcome, 'ok');
  await s.setPrintRegister(R1, null, 'admin@example.test');
  assertEquals(await claim(s, fakeId()), { outcome: 'not_designated' });
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

Deno.test('claim: only the print register; a revoked / foreign device is not allowed', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  assertEquals(await claim(s, fakeId(), DEV_B), { outcome: 'not_designated' });
  assertEquals(await claim(s, fakeId(), DEV_R2), { outcome: 'device_not_allowed' });
  s.devices.get(DEV_A)!.status = 'revoked';
  assertEquals(await claim(s, fakeId(), DEV_A), { outcome: 'device_not_allowed' });
});

// ---- claim -----------------------------------------------------------------------------------------

Deno.test('claim: first records one station row each (counter first, result null); again → noop, still claimed', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  assertEquals(await claim(s, o), { outcome: 'ok', applied: true, claimed: true });
  assertEquals(await claim(s, o), { outcome: 'ok', applied: false, claimed: true });
  const st = await s.printState(R1, [o]);
  assertEquals(st.stations.map((x) => [x.station, x.position, x.result, x.lines]), [['p-counter', 0, null, [0, 1]], ['p-oven', 1, null, [0]]]);
  assertEquals(st.claims.map((c) => [c.device_id, c.result]), [[DEV_A, null]]);
});

Deno.test('claim: NO takeover — the register moves to B, B\'s claim of A\'s order is a noop (claimed false)', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  await claim(s, o);
  await s.setPrintRegister(R1, DEV_B, 'admin');
  assertEquals(await claim(s, o, DEV_B), { outcome: 'ok', applied: false, claimed: false });
});

Deno.test('claim: the tablet printed it (print_status printed) → never claimed', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  assertEquals(await claim(s, fakeId(), DEV_A, { printed: true }), { outcome: 'ok', applied: false, claimed: false });
});

Deno.test('claim: an unclaimed order with a result over stations is not claimed; null stations are REPLACED (applyClaim)', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o1 = fakeId();
  await rec(s, o1, DEV_B, 'reprint', 'printed', COUNTER); // a reprint never claims
  assertEquals(await claim(s, o1), { outcome: 'ok', applied: false, claimed: false });
  const o2 = fakeId();
  await rec(s, o2, DEV_B, 'reprint', 'failed', BAR); // a failed reprint leaves the station null
  assertEquals(await claim(s, o2), { outcome: 'ok', applied: true, claimed: true });
  assertEquals((await s.printState(R1, [o2])).stations.map((x) => x.station), ['p-counter', 'p-oven']);
});

Deno.test('claim: bad stations refused (invalid_input = 22023 / 23505)', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  for (const stations of [[{ station: '', name: 'x', lines: [] }], [{ station: 'a', name: 'x', lines: [-1] }], [COUNTER, COUNTER]]) {
    await assertRejects(() => claim(s, fakeId(), DEV_A, { stations: stations as OnlineStationRef[] }), OnlineStoreError);
  }
});

// ---- record ----------------------------------------------------------------------------------------

Deno.test('record: the order is printed only once EVERY station printed (counter, then oven)', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  await claim(s, o);
  assertEquals(await rec(s, o, DEV_A, 'auto', 'printed', COUNTER), { outcome: 'recorded', order_result: null, claimed_by: DEV_A });
  assertEquals(await rec(s, o, DEV_A, 'auto', 'printed', OVEN), { outcome: 'recorded', order_result: 'printed', claimed_by: DEV_A });
  const st = await s.printState(R1, [o]);
  assertEquals(st.claims[0].result, 'printed');
  assert(st.claims[0].printed_at !== null);
  assertEquals(st.log.map((l) => [l.station, l.variant, l.result]), [['p-counter', 'auto', 'printed'], ['p-oven', 'auto', 'printed']]);
});

Deno.test('record: one station failed → the order failed; a printed station stays printed; an unknown station is added last', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  await claim(s, o);
  await rec(s, o, DEV_A, 'auto', 'printed', COUNTER);
  await rec(s, o, DEV_A, 'auto', 'printed', OVEN);
  assertEquals((await rec(s, o, DEV_A, 'auto', 'failed', OVEN, { error: 'Cover open' })).outcome, 'recorded');
  assertEquals((await s.printState(R1, [o])).stations.find((x) => x.station === 'p-oven')!.result, 'printed');
  assertEquals(await rec(s, o, DEV_B, 'manual', 'failed', BAR), { outcome: 'recorded', order_result: 'failed', claimed_by: DEV_A });
  assertEquals((await s.printState(R1, [o])).stations.map((x) => [x.station, x.position]), [['p-counter', 0], ['p-oven', 1], ['p-bar', 2]]);
});

Deno.test('record: NOT CONFIRMED on one station; a Print / Reprint that prints settles it', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  await claim(s, o);
  await rec(s, o, DEV_A, 'auto', 'printed', COUNTER);
  assertEquals((await rec(s, o, DEV_A, 'auto', 'printed_unconfirmed', OVEN)).outcome, 'recorded');
  assertEquals((await s.printState(R1, [o])).claims[0].result, 'printed_unconfirmed');
  assertEquals(await rec(s, o, DEV_B, 'manual', 'printed', OVEN), { outcome: 'recorded', order_result: 'printed', claimed_by: DEV_A });
});

Deno.test('record: manual on an UNCLAIMED order claims it for that device (no auto ticket follows anywhere)', async () => {
  const { s } = setup();
  await s.setPrintRegister(R1, DEV_A, 'admin');
  const o = fakeId();
  assertEquals(await rec(s, o, DEV_B, 'manual', 'printed', COUNTER), { outcome: 'recorded', order_result: 'printed', claimed_by: DEV_B });
  assertEquals(await claim(s, o), { outcome: 'ok', applied: false, claimed: false });
});

Deno.test('record: the same action_id twice → duplicate (logged once); bad input refused; another restaurant refused', async () => {
  const { s } = setup();
  const o = fakeId();
  const actionId = fakeId('a');
  assertEquals((await rec(s, o, DEV_B, 'manual', 'printed', COUNTER, { actionId })).outcome, 'recorded');
  assertEquals(await rec(s, o, DEV_B, 'manual', 'printed', COUNTER, { actionId }), { outcome: 'duplicate' });
  assertEquals((await s.printState(R1, [o])).log.length, 1);
  await assertRejects(() => rec(s, o, DEV_B, 'bogus' as PrintVariant, 'printed', COUNTER), OnlineStoreError);
  await assertRejects(() => rec(s, o, DEV_B, 'auto', 'claimed' as PrintResult, COUNTER), OnlineStoreError);
  assertEquals(
    await s.recordPrint({ restaurantId: R2, channel: 'ordr', orderId: o, deviceId: DEV_R2, actionId: fakeId('a'), variant: 'manual', result: 'printed', station: COUNTER, error: null, deviceTime: null }),
    { outcome: 'restaurant_mismatch' },
  );
});

Deno.test('printState: restaurant-scoped, stations by position, log oldest first', async () => {
  const { s, clock } = setup();
  const o = fakeId();
  await rec(s, o, DEV_B, 'manual', 'failed', BAR);
  clock.advance(1000);
  await rec(s, o, DEV_B, 'manual', 'printed', COUNTER);
  const st = await s.printState(R1, [o]);
  assertEquals(st.stations.map((x) => x.station), ['p-bar', 'p-counter']);
  assertEquals(st.log.map((l) => l.result), ['failed', 'printed']);
  assertEquals(await s.printState(R2, [o]), { claims: [], stations: [], log: [] });
});

// ---- the mirror == the reference rules (randomized) ---------------------------------------------------

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

Deno.test('MemoryOnlineStore (= 110 SQL) matches printRules.ts (= reference onlinePrintRules.ts) — 400 random histories', async () => {
  const STATIONS = [COUNTER, OVEN, BAR];
  const DEVS = [DEV_A, DEV_B];
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const { s } = setup();
    await s.setPrintRegister(R1, DEV_A, 'admin');
    const o = fakeId();
    const ref: { print: OnlinePrintWire; status: string } = {
      status: 'new',
      print: { stations: [], claimed_by_device_id: null, claimed_at: null, result: null, printed_at: null, attempts: [], print_status: 'pending', print_attempts: 0 },
    };
    const steps: string[] = [];
    for (let i = 0; i < 12; i++) {
      if (r() < 0.25) {
        const stations = STATIONS.slice(0, 1 + Math.floor(r() * 3));
        steps.push(`claim ${stations.map((x) => x.station)}`);
        const want = applyClaim(ref, DEV_A, { stations }, 't');
        const got = await claim(s, o, DEV_A, { stations, printed: ref.print.print_status === 'printed' });
        assertEquals(got.outcome === 'ok' && got.applied, want, `seed ${seed}: ${steps.join(' | ')}`);
      } else {
        const dev = pick(DEVS);
        const variant = pick(['auto', 'manual', 'reprint'] as const);
        const result = pick(['printed', 'printed_unconfirmed', 'failed'] as const);
        const station = pick(STATIONS);
        steps.push(`${dev === DEV_A ? 'A' : 'B'} ${variant} ${result} ${station.station}`);
        const tw = applyPrintResult(ref, dev, { variant, result, error: null, station }, 't', 'received');
        if (tw.printStatus) ref.print.print_status = tw.printStatus;
        const got = await rec(s, o, dev, variant, result, station);
        assertEquals(got.outcome, 'recorded');
        if (got.outcome === 'recorded') assertEquals(got.order_result, ref.print.result, `seed ${seed}: ${steps.join(' | ')}`);
      }
      const st = await s.printState(R1, [o]);
      const ctx = `seed ${seed}: ${steps.join(' | ')}`;
      assertEquals(st.claims[0]?.device_id ?? null, ref.print.claimed_by_device_id, ctx);
      assertEquals(st.stations.map((x) => [x.station, x.result, x.lines]), ref.print.stations.map((x) => [x.station, x.result, x.lines]), ctx);
      const memResult = st.claims[0] ? st.claims[0].result : orderPrintResult(st.stations);
      assertEquals(memResult, ref.print.result, ctx);
      assertEquals(st.log.map((l) => [l.device_id, l.variant, l.result, l.station]), ref.print.attempts.map((a) => [a.device_id, a.variant, a.result, a.station]), ctx);
    }
  }
});

// ---- print action idempotency (111 begin / complete) ----------------------------------------------------

Deno.test('actions: started → pending → completed → duplicate (stored outcome); any difference → action_id_reused', async () => {
  const { s } = setup();
  const a: ActionBegin = {
    actionId: fakeId('a'), fn: 'print', restaurantId: R1, deviceId: DEV_A, channel: 'ordr', orderId: fakeId(), action: 'print_claim',
    request: { order_id: 'x', at: 1 }, actor: null, approver: null, deviceTime: null,
  };
  assertEquals(await s.beginAction(a), { outcome: 'started' });
  const pend = await s.beginAction({ ...a, request: { at: 1, order_id: 'x' }, deviceTime: '2026-11-24T15:00:00.000Z' }); // key order irrelevant (jsonb); device_time is not the request
  assertEquals(pend.outcome, 'pending');
  assert(pend.outcome === 'pending' && typeof pend.since === 'string' && Number.isFinite(Date.parse(pend.since)), '113: since = when it was begun');
  assertEquals(await s.completeAction(a.actionId, DEV_B, 'applied'), { outcome: 'device_mismatch' });
  assertEquals(await s.completeAction(a.actionId, DEV_A, 'applied'), { outcome: 'completed' });
  assertEquals(await s.beginAction(a), { outcome: 'duplicate', stored: 'applied', error_status: null, error_code: null, error_message: null, order_ids: [] });
  const diffs: Partial<ActionBegin>[] = [
    { request: { order_id: 'x', at: 2 } }, { action: 'print_result' }, { fn: 'settings' }, { channel: 'kitchenhub' }, { deviceId: DEV_B },
    { orderId: fakeId() }, { restaurantId: R2 },
  ];
  for (const diff of diffs) assertEquals(await s.beginAction({ ...a, ...diff }), { outcome: 'action_id_reused' }, JSON.stringify(diff));
  assertEquals(await s.completeAction(a.actionId, DEV_A, 'noop'), { outcome: 'already_completed', stored: 'applied' });
  assertEquals(await s.completeAction(fakeId('a'), DEV_A, 'applied'), { outcome: 'not_found' });
});

// ---- Pg wrapper: names must match 109–114 -----------------------------------------------------------

Deno.test('PgOnlineStore: RPC + argument names match the 109–114 functions; error codes mapped', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const reads: string[] = [];
  let next: { data: unknown; error: { code?: string; message: string } | null } = { data: { outcome: 'ok' }, error: null };
  const pg = new PgOnlineStore({
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return Promise.resolve(next);
    },
    from: (t: string) => {
      reads.push(t);
      // deno-lint-ignore no-explicit-any
      const q: any = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return q;
    },
  });
  const o = fakeId();
  const recIn: RecordInput = { restaurantId: R1, channel: 'ordr', orderId: o, deviceId: DEV_A, actionId: 'act', variant: 'auto', result: 'printed', station: COUNTER, error: null, deviceTime: null };
  await pg.claimPrint({ restaurantId: R1, channel: 'ordr', orderId: o, deviceId: DEV_A, stations: [COUNTER], printStatusPrinted: false });
  await pg.recordPrint(recIn);
  next = { data: { claims: [{ order_channel: 'ordr', order_id: o, device_id: DEV_A, claimed_at: '2026-11-24T14:00:00.123456+00:00', result: null, printed_at: null }], stations: [], log: [] }, error: null };
  const st = await pg.printState(R1, [o]);
  assertEquals(st.claims[0].claimed_at, '2026-11-24T14:00:00.123Z');
  assertEquals(await pg.printState(R1, []), { claims: [], stations: [], log: [] }); // no RPC for nothing
  next = { data: { outcome: 'started' }, error: null };
  await pg.beginAction({ actionId: 'act', fn: 'print', restaurantId: R1, deviceId: DEV_A, channel: 'ordr', orderId: o, action: 'print_claim', request: {}, actor: null, approver: null, deviceTime: null });
  await pg.completeAction('act', DEV_A, 'applied');
  next = { data: { outcome: 'applied', ready_email: true, order_ids: [] }, error: null };
  assertEquals(await pg.orderAction({ actionId: 'act2', restaurantId: R1, deviceId: DEV_A, orderId: o, action: 'accept', expectedStatus: 'new', quotedReadyMinutes: 20, request: {}, actor: 'register', approver: null, deviceTime: null }),
    { outcome: 'applied', ready_email: true, order_ids: [] });
  next = { data: { outcome: 'duplicate', stored: 'applied', error_status: null, error_code: null, error_message: null, order_ids: [o] }, error: null };
  assertEquals(await pg.orderAction({ actionId: 'act3', restaurantId: R1, deviceId: DEV_A, orderId: null, action: 'complete_all_in_progress', expectedStatus: null, quotedReadyMinutes: null, request: {}, actor: null, approver: null, deviceTime: null }),
    { outcome: 'duplicate', stored: 'applied', error_status: null, error_code: null, error_message: null, order_ids: [o] });
  next = { data: { outcome: 'noop' }, error: null };
  await pg.settingsChange({ actionId: 'act4', restaurantId: R1, deviceId: DEV_A, kind: 'online_auto_print', printDeviceId: null, on: true, request: {}, actor: 'register', approver: null, deviceTime: null });
  next = { data: { outcome: 'completed' }, error: null };
  await pg.finishAction('act6', DEV_A, 'error', { status: 502, code: 'refund_failed', message: 'declined' });
  next = { data: { outcome: 'released' }, error: null };
  assertEquals(await pg.releaseAction('act8', DEV_A), { outcome: 'released' });
  next = { data: { outcome: 'applied' }, error: null };
  assertEquals(await pg.adjustmentRequest({ actionId: 'act7', restaurantId: R1, deviceId: DEV_A, orderId: o, expectedStatus: 'complete', type: 'charge', amountCents: 500, note: 'x', request: {}, actor: 'register', approver: null, deviceTime: null }), { outcome: 'applied' });
  await pg.tabletSettingChange({ actionId: 'act5', restaurantId: R1, deviceId: DEV_A, kind: 'estimates', pickupMinutes: 20, deliveryMinutes: 45, on: null, itemId: null, request: {}, actor: 'register', approver: null, deviceTime: null });
  await pg.setPrintRegister(R1, DEV_A, 'admin');
  assertEquals(await pg.getSettings(R1), null);
  assertEquals(reads, ['pos_restaurant_settings']);
  assertEquals(calls.map(([fn, args]) => [fn, Object.keys(args)]), [
    ['pos_claim_online_print', ['p_restaurant_id', 'p_order_channel', 'p_order_id', 'p_device_id', 'p_stations', 'p_print_status_printed']],
    ['pos_record_online_print', ['p_restaurant_id', 'p_order_channel', 'p_order_id', 'p_device_id', 'p_action_id', 'p_variant', 'p_result', 'p_station', 'p_error', 'p_device_time']],
    ['pos_online_print_state', ['p_restaurant_id', 'p_order_ids']],
    ['pos_online_action_begin', ['p_action_id', 'p_function', 'p_restaurant_id', 'p_device_id', 'p_order_channel', 'p_order_id', 'p_action', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_online_action_complete', ['p_action_id', 'p_device_id', 'p_outcome']],
    ['pos_online_order_action', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_order_id', 'p_action', 'p_expected_status', 'p_quoted_ready_minutes', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_online_order_action', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_order_id', 'p_action', 'p_expected_status', 'p_quoted_ready_minutes', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_online_settings_change', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_kind', 'p_print_device_id', 'p_on', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_online_action_finish', ['p_action_id', 'p_device_id', 'p_outcome', 'p_error_status', 'p_error_code', 'p_error_message']],
    ['pos_online_action_release', ['p_action_id', 'p_device_id']],
    ['pos_online_adjustment_request', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_order_id', 'p_expected_status', 'p_type', 'p_amount_cents', 'p_note', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_online_tablet_setting_change', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_kind', 'p_pickup_minutes', 'p_delivery_minutes', 'p_on', 'p_item_id', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_set_print_register', ['p_restaurant_id', 'p_device_id', 'p_updated_by']],
  ]);
  next = { data: null, error: { code: '23514', message: 'print register must be an active register of this restaurant' } };
  assertEquals((await assertRejects(() => pg.setPrintRegister(R1, DEV_R2, 'admin'), OnlineStoreError)).code, 'invalid_print_register');
  next = { data: null, error: { code: '22023', message: 'bad input' } };
  assertEquals((await assertRejects(() => pg.recordPrint(recIn), OnlineStoreError)).code, 'invalid_input');
  next = { data: null, error: { message: 'boom' } };
  await assertRejects(() => pg.claimPrint({ restaurantId: R1, channel: 'ordr', orderId: o, deviceId: DEV_A, stations: [COUNTER], printStatusPrinted: false }), Error, 'pos_claim_online_print failed');
});

Deno.test('PgOnlineStore.getSettings: select * — before 115 (no pos_delivery_dispatch_enabled column) it reads false; after, the column', async () => {
  let row: Record<string, unknown> | null = { restaurant_id: R1, print_register_device_id: DEV_A, pos_online_orders_enabled: true, online_auto_print_enabled: true, kitchenhub_auto_print_enabled: false, updated_by: 'x' };
  const cols: string[] = [];
  const pg = new PgOnlineStore({
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => {
      // deno-lint-ignore no-explicit-any
      const q: any = { select: (c: string) => { cols.push(c); return q; }, eq: () => q, maybeSingle: () => Promise.resolve({ data: row, error: null }) };
      return q;
    },
  });
  assertEquals(await pg.getSettings(R1), { print_register_device_id: DEV_A, pos_online_orders_enabled: true, online_auto_print_enabled: true, kitchenhub_auto_print_enabled: false, pos_delivery_dispatch_enabled: false });
  row = { ...row, pos_delivery_dispatch_enabled: true };
  assertEquals((await pg.getSettings(R1))!.pos_delivery_dispatch_enabled, true);
  row = null;
  assertEquals(await pg.getSettings(R1), null);
  assertEquals(cols, ['*', '*', '*']);
});
