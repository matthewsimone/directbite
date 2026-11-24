/**
 * Feed query: business-day window (04:00 cutoff, DST), the PostgREST membership filter (evaluated by a small
 * logic-tree evaluator against Test Pizza fixtures), count=exact → feed_too_large, deterministic hash.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert@1';
import { businessDate } from '../../pos-eod/rules.ts';
import {
  addDays, FEED_SELECT, FeedError, feedHash, feedOrFilter, feedWindow, type FeedWindow, loadFeed, localTimeToEpochMs,
  normalizeFeedRows, OPEN_LOOKBACK_DAYS, stableJson,
} from '../feedQuery.ts';
import { fakeId, order, R1, TZ } from './fixtures.ts';

const NOW = Date.parse('2026-11-24T15:00:00Z'); // 10:00 EST, Tuesday

// ---- window ----------------------------------------------------------------------------------------

Deno.test('window: after the cutoff → today and yesterday, W = yesterday 04:00 local', () => {
  const w = feedWindow(NOW, TZ);
  assertEquals(w, {
    business_date: '2026-11-24',
    previous_business_date: '2026-11-23',
    window_start: '2026-11-23T09:00:00.000Z',
    open_since: new Date(NOW - OPEN_LOOKBACK_DAYS * 86_400_000).toISOString(),
  });
});

Deno.test('window: 03:30 local is still the previous business day', () => {
  const w = feedWindow(Date.parse('2026-11-24T08:30:00Z'), TZ);
  assertEquals([w.business_date, w.previous_business_date, w.window_start], ['2026-11-23', '2026-11-22', '2026-11-22T09:00:00.000Z']);
});

Deno.test('window: DST — W on the spring-forward and fall-back days', () => {
  // 2026-03-08 02:00 EST → 03:00 EDT; 04:00 that day is EDT (UTC−4)
  assertEquals(feedWindow(Date.parse('2026-03-09T12:00:00Z'), TZ).window_start, '2026-03-08T08:00:00.000Z');
  assertEquals(feedWindow(Date.parse('2026-03-08T12:00:00Z'), TZ).window_start, '2026-03-07T09:00:00.000Z');
  // 2026-11-01 02:00 EDT → 01:00 EST; 04:00 that day is EST (UTC−5)
  assertEquals(feedWindow(Date.parse('2026-11-02T15:00:00Z'), TZ).window_start, '2026-11-01T09:00:00.000Z');
  assertEquals(feedWindow(Date.parse('2026-11-01T15:00:00Z'), TZ).window_start, '2026-10-31T08:00:00.000Z');
});

Deno.test('window: W is exactly where businessDate flips, every day of 2026, in several zones', () => {
  for (const tz of ['America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'Europe/London', 'Australia/Sydney']) {
    for (let day = 0; day < 366; day++) {
      const now = Date.parse('2026-01-01T12:00:00Z') + day * 86_400_000;
      const w = feedWindow(now, tz);
      const W = Date.parse(w.window_start);
      assertEquals(businessDate(W, tz, '04:00'), w.previous_business_date, `${tz} ${w.window_start}`);
      assertEquals(businessDate(W - 1000, tz, '04:00'), addDays(w.previous_business_date, -1), `${tz} ${w.window_start} − 1 s`);
      assertEquals(businessDate(now, tz, '04:00'), w.business_date);
    }
  }
});

Deno.test('localTimeToEpochMs + addDays', () => {
  assertEquals(new Date(localTimeToEpochMs('2026-07-04', '04:00', TZ)).toISOString(), '2026-07-04T08:00:00.000Z');
  assertEquals(addDays('2026-03-01', -1), '2026-02-28');
  assertEquals(addDays('2024-03-01', -1), '2024-02-29');
  assertEquals(addDays('2026-01-01', -1), '2025-12-31');
});

// ---- filter --------------------------------------------------------------------------------------------

Deno.test('filter: exact PostgREST logic tree', () => {
  const w = feedWindow(NOW, TZ);
  assertEquals(
    feedOrFilter(w),
    `and(status.in.(new,in_progress,scheduled,self_delivering),or(created_at.gte."${w.open_since}",scheduled_for.gte."2026-11-23T09:00:00.000Z")),` +
      'created_at.gte."2026-11-23T09:00:00.000Z",refunded_at.gte."2026-11-23T09:00:00.000Z"',
  );
});

// Minimal evaluator for the logic trees feedOrFilter produces: and(...) / or(...) / col.in.(a,b) / col.gte."ts".
type Pred = (row: Record<string, unknown>) => boolean;
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseNode(s: string): Pred {
  const m = /^(and|or)\((.*)\)$/s.exec(s);
  if (m) {
    const kids = splitTop(m[2]).map(parseNode);
    return m[1] === 'and' ? (r) => kids.every((k) => k(r)) : (r) => kids.some((k) => k(r));
  }
  const inM = /^([a-z_]+)\.in\.\((.*)\)$/.exec(s);
  if (inM) {
    const set = inM[2].split(',');
    return (r) => set.includes(String(r[inM[1]]));
  }
  const gte = /^([a-z_]+)\.gte\."(.*)"$/.exec(s);
  if (gte) {
    const t = Date.parse(gte[2]);
    return (r) => r[gte[1]] != null && Date.parse(String(r[gte[1]])) >= t; // NULL ≥ x is not true in SQL
  }
  throw new Error(`unparsed node ${s}`);
}
const member = (w: FeedWindow): Pred => parseNode(`or(${feedOrFilter(w)})`);

Deno.test('filter membership: open orders, the two business days, refunds, scheduled', () => {
  const w = feedWindow(NOW, TZ);
  const inFeed = member(w);
  const days = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const cases: [string, Record<string, unknown>, boolean][] = [
    ['new, just now', order({ status: 'new', created_at: days(0) }), true],
    ['in_progress, 6 days old (open < 7 d)', order({ status: 'in_progress', created_at: days(6) }), true],
    ['new, 8 days old (open > 7 d)', order({ status: 'new', created_at: days(8) }), false],
    ['self_delivering, 3 days old', order({ status: 'self_delivering', created_at: days(3) }), true],
    ['scheduled, created 20 days ago, for tomorrow', order({ status: 'scheduled', created_at: days(20), scheduled_for: '2026-11-25T17:00:00Z' }), true],
    ['scheduled, created 20 days ago, for last week', order({ status: 'scheduled', created_at: days(20), scheduled_for: days(6) }), false],
    ['complete, created yesterday 05:00 local', order({ status: 'complete', created_at: '2026-11-23T10:00:00Z' }), true],
    ['cancelled, created yesterday 03:59 local (day before yesterday)', order({ status: 'cancelled', created_at: '2026-11-23T08:59:00Z' }), false],
    ['complete, created exactly at W', order({ status: 'complete', created_at: w.window_start }), true],
    ['complete, 2 days old', order({ status: 'complete', created_at: days(2) }), false],
    ['cancelled 10 days old, refunded today', order({ status: 'cancelled', created_at: days(10), refunded_at: days(0) }), true],
    ['complete 10 days old, refunded 3 days ago', order({ status: 'complete', created_at: days(10), refunded_at: days(3) }), false],
    ['complete, scheduled_for tomorrow but terminal and old', order({ status: 'complete', created_at: days(9), scheduled_for: '2026-11-25T17:00:00Z' }), false],
  ];
  for (const [name, row, want] of cases) assertEquals(inFeed(row), want, name);
});

// ---- fake PostgREST client -------------------------------------------------------------------------

interface Call { table: string; ops: [string, ...unknown[]][] }
function fakeDb(opts: {
  restaurant?: Record<string, unknown> | null;
  restaurantError?: { message: string } | null;
  rows?: Record<string, unknown>[];
  count?: number | null;
  ordersError?: { message: string } | null;
}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      // deno-lint-ignore no-explicit-any
      const q: any = {};
      for (const op of ['select', 'eq', 'or', 'order']) q[op] = (...a: unknown[]) => { call.ops.push([op, ...a]); return q; };
      q.maybeSingle = () => Promise.resolve({ data: opts.restaurant === undefined ? { id: R1, timezone: TZ } : opts.restaurant, error: opts.restaurantError ?? null });
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: opts.rows ?? [], error: opts.ordersError ?? null, count: opts.count === undefined ? (opts.rows ?? []).length : opts.count }).then(res, rej);
      return q;
    },
  };
  return { db, calls };
}

Deno.test('loadFeed: one request, count=exact, scoped by restaurant, filter + order', async () => {
  const a = order({ created_at: '2026-11-24T14:00:00Z' });
  const { db, calls } = fakeDb({ rows: [a] });
  const snap = await loadFeed(db, R1, NOW);
  assertEquals(calls.map((c) => c.table), ['restaurants', 'orders']);
  assertEquals(calls[1].ops, [
    ['select', FEED_SELECT, { count: 'exact' }],
    ['eq', 'restaurant_id', R1],
    ['or', feedOrFilter(feedWindow(NOW, TZ))],
    ['order', 'created_at', { ascending: false }],
    ['order', 'id', { ascending: true }],
  ]);
  assertEquals(snap.count, 1);
  assertEquals(snap.window.business_date, '2026-11-24');
  assertEquals(snap.hash, await feedHash(snap.orders));
  assertEquals(snap.hash.length, 64);
});

Deno.test('loadFeed: more rows than returned → feed_too_large (never truncated)', async () => {
  const { db } = fakeDb({ rows: [order(), order()], count: 3 });
  const e = await assertRejects(() => loadFeed(db, R1, NOW), FeedError);
  assertEquals(e.code, 'feed_too_large');
});

Deno.test('loadFeed: restaurant missing / bad zone / query error / no count', async () => {
  const codes: string[] = [];
  for (const o of [
    { restaurant: null },
    { restaurant: { id: R1, timezone: 'Mars/Olympus' } },
    { restaurantError: { message: 'boom' } },
    { ordersError: { message: 'boom' } },
    { count: null },
  ]) {
    const e = await assertRejects(() => loadFeed(fakeDb(o).db, R1, NOW), FeedError);
    codes.push(e.code);
  }
  assertEquals(codes, ['restaurant_not_found', 'feed_config_invalid', 'feed_query_failed', 'feed_query_failed', 'feed_query_failed']);
});

// ---- normalization + hash ------------------------------------------------------------------------------

function sampleRows() {
  const t1 = { id: 'b1000000-0000-4000-8000-000000000002', topping_name: 'Pepperoni', placement: 'left', price_charged: 1.25 };
  const t2 = { id: 'b1000000-0000-4000-8000-000000000001', topping_name: 'Onion', placement: 'whole', price_charged: 2.5 };
  const i1 = { id: 'a1000000-0000-4000-8000-000000000002', item_name: 'Large Pie', base_price: 18.99, created_at: '2026-11-24T14:00:00.200Z', order_item_toppings: [t1, t2] };
  const i2 = { id: 'a1000000-0000-4000-8000-000000000001', item_name: 'Garlic Knots', base_price: 6.5, created_at: '2026-11-24T14:00:00.100Z', order_item_toppings: [] };
  const older = order({ id: 'c1000000-0000-4000-8000-000000000001', created_at: '2026-11-24T13:00:00Z' });
  const tieA = order({ id: 'c1000000-0000-4000-8000-000000000002', created_at: '2026-11-24T14:00:00Z', order_items: [i1, i2] });
  const tieB = order({ id: 'c1000000-0000-4000-8000-000000000003', created_at: '2026-11-24T14:00:00Z' });
  return { older, tieA, tieB };
}

Deno.test('normalizeFeedRows: orders newest first (ties by id), items by created_at, toppings by id; input untouched', () => {
  const { older, tieA, tieB } = sampleRows();
  const input = [older, tieB, tieA];
  const before = JSON.stringify(input);
  const out = normalizeFeedRows(input);
  assertEquals(out.map((o) => o.id), [tieA.id, tieB.id, older.id]);
  assertEquals(out[0].order_items.map((i: { item_name: string }) => i.item_name), ['Garlic Knots', 'Large Pie']);
  assertEquals(out[0].order_items[1].order_item_toppings.map((t: { topping_name: string }) => t.topping_name), ['Onion', 'Pepperoni']);
  assertEquals(JSON.stringify(input), before);
});

Deno.test('hash: independent of DB row / key order; changes when any value changes', async () => {
  const { older, tieA, tieB } = sampleRows();
  const h1 = await feedHash(normalizeFeedRows([older, tieA, tieB]));
  const reKeyed = Object.fromEntries(Object.entries(tieA).reverse());
  const h2 = await feedHash(normalizeFeedRows([tieB, reKeyed as typeof tieA, older]));
  assertEquals(h1, h2);
  const h3 = await feedHash(normalizeFeedRows([older, { ...tieA, status: 'in_progress' }, tieB]));
  assertNotEquals(h1, h3);
  const h4 = await feedHash(normalizeFeedRows([older, tieA]));
  assertNotEquals(h1, h4);
});

Deno.test('stableJson: sorted keys, fractional numbers kept, -0 → 0, undefined keys dropped, NaN refused', () => {
  assertEquals(stableJson({ b: 1, a: [2.5, { d: null, c: 'x' }], e: undefined }), '{"a":[2.5,{"c":"x","d":null}],"b":1}');
  assertEquals(stableJson(-0), '0');
  assertEquals(stableJson({ deliveryAddress: { Zip: '07436' } }), '{"deliveryAddress":{"Zip":"07436"}}');
  let threw = false;
  try { stableJson({ x: NaN }); } catch { threw = true; }
  assert(threw);
});

Deno.test('fixtures: order numbers are negative', () => {
  for (let i = 0; i < 5; i++) assert(order().order_number < 0);
  assert(fakeId().startsWith('eeeeeeee'));
});
