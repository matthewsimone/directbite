/**
 * pos-v1-online-order-action (CP18) — the Ordr actions end to end over the device middleware, MemoryOnlineStore
 * (= 111 pos_online_order_action) and the in-memory PostgREST. Scenarios ported from the reference
 * (ordr-pos @ 86c558d test/online/actions.test.ts — the server-observable parts):
 *   "Mark in progress" :80-91, "Confirm 25 min … duplicate, still one email" :93-106, "two registers accept" :108-119,
 *   "a scheduled order … an Uber delivery is not accepted here" :121-132, "wrong channel" :134-146,
 *   queued complete :149-226 (server cancelled meanwhile → 409 with the order; both registers complete → 409 complete;
 *   self_delivering / scheduled allowed, new not), "end of shift" :230-247,
 * + test/support/fakeOnline.ts action :354-433 (validation order, idempotency, the ready email once) and the wake-up
 *   (useOrderPolling.js :526-544). Every served order is read with the POS's own parser.
 * The rule itself (actionRules.ts = the 111 SQL) is checked against the VERBATIM reference rule
 * (referenceActionRules.ts = onlineActionRules.ts) over random rows.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { err, ok, R1, R2 } from '../../pos-device/tests/harness.ts';
import { ordrActionRule, type OrderRuleInput } from '../actionRules.ts';
import { makeReadyEmail, sendReadyEmailRequest } from '../readyEmail.ts';
import type { FeedRow } from '../feedQuery.ts';
import { indexPrintState, ordrOrderWire, type OnlineOrderWire } from '../wire.ts';
import { applyOnlineActionRule } from './referenceActionRules.ts';
import { parseOnlineOrder } from './referenceParse.ts';
import { khRow, ordrRow, world } from './world.ts';

type Body = { result: string; order: OnlineOrderWire | null; orders: OnlineOrderWire[]; server_time: string };
const MIN = 60_000;

function readable(o: unknown): OnlineOrderWire {
  const p = parseOnlineOrder(o);
  assertEquals(p.kind, 'ok', `the POS could not read the order: ${JSON.stringify(p)}`);
  return o as OnlineOrderWire;
}
const okBody = (r: Parameters<typeof ok>[0]): Body => {
  const b = ok<Body>(r);
  assertEquals(Object.keys(b).sort(), ['order', 'orders', 'result', 'server_time']);
  if (b.order) readable(b.order);
  b.orders.forEach(readable);
  return b;
};
/** The columns an action changed on the orders row (the tablet's write, nothing more). */
function changed(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

// ---- the rule vs the reference (differential) ----------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test('actionRules.ts (= 111 SQL) matches the VERBATIM reference rule (onlineActionRules.ts) — 3000 random rows × actions', () => {
  const NOW = Date.parse('2026-11-24T18:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const STATUSES = ['new', 'in_progress', 'scheduled', 'complete', 'cancelled', 'self_delivering'];
  const ACTIONS: OrderRuleInput['action'][] = ['ack', 'stuck_ack', 'accept', 'schedule', 'complete', 'wake_scheduled'];
  const idx = indexPrintState({ claims: [], stations: [], log: [] });
  let compared = 0;
  const kinds = new Map<string, number>();
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const delivery = r() < 0.5;
    const uber = delivery && r() < 0.6; // checkout sets uber_direct on deliveries only
    const booked = uber && r() < 0.6;
    const at = iso(NOW - Math.floor(r() * 120) * MIN);
    const row = ordrRow(at, {
      status: pick(STATUSES),
      order_type: delivery ? 'delivery' : 'pickup',
      delivery_address: delivery ? '1 Test St' : null,
      delivery_fulfillment_method: uber ? 'uber_direct' : 'in_house',
      uber_delivery_id: booked ? 'uber-del-1' : null,
      uber_status: booked ? 'pending' : null,
      uber_dispatched_at: booked ? at : null,
      scheduled_for: r() < 0.5 ? iso(NOW + (Math.floor(r() * 240) - 60) * MIN) : null,
      uber_pickup_ready_dt: booked && r() < 0.5 ? iso(NOW + (Math.floor(r() * 120) - 30) * MIN) : null,
      acknowledged_at: r() < 0.5 ? at : null,
      stuck_acknowledged_at: r() < 0.3 ? at : null,
      accepted_at: r() < 0.3 ? at : null,
      quoted_for: r() < 0.2 ? iso(NOW + 15 * MIN) : null,
    });
    const est = pick([0, 15, 20, 30, 45]);
    const action = pick(ACTIONS);
    const req: OrderRuleInput = {
      action,
      expected_status: r() < 0.75 ? row.status : pick(STATUSES),
      quoted_ready_minutes: action === 'accept' ? pick([null, null, 1, 25, 240, 0, 241]) : null,
    };
    const wire = ordrOrderWire(structuredClone(row) as FeedRow, idx);
    const ref = applyOnlineActionRule(wire, { ...req, prep_minutes: null }, NOW, { newAdjustmentId: () => 'x', estimatedPickupMinutes: est });
    const mine = ordrActionRule(row, req, NOW, est);
    const mapped = mine.kind === 'applied' ? { kind: 'applied', readyEmail: mine.readyEmail }
      : mine.kind === 'noop' ? { kind: 'noop' }
      : mine.kind === 'status_conflict' ? { kind: 'error', status: 409, code: 'status_conflict' }
      : mine.kind === 'not_allowed' ? { kind: 'error', status: 400, code: 'action_not_allowed' }
      : { kind: 'error', status: 400, code: 'invalid_payload' };
    const refShape = ref.kind === 'error' ? { kind: 'error', status: ref.status, code: ref.code } : ref.kind === 'applied' ? { kind: 'applied', readyEmail: ref.readyEmail } : { kind: 'noop' };
    assertEquals(mapped, refShape, `seed ${seed}: ${action} on ${JSON.stringify({ status: row.status, sched: row.scheduled_for, type: row.order_type, method: row.delivery_fulfillment_method, booked, req })}`);
    // the state after: the row with exactly `set` written, served → the reference's mutated wire
    const after = mine.kind === 'applied' ? { ...structuredClone(row), ...mine.set } : structuredClone(row);
    // channel_status and delivery.status of an Ordr order are READS of the columns (wire.ts; the reference says so
    // itself, onlineActionRules.ts :212, :233) — the reference mutates its wire in place and refreshes them only in
    // some cases (ext_*, dispatch, wake). Every column-backed field is compared; the two derived ones are not.
    const derivedOut = (x: OnlineOrderWire) => ({ ...x, channel_status: null, delivery: x.delivery ? { ...x.delivery, status: null } : null });
    assertEquals(derivedOut(ordrOrderWire(after as FeedRow, idx)), derivedOut(wire), `seed ${seed}: the state after ${action}`);
    kinds.set(`${action}:${mine.kind}`, (kinds.get(`${action}:${mine.kind}`) ?? 0) + 1);
    compared++;
  }
  assertEquals(compared, 3000);
  // every action reached every outcome it can have (the generator is not vacuous)
  for (const k of ['ack:applied', 'ack:noop', 'stuck_ack:applied', 'accept:applied', 'accept:status_conflict', 'accept:not_allowed', 'accept:invalid',
    'schedule:applied', 'schedule:not_allowed', 'complete:applied', 'complete:not_allowed', 'wake_scheduled:applied', 'wake_scheduled:not_allowed']) {
    assert((kinds.get(k) ?? 0) > 0, `never reached ${k}: ${JSON.stringify([...kinds])}`);
  }
});

// ---- the ready email: the tablet's request ----------------------------------------------------------------

Deno.test('ready email: EXACTLY the tablet request (OrdersTab.jsx :711-718), fire-and-forget, never throws', async () => {
  assertEquals(sendReadyEmailRequest({ supabaseUrl: 'https://x.supabase.co/', anonKey: 'anon-key' }, 'o-1'), {
    url: 'https://x.supabase.co/functions/v1/send-ready-email',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anon-key' }, body: '{"order_id":"o-1"}' },
  });
  const seen: [string, RequestInit | undefined][] = [];
  const pending: Promise<unknown>[] = [];
  const logs: [string, Record<string, unknown>][] = [];
  const send = makeReadyEmail({
    supabaseUrl: 'https://x.supabase.co', anonKey: 'anon-key', log: (e, f) => void logs.push([e, f]), waitUntil: (p) => void pending.push(p),
    fetch: (u, i) => {
      seen.push([String(u), i]);
      return seen.length === 1 ? Promise.resolve(new Response('{}', { status: 200 })) : Promise.reject(new Error('down'));
    },
  });
  send('o-1');
  send('o-2'); // the network fails: logged, nothing thrown
  await Promise.all(pending);
  assertEquals(seen.map(([u]) => u), ['https://x.supabase.co/functions/v1/send-ready-email', 'https://x.supabase.co/functions/v1/send-ready-email']);
  assertEquals(logs.map(([e, f]) => [e, f.order_id]), [['online_ready_email_failed', 'o-2']]);
});

// ---- accept / Confirm N min / schedule (actions.test.ts :79-146) ----------------------------------------

Deno.test('Mark in progress: new → in_progress + accepted_at — the tablet\'s write only; no email without a quoted time', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const before = structuredClone(w.order(row.id));
  const b = okBody(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new' }));
  assertEquals([b.result, b.order!.status, b.orders], ['applied', 'in_progress', []]);
  assertEquals(changed(before, w.order(row.id)), ['accepted_at', 'status']);
  assertEquals(w.order(row.id).accepted_at, w.nowIso());
  assertEquals(w.order(row.id).quoted_for, null);
  assertEquals(w.readyEmails, []);
});

Deno.test('Confirm 25 min: quoted_for = now + 25 min, the ready email once; the same request again → duplicate, still one email', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const before = structuredClone(w.order(row.id));
  const id = crypto.randomUUID();
  const first = okBody(await w.action({ action_id: id, order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 25 }));
  assertEquals(first.result, 'applied');
  assertEquals(changed(before, w.order(row.id)), ['accepted_at', 'quoted_for', 'status']); // confirmReadyTime :705-707
  const t0 = w.h.clock.now();
  w.h.clock.advance(5_000);
  // the answer was lost; the register re-sends the SAME request (a new device_time)
  const again = okBody(await w.action({ action_id: id, order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 25 }));
  assertEquals([again.result, again.order!.status], ['duplicate', 'in_progress']);
  assertEquals(Date.parse(w.order(row.id).quoted_for) - t0, 25 * MIN);
  assertEquals(w.readyEmails, [row.id], 'one ready email');
  assertEquals([...w.online.actions.values()].filter((a) => a.order_id === row.id && a.ready_email_sent).length, 1);
});

Deno.test('two registers accept the same order: one applies, the other gets 409 with the order in progress; one email; A\'s quote stands', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const a = okBody(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 20 }, w.A));
  const b = await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 30 }, w.B);
  assertEquals(a.result, 'applied');
  assertEquals(err(b), { status: 409, code: 'status_conflict', message: 'the order is in_progress' });
  const cur = readable((b.body as { error: { order: unknown } }).error.order);
  assertEquals(cur.status, 'in_progress', 'the 409 carries the order as it is now (→ "already" on the POS)');
  assertEquals(Date.parse(w.order(row.id).quoted_for) - w.h.clock.now(), 20 * MIN);
  assertEquals(w.readyEmails, [row.id]);
});

Deno.test('the ready email at most once per order: the tablet put it back to new and it is confirmed again → no second email', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  okBody(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 20 }));
  w.order(row.id).status = 'new'; // another writer
  const again = okBody(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 15 }));
  assertEquals(again.result, 'applied');
  assertEquals(w.readyEmails, [row.id]);
});

Deno.test('a scheduled order: accept → action_not_allowed; schedule → scheduled + accepted_at; an Uber delivery is not accepted / scheduled here', async () => {
  const w = await world();
  const at = w.nowIso();
  const sch = ordrRow(at, { scheduled_for: new Date(w.h.clock.now() + 3 * 3600_000).toISOString() });
  const uber = ordrRow(at, { order_type: 'delivery', delivery_address: '1 Test St', delivery_fulfillment_method: 'uber_direct' });
  const uberSch = ordrRow(at, { order_type: 'delivery', delivery_address: '1 Test St', delivery_fulfillment_method: 'uber_direct', scheduled_for: sch.scheduled_for });
  for (const r of [sch, uber, uberSch]) w.db.insertRow('orders', r);
  assertEquals(err(await w.action({ order_id: sch.id, action: 'accept', expected_status: 'new' })).code, 'action_not_allowed');
  const before = structuredClone(w.order(sch.id));
  const s = okBody(await w.action({ order_id: sch.id, action: 'schedule', expected_status: 'new' }));
  assertEquals([s.result, s.order!.status], ['applied', 'scheduled']);
  assertEquals(changed(before, w.order(sch.id)), ['accepted_at', 'status']);
  assertEquals(err(await w.action({ order_id: uber.id, action: 'accept', expected_status: 'new' })).code, 'action_not_allowed');
  assertEquals(err(await w.action({ order_id: uberSch.id, action: 'schedule', expected_status: 'new' })).code, 'action_not_allowed', 'booked by dispatching (CP20)');
  assertEquals([w.order(uber.id).status, w.order(uberSch.id).status], ['new', 'new']);
  // booked at checkout → Accept schedules it
  w.order(uberSch.id).uber_delivery_id = 'uber-del-1';
  assertEquals(okBody(await w.action({ order_id: uberSch.id, action: 'schedule', expected_status: 'new' })).result, 'applied');
});

Deno.test('wrong channel / later checkpoints: an Ordr action on a KitchenHub order → action_not_allowed; ext_* / money / Uber → 501', async () => {
  const w = await world({ restaurant: { dsp_orders_enabled: true } });
  const kh = khRow(w.nowIso());
  const row = ordrRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  w.db.insertRow('orders', row);
  assertEquals(err(await w.action({ order_id: kh.id, action: 'accept', expected_status: 'new' })), { status: 400, code: 'action_not_allowed', message: 'accept on a kitchenhub order' });
  for (const action of ['ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel', 'cancel_refund', 'adjustment_request', 'dispatch_delivery', 'self_deliver']) {
    assertEquals(err(await w.action({ order_id: row.id, action, expected_status: 'new' })).status, 501, action);
  }
  assertEquals(w.order(row.id).status, 'new');
  assertEquals(w.online.actions.size, 0, 'nothing recorded');
});

// ---- Mark Complete / Delivered (actions.test.ts :148-226) --------------------------------------------------

Deno.test('complete: in_progress / scheduled / self_delivering → complete (status only); new → not allowed', async () => {
  const w = await world();
  const at = w.nowIso();
  const rows = ['in_progress', 'scheduled', 'self_delivering', 'new'].map((status) => ordrRow(at, { status }));
  for (const r of rows) w.db.insertRow('orders', r);
  for (const r of rows.slice(0, 3)) {
    const before = structuredClone(w.order(r.id));
    assertEquals(okBody(await w.action({ order_id: r.id, action: 'complete', expected_status: before.status })).order!.status, 'complete');
    assertEquals(changed(before, w.order(r.id)), ['status']);
  }
  assertEquals(err(await w.action({ order_id: rows[3].id, action: 'complete', expected_status: 'new' })).code, 'action_not_allowed');
});

Deno.test('complete: the server cancelled it meanwhile → 409 status_conflict with the cancelled order (never forced); both registers → the second 409 is complete', async () => {
  const w = await world();
  const at = w.nowIso();
  const gone = ordrRow(at, { status: 'in_progress' });
  const both = ordrRow(at, { status: 'in_progress' });
  w.db.insertRow('orders', gone);
  w.db.insertRow('orders', both);
  w.order(gone.id).status = 'cancelled';
  const c = await w.action({ order_id: gone.id, action: 'complete', expected_status: 'in_progress' });
  assertEquals([err(c).status, err(c).code], [409, 'status_conflict']);
  assertEquals(readable((c.body as { error: { order: unknown } }).error.order).status, 'cancelled');
  assertEquals(w.order(gone.id).status, 'cancelled');
  okBody(await w.action({ order_id: both.id, action: 'complete', expected_status: 'in_progress' }, w.A));
  const second = await w.action({ order_id: both.id, action: 'complete', expected_status: 'in_progress' }, w.B);
  assertEquals(readable((second.body as { error: { order: unknown } }).error.order).status, 'complete');
});

Deno.test('errors are not stored: a 409 re-sent with the same action_id is evaluated again (fakeOnline.ts :405-416)', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso(), { status: 'in_progress' });
  w.db.insertRow('orders', row);
  const id = crypto.randomUUID();
  w.order(row.id).status = 'scheduled';
  assertEquals(err(await w.action({ action_id: id, order_id: row.id, action: 'complete', expected_status: 'in_progress' })).code, 'status_conflict');
  w.order(row.id).status = 'in_progress';
  assertEquals(okBody(await w.action({ action_id: id, order_id: row.id, action: 'complete', expected_status: 'in_progress' })).result, 'applied');
  assertEquals(err(await w.action({ action_id: id, order_id: row.id, action: 'complete', expected_status: 'scheduled' })).code, 'action_id_reused');
});

// ---- end of shift (actions.test.ts :229-247) ---------------------------------------------------------------

Deno.test('complete_all_in_progress: in-progress ORDR orders only (not scheduled / self-delivering / KitchenHub / another restaurant); a resend → duplicate with the same orders; again → noop', async () => {
  const w = await world({ restaurant: { dsp_orders_enabled: true } });
  const at = w.nowIso();
  const p1 = ordrRow(at, { status: 'in_progress' });
  const p2 = ordrRow(at, { status: 'in_progress', order_type: 'delivery', delivery_address: '1 Test St' });
  const sch = ordrRow(at, { status: 'scheduled', scheduled_for: new Date(w.h.clock.now() + 3600_000).toISOString() });
  const self = ordrRow(at, { status: 'self_delivering', order_type: 'delivery', delivery_address: '1 Test St', delivery_fulfillment_method: 'uber_direct' });
  const theirs = ordrRow(at, { status: 'in_progress', restaurant_id: R2 });
  const kh = khRow(at, { status: 'accepted' });
  for (const r of [p1, p2, sch, self, theirs]) w.db.insertRow('orders', r);
  w.db.insertRow('external_orders', kh);
  const id = crypto.randomUUID();
  const first = okBody(await w.action({ action_id: id, action: 'complete_all_in_progress' }));
  assertEquals([first.result, first.order, first.orders.map((o) => o.id).sort()], ['applied', null, [p1.id, p2.id].sort()]);
  assertEquals([p1, p2, sch, self, theirs].map((r) => w.order(r.id).status), ['complete', 'complete', 'scheduled', 'self_delivering', 'in_progress']);
  assertEquals(w.db.rows('external_orders')[0].status, 'accepted');
  const again = okBody(await w.action({ action_id: id, action: 'complete_all_in_progress' }));
  assertEquals([again.result, again.orders.length], ['duplicate', 2]);
  const none = okBody(await w.action({ action: 'complete_all_in_progress' }));
  assertEquals([none.result, none.orders], ['noop', []]);
  assertEquals(err(await w.action({ action: 'complete_all_in_progress', order_id: p1.id })).code, 'invalid_payload');
});

// ---- ack / stuck ack -------------------------------------------------------------------------------------

Deno.test('ack: acknowledged_at once (then noop); stuck_ack: stuck_acknowledged_at = now every time; no expected_status needed', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const before = structuredClone(w.order(row.id));
  assertEquals(okBody(await w.action({ order_id: row.id, action: 'ack' })).result, 'applied');
  assertEquals(changed(before, w.order(row.id)), ['acknowledged_at']);
  const first = w.order(row.id).acknowledged_at;
  w.h.clock.advance(MIN);
  assertEquals(okBody(await w.action({ order_id: row.id, action: 'ack' }, w.B)).result, 'noop');
  assertEquals(w.order(row.id).acknowledged_at, first);
  const s1 = okBody(await w.action({ order_id: row.id, action: 'stuck_ack' }));
  w.h.clock.advance(MIN);
  const s2 = okBody(await w.action({ order_id: row.id, action: 'stuck_ack' }));
  assertEquals([s1.result, s2.result, w.order(row.id).stuck_acknowledged_at], ['applied', 'applied', w.nowIso()]);
});

// ---- the scheduled-Uber wake-up (useOrderPolling.js :526-544) --------------------------------------------------

Deno.test('wake_scheduled: booked scheduled Uber order, due at (pickup_ready ?? scheduled_for) − estimated_pickup_minutes → in_progress ONLY', async () => {
  const w = await world({ restaurant: { estimated_pickup_minutes: 20 } });
  const now = w.h.clock.now();
  const base = { status: 'scheduled', order_type: 'delivery', delivery_address: '1 Test St', delivery_fulfillment_method: 'uber_direct', uber_delivery_id: 'uber-del-1', uber_status: 'pending', uber_dispatched_at: w.nowIso() };
  const due = ordrRow(w.nowIso(), { ...base, scheduled_for: new Date(now + 60 * MIN).toISOString(), uber_pickup_ready_dt: new Date(now + 20 * MIN).toISOString() });
  const later = ordrRow(w.nowIso(), { ...base, scheduled_for: new Date(now + 21 * MIN).toISOString() });
  const inHouse = ordrRow(w.nowIso(), { ...base, delivery_fulfillment_method: 'in_house', uber_delivery_id: null, scheduled_for: new Date(now).toISOString() });
  for (const r of [due, later, inHouse]) w.db.insertRow('orders', r);
  const before = structuredClone(w.order(due.id));
  assertEquals(okBody(await w.action({ order_id: due.id, action: 'wake_scheduled', expected_status: 'scheduled' })).order!.status, 'in_progress');
  assertEquals(changed(before, w.order(due.id)), ['status'], 'accepted_at untouched');
  assertEquals(err(await w.action({ order_id: later.id, action: 'wake_scheduled', expected_status: 'scheduled' })), { status: 400, code: 'action_not_allowed', message: 'not due yet' });
  w.h.clock.advance(MIN);
  assertEquals(okBody(await w.action({ order_id: later.id, action: 'wake_scheduled', expected_status: 'scheduled' })).result, 'applied');
  assertEquals(err(await w.action({ order_id: inHouse.id, action: 'wake_scheduled', expected_status: 'scheduled' })).code, 'action_not_allowed');
  // the tablet woke it first → a clean 409
  assertEquals(err(await w.action({ order_id: due.id, action: 'wake_scheduled', expected_status: 'scheduled' })).code, 'status_conflict');
});

// ---- validation order + idempotency (fakeOnline.ts :354-433) ---------------------------------------------------

Deno.test('validation: restaurant / action_id / action / order_id / expected_status / unknown + unwritten + another restaurant\'s order', async () => {
  const w = await world();
  const at = w.nowIso();
  const row = ordrRow(at);
  const unwritten = ordrRow(at, { items_written_at: null });
  const theirs = ordrRow(at, { restaurant_id: R2 });
  for (const r of [row, unwritten, theirs]) w.db.insertRow('orders', r);
  assertEquals(err(await w.action({ order_id: row.id, restaurant_id: R2 })).code, 'restaurant_mismatch');
  assertEquals(err(await w.action({ order_id: row.id, action_id: 'nope' })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: row.id, action: 'pause' })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: null, action: 'ack' })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: row.id, action: 'accept', expected_status: null })), { status: 400, code: 'invalid_payload', message: 'expected_status is required' });
  assertEquals(err(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 241 })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: 2.5 })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new', quoted_ready_minutes: '5' })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: row.id, actor_staff_id: 'Maria' })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: row.id, approver_staff_id: 'x' })).code, 'invalid_payload');
  assertEquals(err(await w.action({ order_id: crypto.randomUUID() })).code, 'unknown_order');
  assertEquals(err(await w.action({ order_id: unwritten.id })).code, 'unknown_order');
  assertEquals(err(await w.action({ order_id: theirs.id })).code, 'restaurant_mismatch');
  assertEquals(w.online.actions.size, 0);
  assertEquals(w.order(row.id).status, 'new');
});

Deno.test('idempotency: same id + same body (minus device_time) → duplicate; another body → 409 action_id_reused; the audit row carries actor + approver', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso(), { status: 'in_progress' });
  w.db.insertRow('orders', row);
  const id = crypto.randomUUID();
  const staff = crypto.randomUUID();
  const mgr = crypto.randomUUID();
  const body = { action_id: id, order_id: row.id, action: 'complete', expected_status: 'in_progress', actor_staff_id: staff, approver_staff_id: mgr };
  assertEquals(okBody(await w.action({ ...body, device_time: '2026-11-19T17:00:00.000Z' })).result, 'applied');
  assertEquals(okBody(await w.action({ ...body, device_time: '2026-11-19T17:05:00.000Z' })).result, 'duplicate');
  assertEquals(err(await w.action({ ...body, actor_staff_id: 'register' })).code, 'action_id_reused');
  assertEquals(err(await w.action({ ...body, order_id: ordrRow(w.nowIso()).id })).code, 'unknown_order', 'the order is checked first (fakeOnline.ts :365-367)');
  const a = w.online.actions.get(id)!;
  assertEquals([a.fn, a.action, a.channel, a.order_id, a.outcome, a.actor, a.approver, a.device_time], ['order_action', 'complete', 'ordr', row.id, 'applied', staff, mgr, '2026-11-19T17:00:00.000Z']);
  assertEquals(a.request.device_time, undefined, 'the request is stored minus device_time');
});

Deno.test('a revoked register: 401/403 before anything changes', async () => {
  const w = await world();
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  w.online.devices.set(w.A.device_id, { id: w.A.device_id, restaurant_id: R1, status: 'revoked' });
  assertEquals(err(await w.action({ order_id: row.id, action: 'accept', expected_status: 'new' })).status, 403);
  assertEquals(w.order(row.id).status, 'new');
});
