/**
 * CP21 — KitchenHub orders on the POS: the line mapping (khItems.ts), the feed's routing keys (never a dropped line),
 * ext_ack / ext_accept / ext_ready / ext_cancel (kh-order-action's logic via khGlue.ts, against a fake KitchenHub),
 * and pos-v1-kitchenhub-items (list with the cached menu pull, set, clear, the fallback category).
 * Every served order is read with the POS's own parser (world.ts served / referenceParse.ts).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { err, ok, R1 } from '../../pos-device/tests/harness.ts';
import { khMapContext, normalizeItemName, resolveLine, sizeStem, suggestItems, type ItemMapRow } from '../khItems.ts';
import { MENU_PULL_TTL_MS } from '../khItemsHandler.ts';
import { PENDING_STALE_MS } from '../handlers.ts';
import type { OnlineOrderWire, OnlineSettingsWire } from '../wire.ts';
import { parseOnlineOrder, settingsProblem } from './referenceParse.ts';
import { CAT_PIZZA, CAT_SIDES, ITEM_CHEESE, ITEM_KNOTS, khRow, served, world } from './world.ts';

const MIN = 60_000;
const CAT_DRINKS = 'c0000000-0000-4000-8000-0000000000c3';
const ITEM_COMBO = 'c0000000-0000-4000-8000-0000000000a3';

// ---- the fake KitchenHub ------------------------------------------------------------------------------------------

type KhCall = { method: string; path: string; body: Record<string, unknown> | null };
function fakeKitchenhub() {
  const calls: KhCall[] = [];
  const state = {
    putStatus: 200, getOrderStatus: 'accepted' as string, getTimestamps: {} as Record<string, string>, throwNext: false,
    pull: new Map<string, { status: number; items: { provider_id?: string; name: string }[] }>(),
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const khFetch = (_db: unknown, path: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (state.throwNext) {
      state.throwNext = false;
      return Promise.reject(Object.assign(new Error('network down'), { http: null }));
    }
    if (/\/status\/$/.test(path)) return Promise.resolve(state.putStatus === 200 ? json(200, {}) : json(state.putStatus, { detail: 'refused by the marketplace' }));
    if (/^\/v2\/orders\/\d+\/$/.test(path)) return Promise.resolve(json(200, { order: { status: state.getOrderStatus }, timestamps: state.getTimestamps }));
    const m = /^\/v2\/stores\/([^/]+)\/menu\/pull\?provider_id=(.+)$/.exec(path);
    if (m) {
      const p = state.pull.get(decodeURIComponent(m[2]));
      return Promise.resolve(p ? json(p.status, p.status === 200 ? { menu: {}, items: p.items } : { detail: 'x' }) : json(404, {}));
    }
    return Promise.resolve(json(404, {}));
  };
  return { calls, state, khFetch };
}

async function khWorld() {
  const w = await world({ restaurant: { dsp_orders_enabled: true } });
  const kh = fakeKitchenhub();
  w.deps.khFetch = kh.khFetch;
  w.db.insertRow('kitchenhub_stores', { restaurant_id: R1, kh_store_id: 'kh-store-1', enabled: true });
  w.db.insertRow('dsp_provider_status', { restaurant_id: R1, provider_id: 'doordash', pause_until: null });
  for (const c of [{ id: CAT_PIZZA, name: 'Pizza' }, { id: CAT_SIDES, name: 'Sides' }, { id: CAT_DRINKS, name: 'Drinks' }]) w.db.insertRow('menu_categories', { ...c, restaurant_id: R1 });
  w.db.insertRow('menu_items', { id: ITEM_CHEESE, restaurant_id: R1, category_id: CAT_PIZZA, name: 'Cheese Pizza', is_available: true });
  w.db.insertRow('menu_items', { id: ITEM_KNOTS, restaurant_id: R1, category_id: CAT_SIDES, name: 'Garlic Knots', is_available: true });
  w.db.insertRow('menu_items', { id: ITEM_COMBO, restaurant_id: R1, category_id: CAT_PIZZA, name: 'Pizza Combo', is_available: true });
  return { ...w, kh };
}
type KhW = Awaited<ReturnType<typeof khWorld>>;
const map = (w: KhW, r: Partial<ItemMapRow> & Pick<ItemMapRow, 'match_kind' | 'match_key'>) =>
  w.db.insertRow('pos_kitchenhub_item_maps', { restaurant_id: R1, provider: 'doordash', menu_item_id: null, category_id: null, label: null, ...r });
const itemsOf = async (w: KhW) => served(ok<{ orders: unknown[] }>(await w.poll()))[0].items;

// ---- khItems.ts (pure) --------------------------------------------------------------------------------------------

Deno.test('normalizeItemName: NFKC, lowercase, & → and, every non letter / digit → space, collapse, trim — nothing else', () => {
  const cases: [string, string][] = [
    ['Cheese Pizza', 'cheese pizza'], ['  CHEESE   PIZZA! ', 'cheese pizza'], ['Chicken-Parm Hero', 'chicken parm hero'],
    ['Mac & Cheese', 'mac and cheese'], ['Café Latte', 'café latte'], ['Ｃｈｅｅｓｅ', 'cheese'], ['2-Liter Coke', '2 liter coke'],
    ["Joe's Special (Large)", 'joe s special large'], ['Wings', 'wings'], ['!!!', ''],
  ];
  for (const [i, o] of cases) assertEquals(normalizeItemName(i), o, i);
});

Deno.test('sizeStem: strips ONLY an exact size word after "(…)", " - " or ", " — never a leading word, never a non-size suffix', () => {
  const cases: [string, string | null][] = [
    ['Cheese Pizza (Large)', 'cheese pizza'], ['Cheese Pizza - 16"', 'cheese pizza'], ['Cheese Pizza, Small', 'cheese pizza'],
    ['Cheese Pizza (X-Large)', 'cheese pizza'], ['Cheese Pizza - 12 inch', 'cheese pizza'], ['Cheese Pizza (Family Size)', 'cheese pizza'],
    ['Cheese Pizza Large', null], ['Large Fries', null], ['Wings (10 pc)', null], ['Cheese Pizza (Extra Cheese)', null], ['Cheese Pizza - 50"', null],
    ['(Large)', null],
  ];
  for (const [i, o] of cases) assertEquals(sizeStem(i), o, i);
});

Deno.test('resolveLine: partner_id → item_id map → name map → size-stem map → * maps → fallback → none; a gone target falls through', () => {
  const items = [{ id: ITEM_CHEESE, category_id: CAT_PIZZA }, { id: ITEM_KNOTS, category_id: CAT_SIDES }];
  const cats = [{ id: CAT_PIZZA }, { id: CAT_SIDES }, { id: CAT_DRINKS }];
  const m = (r: Partial<ItemMapRow> & Pick<ItemMapRow, 'match_kind' | 'match_key'>): ItemMapRow => ({ provider: 'doordash', menu_item_id: null, category_id: null, label: null, ...r });
  const maps = [
    m({ match_kind: 'item_id', match_key: '777', menu_item_id: ITEM_KNOTS }),
    m({ match_kind: 'name', match_key: 'large cheese pizza', menu_item_id: ITEM_CHEESE }),
    m({ match_kind: 'name', match_key: 'cheese pizza', menu_item_id: ITEM_CHEESE }),
    m({ provider: '*', match_kind: 'name', match_key: 'coke', category_id: CAT_DRINKS }),
    m({ match_kind: 'name', match_key: 'deleted thing', menu_item_id: 'd0000000-0000-4000-8000-000000000000' }),
  ];
  const ctx = khMapContext(maps, items, cats, CAT_SIDES);
  const r = (o: Partial<{ provider: string; item_id: string | null; partner_id: string | null; name: string | null }>) =>
    resolveLine(ctx, { provider: 'doordash', item_id: null, partner_id: null, name: null, ...o });
  assertEquals(r({ partner_id: ITEM_CHEESE.toUpperCase(), item_id: '777' }), { menu_item_id: ITEM_CHEESE, category_id: CAT_PIZZA, mapped: true, via: 'partner_id', map: null });
  assertEquals(r({ item_id: '777', name: 'Large Cheese Pizza' }).via, 'item_id', 'item_id beats the name');
  assertEquals([r({ name: 'LARGE cheese pizza!' }).via, r({ name: 'LARGE cheese pizza!' }).menu_item_id], ['name', ITEM_CHEESE]);
  assertEquals([r({ name: 'Cheese Pizza (Large)' }).via, r({ name: 'Cheese Pizza (Large)' }).category_id], ['name_size_stem', CAT_PIZZA]);
  assertEquals([r({ provider: 'ubereats', name: 'Coke' }).via, r({ provider: 'ubereats', name: 'Coke' }).category_id, r({ provider: 'ubereats', name: 'Coke' }).mapped], ['name', CAT_DRINKS, true]);
  assertEquals(r({ provider: 'ubereats', name: 'Cheese Pizza' }).via, 'fallback', 'a doordash map is not an ubereats map');
  assertEquals(r({ name: 'Deleted Thing' }), { menu_item_id: null, category_id: CAT_SIDES, mapped: false, via: 'fallback', map: null });
  assertEquals(r({ partner_id: 'not-a-uuid', name: 'Mystery' }).via, 'fallback');
  const none = khMapContext([], items, cats, 'f0000000-0000-4000-8000-000000000000'); // a fallback category that no longer exists
  assertEquals(resolveLine(none, { provider: 'doordash', item_id: null, partner_id: null, name: 'Mystery' }), { menu_item_id: null, category_id: null, mapped: false, via: 'none', map: null });
});

Deno.test('suggestItems: exact, then size stem, then contains (≥ 4 chars); at most 3; never applied', () => {
  const menu = [{ id: 'a', name: 'Cheese Pizza', category_id: CAT_PIZZA }, { id: 'b', name: 'Garlic Knots', category_id: CAT_SIDES }, { id: 'c', name: 'Pizza Combo', category_id: CAT_PIZZA }];
  assertEquals(suggestItems('cheese pizza', menu).map((s) => [s.menu_item_id, s.why]), [['a', 'exact']]);
  assertEquals(suggestItems('Cheese Pizza (Large)', menu).map((s) => [s.menu_item_id, s.why]), [['a', 'size_stem']]);
  assertEquals(suggestItems('Large Cheese Pizza', menu).map((s) => [s.menu_item_id, s.why]), [['a', 'contains']]);
  assertEquals(suggestItems('Soda', menu), []);
});

// ---- the feed ---------------------------------------------------------------------------------------------------

Deno.test('feed: KitchenHub lines carry the mapping (menu_item_id / category_id / mapped) + external_item; the POS still reads them', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso(), {
    items: [
      { id: '555', name: 'Large Cheese Pizza', quantity: 1 }, // doordash with an id
      { name: 'DD Exclusive Combo #3', quantity: 2 },         // no map → unmapped
      { name: 'Garlic Knots (Large)', quantity: 1 },           // size-stem name map
    ],
  });
  w.db.insertRow('external_orders', kh);
  map(w, { match_kind: 'item_id', match_key: '555', menu_item_id: ITEM_CHEESE });
  map(w, { match_kind: 'name', match_key: 'garlic knots', menu_item_id: ITEM_KNOTS });
  const items = await itemsOf(w);
  assertEquals(items.map((i) => [i.menu_item_id, i.category_id, i.mapped]), [[ITEM_CHEESE, CAT_PIZZA, true], [null, null, false], [ITEM_KNOTS, CAT_SIDES, true]]);
  assertEquals(items.map((i) => i.external_item), [
    { provider: 'doordash', item_id: '555', partner_id: null }, { provider: 'doordash', item_id: null, partner_id: null }, { provider: 'doordash', item_id: null, partner_id: null },
  ]);
  assertEquals(items.map((i) => i.item_name), ['Large Cheese Pizza', 'DD Exclusive Combo #3', 'Garlic Knots (Large)'], 'the marketplace text, verbatim');
  // the token moves when a map changes (the registers refetch and re-route)
  const t1 = ok<{ token: string }>(await w.poll()).token;
  map(w, { provider: '*', match_kind: 'name', match_key: 'dd exclusive combo 3', category_id: CAT_SIDES });
  const t2 = ok<{ token: string }>(await w.poll()).token;
  assert(t1 !== t2);
  assertEquals((await itemsOf(w))[1].category_id, CAT_SIDES);
});

Deno.test('feed: a malformed line is NEVER dropped — non-object → UNREADABLE ITEM, no name → UNKNOWN ITEM, mapped false; the fallback category routes them; print lines index them', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso(), { items: [{ name: 'Cheese Pizza' }, 'garbage', null, 42, { quantity: 3 }, { name: '   ', id: 'x1' }, ['nested']] });
  w.db.insertRow('external_orders', kh);
  let items = await itemsOf(w);
  assertEquals(items.map((i) => [i.item_name, i.quantity, i.mapped, i.category_id]), [
    ['Cheese Pizza', 1, false, null], ['UNREADABLE ITEM', 1, false, null], ['UNREADABLE ITEM', 1, false, null], ['UNREADABLE ITEM', 1, false, null],
    ['UNKNOWN ITEM', 3, false, null], ['UNKNOWN ITEM', 1, false, null], ['UNREADABLE ITEM', 1, false, null],
  ]);
  assertEquals([items[1].external_item, items[5].external_item], [null, { provider: 'doordash', item_id: 'x1', partner_id: null }]);
  // fallback: every unmapped line routes as that category, still mapped false (the register marks it UNMAPPED)
  w.online.setFlags(R1, { kitchenhub_fallback_category_id: CAT_SIDES });
  items = await itemsOf(w);
  assert(items.every((i) => i.category_id === CAT_SIDES && i.mapped === false && i.menu_item_id === null));
  // a print claim may name the unreadable line's index (the count = the served lines)
  await w.autoOn();
  ok(await w.print({ order_id: kh.id, op: 'claim', stations: [{ station: 'p-counter', name: 'Counter', lines: [0, 1, 2, 3, 4, 5, 6] }] }));
  const past = await w.print({ order_id: kh.id, op: 'claim', stations: [{ station: 'p-x', name: 'X', lines: [7] }] });
  assertEquals(err(past).code, 'invalid_payload');
  // a present non-array `items` → one unreadable line
  w.db.rows('external_orders')[0].items = { weird: true };
  assertEquals((await itemsOf(w)).map((i) => i.item_name), ['UNREADABLE ITEM']);
});

Deno.test('feed: the mapping can never fail a poll — maps table missing (117 not applied) → lines unmapped, 200; no KitchenHub rows → no mapping reads', async () => {
  const w = await khWorld();
  w.db.insertRow('external_orders', khRow(w.nowIso()));
  map(w, { match_kind: 'name', match_key: 'large cheese pizza', menu_item_id: ITEM_CHEESE });
  w.db.failReads.add('pos_kitchenhub_item_maps');
  const items = await itemsOf(w);
  assert(items.every((i) => i.mapped === false && i.category_id === null));
  assert(w.h.logs.some((l) => l.includes('online_kh_mapping_unavailable')));
  const off = await world();
  ok(await off.poll());
  assert(!off.db.calls.some(([t]) => t === 'pos_kitchenhub_item_maps' || t === 'menu_categories'));
});

Deno.test('settings: kitchenhub_fallback_category_id + capabilities.kitchenhub_item_mapping (additive); the POS parser still reads them', async () => {
  const w = await khWorld();
  const s = ok<{ settings: OnlineSettingsWire }>(await w.poll()).settings;
  assertEquals([s.kitchenhub_fallback_category_id, s.capabilities, settingsProblem(s)], [null, { kitchenhub_menu_sync: false, kitchenhub_item_mapping: true }, null]);
});

// ---- ext_ack / ext_accept / ext_ready / ext_cancel --------------------------------------------------------------

type ActBody = { result: string; order: OnlineOrderWire | null };
const readable = (o: unknown) => assertEquals(parseOnlineOrder(o).kind, 'ok');

Deno.test('ext_ack: acknowledged_at once (any status), no KitchenHub call; again → noop; the resend → duplicate; nothing else written', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  const before = structuredClone(w.db.rows('external_orders')[0]);
  const actionId = crypto.randomUUID();
  const a = ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_ack', action_id: actionId }));
  readable(a.order);
  assertEquals([a.result, a.order!.acknowledged_at], ['applied', w.nowIso()]);
  const after = w.db.rows('external_orders')[0];
  assertEquals(Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])), ['acknowledged_at']);
  assertEquals(ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_ack', action_id: actionId })).result, 'duplicate');
  w.h.clock.advance(MIN);
  assertEquals(ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_ack' })).result, 'noop');
  assertEquals(w.db.rows('external_orders')[0].acknowledged_at, a.order!.acknowledged_at, 'never moved');
  assertEquals(w.kh.calls.length, 0);
  // no khFetch configured: the ack still works (no KitchenHub call)
  const nokh = await khWorld();
  nokh.deps.khFetch = undefined;
  const k2 = khRow(nokh.nowIso());
  nokh.db.insertRow('external_orders', k2);
  assertEquals(ok<ActBody>(await nokh.action({ order_id: k2.id, action: 'ext_ack' })).result, 'applied');
  assertEquals(err(await nokh.action({ order_id: k2.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20 })).status, 501);
});

Deno.test('ext_accept → kh-order-action: PUT {status accept, prep_time} → status accepted + accepted_at + prep_time_minutes → in_progress; ext_ready → completed; resend → duplicate (one PUT)', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  const actionId = crypto.randomUUID();
  const a = ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 25, action_id: actionId }));
  readable(a.order);
  assertEquals([a.result, a.order!.status, a.order!.channel_status, a.order!.external!.prep_time_minutes], ['applied', 'in_progress', 'accepted', 25]);
  assertEquals(w.kh.calls, [{ method: 'PUT', path: `/v2/orders/${kh.kh_order_id}/status/`, body: { status: 'accept', prep_time: 25 } }]);
  const row = w.db.rows('external_orders')[0];
  assertEquals([row.status, row.accepted_at, row.prep_time_minutes, row.updated_at], ['accepted', w.nowIso(), 25, w.nowIso()]);
  assertEquals(ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 25, action_id: actionId })).result, 'duplicate');
  assertEquals(w.kh.calls.length, 1, 'never a second KitchenHub call');
  const r = ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_ready', expected_status: 'in_progress' }));
  assertEquals([r.order!.status, r.order!.channel_status, w.kh.calls[1].body], ['complete', 'completed', { status: 'complete' }]);
  assertEquals(w.db.rows('external_orders')[0].completed_at, w.nowIso());
});

Deno.test('ext_cancel: only while new → PUT {status cancel} → cancelled, cancelled_by restaurant; after accept → 400 (no KitchenHub call)', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  const kh2 = khRow(w.nowIso(), { status: 'accepted' });
  w.db.insertRow('external_orders', kh);
  w.db.insertRow('external_orders', kh2);
  const c = ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_cancel', expected_status: 'new' }));
  assertEquals([c.order!.status, c.order!.cancelled_by, w.kh.calls[0].body], ['cancelled', 'restaurant', { status: 'cancel' }]);
  const late = await w.action({ order_id: kh2.id, action: 'ext_cancel', expected_status: 'in_progress' });
  assertEquals([err(late).status, err(late).code, err(late).message], [400, 'action_not_allowed', 'a marketplace order can only be cancelled while it is new']);
  assertEquals(w.kh.calls.length, 1);
});

Deno.test('ext_*: compare-and-set 409 + the order; wrong status 400; prep 1–240; store not enabled 400; all before any KitchenHub call', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  const conflict = await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'in_progress', prep_minutes: 20 });
  assertEquals([conflict.status, err(conflict).code], [409, 'status_conflict']);
  readable((conflict.body as { error: { order: unknown } }).error.order);
  assertEquals(err(await w.action({ order_id: kh.id, action: 'ext_ready', expected_status: 'new' })).code, 'action_not_allowed');
  for (const p of [0, 241, 20.5, null, '20']) assertEquals(err(await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: p })).code, 'invalid_payload', String(p));
  assertEquals(err(await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: null, prep_minutes: 20 })).code, 'invalid_payload', 'expected_status required');
  w.db.rows('kitchenhub_stores')[0].enabled = false;
  const gate = await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20 });
  assertEquals([err(gate).code, err(gate).message], ['action_not_allowed', 'DSP order actions are not enabled for this store']);
  assertEquals(w.kh.calls.length, 0);
  assertEquals(w.db.rows('external_orders')[0].status, 'new');
});

Deno.test('ext_*: KitchenHub refuses → 502 kitchenhub_failed (403 not_main_account / else kitchenhub_error), nothing changed, the error STORED; 409 → GET + sync (target → applied, else 409)', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  w.kh.state.putStatus = 403;
  const id403 = crypto.randomUUID();
  const r403 = await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20, action_id: id403 });
  assertEquals([r403.status, err(r403).code, (r403.body as { error: { reason: string } }).error.reason], [502, 'kitchenhub_failed', 'not_main_account']);
  assertEquals(err(r403).message, 'This provider is connected elsewhere (read-only). Disconnect the provider tablet or other integration.');
  const replay = await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20, action_id: id403 });
  assertEquals([replay.status, (replay.body as { error: { reason: string } }).error.reason, w.kh.calls.length], [502, 'not_main_account', 1]);
  w.kh.state.putStatus = 500;
  const r500 = await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20 });
  assertEquals([err(r500).code, (r500.body as { error: { reason: string } }).error.reason, err(r500).message], ['kitchenhub_failed', 'kitchenhub_error', 'DoorDash did not accept the update (HTTP 500)']);
  w.kh.state.throwNext = true;
  assertEquals((await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20 })).status, 502);
  assertEquals(w.db.rows('external_orders')[0].status, 'new', 'nothing changed');
  // 409: KitchenHub already has it accepted (the marketplace tablet did it) → synced → applied
  w.kh.state.putStatus = 409;
  w.kh.state.getOrderStatus = 'accepted';
  w.kh.state.getTimestamps = { accepted_at: '2026-11-24T15:00:00.000Z' };
  const synced = ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20 }));
  assertEquals([synced.result, synced.order!.status, w.db.rows('external_orders')[0].accepted_at], ['applied', 'in_progress', '2026-11-24T15:00:00.000Z']);
  // 409 and KitchenHub has it cancelled → 409 status_conflict, the row synced
  const kh2 = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh2);
  w.kh.state.getOrderStatus = 'cancelled';
  const c = await w.action({ order_id: kh2.id, action: 'ext_accept', expected_status: 'new', prep_minutes: 20 });
  assertEquals([c.status, err(c).code, err(c).message], [409, 'status_conflict', 'DoorDash already has this order as cancelled']);
  assertEquals((c.body as { error: { order: OnlineOrderWire } }).error.order.status, 'cancelled');
});

Deno.test('ext_*: a pending action → 503 action_pending; stale → re-run (safe: KitchenHub 409 → sync)', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  const actionId = crypto.randomUUID();
  const body = { action_id: actionId, restaurant_id: R1, order_id: kh.id, action: 'ext_accept', expected_status: 'new', quoted_ready_minutes: null, prep_minutes: 20, amount_cents: null, adjustment_type: null, accepted_quote_id: null, reason: null, approver_staff_id: null, actor_staff_id: 'register' };
  await w.online.beginAction({ actionId, fn: 'order_action', restaurantId: R1, deviceId: w.A.device_id, channel: 'kitchenhub', orderId: kh.id, action: 'ext_accept', request: body, actor: 'register', approver: null, deviceTime: null });
  assertEquals((await w.action(body)).status, 503);
  w.h.clock.advance(PENDING_STALE_MS);
  assertEquals(ok<ActBody>(await w.action(body)).result, 'applied');
  assert(w.h.logs.some((l) => l.includes('online_kh_action_rerun')));
});

Deno.test('ext_* answers carry the same mapping as the feed (an action never re-routes a line)', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso());
  w.db.insertRow('external_orders', kh);
  map(w, { match_kind: 'name', match_key: 'large cheese pizza', menu_item_id: ITEM_CHEESE });
  const a = ok<ActBody>(await w.action({ order_id: kh.id, action: 'ext_ack' }));
  assertEquals(a.order!.items.map((i) => i.category_id), (await itemsOf(w)).map((i) => i.category_id));
  assertEquals(a.order!.items[0].category_id, CAT_PIZZA);
});

// ---- pos-v1-kitchenhub-items -----------------------------------------------------------------------------------

type ListBody = {
  entries: { provider: string; name: string; name_key: string; item_ids: string[]; seen_count: number; on_marketplace_menu: boolean; resolved: { via: string; mapped: boolean; menu_item_id: string | null; category_id: string | null; map: unknown }; suggestions: { menu_item_id: string; why: string }[] }[];
  maps: { provider: string; kind: string; key: string; target_exists: boolean }[]; fallback_category_id: string | null;
  menu_pull: { status: string; pulled_at: string | null; providers: { provider: string; ok: boolean; items: number }[] };
};

Deno.test('list: seen-in-orders (30 days) merged with the marketplace menu pull; resolution + suggestions; the pull cached ≥ 5 min', async () => {
  const w = await khWorld();
  w.db.insertRow('external_orders', khRow(w.nowIso(), { items: [{ id: '555', name: 'Cheese Pizza' }, { name: 'Cheese Pizza' }, { name: 'Soda' }] }));
  w.db.insertRow('external_orders', khRow(new Date(w.h.clock.now() - 31 * 86_400_000).toISOString(), { items: [{ name: 'Ancient Item' }] }));
  w.kh.state.pull.set('doordash', { status: 200, items: [{ provider_id: 'm1', name: 'Garlic Knots' }, { provider_id: 'm2', name: 'Cheese Pizza' }] });
  const l = ok<ListBody>(await w.items({ op: 'list' }));
  const byName = Object.fromEntries(l.entries.map((e) => [e.name_key, e]));
  assertEquals(Object.keys(byName).sort(), ['cheese pizza', 'garlic knots', 'soda'], 'older than 30 days is not listed');
  assertEquals([byName['cheese pizza'].seen_count, byName['cheese pizza'].item_ids, byName['cheese pizza'].on_marketplace_menu], [2, ['555'], true]);
  assertEquals([byName['garlic knots'].seen_count, byName['garlic knots'].on_marketplace_menu], [0, true]);
  assertEquals(byName['cheese pizza'].suggestions.map((s) => [s.menu_item_id, s.why]), [[ITEM_CHEESE, 'exact']]);
  assertEquals(byName['cheese pizza'].resolved, { via: 'none', mapped: false, menu_item_id: null, category_id: null, map: null }, 'a suggestion is never applied');
  assertEquals([l.menu_pull.status, l.menu_pull.providers], ['pulled', [{ provider: 'doordash', ok: true, items: 2 }]]);
  assertEquals(w.kh.calls.map((c) => c.path), ['/v2/stores/kh-store-1/menu/pull?provider_id=doordash']);
  w.h.clock.advance(MENU_PULL_TTL_MS - 1);
  assertEquals(ok<ListBody>(await w.items({ op: 'list' })).menu_pull.status, 'cached');
  assertEquals(w.kh.calls.length, 1, 'cached');
  w.h.clock.advance(2);
  assertEquals(ok<ListBody>(await w.items({ op: 'list' })).menu_pull.status, 'pulled');
  assertEquals(w.kh.calls.length, 2);
});

Deno.test('list: a pull failure → seen-in-orders only, never an error (cached 60 s); no store / no KitchenHub client → seen only', async () => {
  const w = await khWorld();
  w.db.insertRow('external_orders', khRow(w.nowIso(), { items: [{ name: 'Soda' }] }));
  w.kh.state.pull.set('doordash', { status: 500, items: [] });
  const l = ok<ListBody>(await w.items({ op: 'list' }));
  assertEquals([l.menu_pull.status, l.entries.map((e) => e.name_key)], ['failed', ['soda']]);
  w.h.clock.advance(30_000);
  assertEquals(ok<ListBody>(await w.items({ op: 'list' })).menu_pull.status, 'cached');
  w.h.clock.advance(31_000);
  ok(await w.items({ op: 'list' }));
  assertEquals(w.kh.calls.length, 2, 'retried after 60 s');
  w.kh.state.pull.set('doordash', { status: 200, items: [] });
  w.kh.state.throwNext = true;
  w.h.clock.advance(61_000);
  assertEquals(ok<ListBody>(await w.items({ op: 'list' })).menu_pull.status, 'failed');
  const nostore = await khWorld();
  nostore.db.rows('kitchenhub_stores').length = 0;
  assertEquals(ok<ListBody>(await nostore.items({ op: 'list' })).menu_pull.status, 'no_store');
  const noclient = await khWorld();
  noclient.deps.khFetch = undefined;
  assertEquals(ok<ListBody>(await noclient.items({ op: 'list' })).menu_pull.status, 'not_configured');
});

Deno.test('set / clear: a name map (stored normalized) → the feed routes the line; same again → noop; resend → duplicate; another body → 409; clear → unmapped', async () => {
  const w = await khWorld();
  const kh = khRow(w.nowIso(), { items: [{ name: 'Large Cheese Pizza!' }] });
  w.db.insertRow('external_orders', kh);
  const actionId = crypto.randomUUID();
  const set = { op: 'set', action_id: actionId, key: { kind: 'name', provider: 'DoorDash', value: '  Large  Cheese Pizza ' }, menu_item_id: ITEM_CHEESE };
  const s1 = ok<{ result: string; map: Record<string, unknown> }>(await w.items(set));
  assertEquals([s1.result, s1.map.provider, s1.map.kind, s1.map.key, s1.map.label, s1.map.menu_item_id], ['applied', 'doordash', 'name', 'large cheese pizza', 'Large  Cheese Pizza', ITEM_CHEESE]);
  assertEquals((await itemsOf(w))[0].category_id, CAT_PIZZA);
  assertEquals(ok<{ result: string }>(await w.items(set)).result, 'duplicate');
  assertEquals(err(await w.items({ ...set, menu_item_id: ITEM_KNOTS })).code, 'action_id_reused');
  assertEquals(ok<{ result: string }>(await w.items({ ...set, action_id: crypto.randomUUID() })).result, 'noop');
  // re-point to a category
  assertEquals(ok<{ result: string }>(await w.items({ ...set, action_id: crypto.randomUUID(), menu_item_id: null, category_id: CAT_DRINKS })).result, 'applied');
  assertEquals((await itemsOf(w))[0].category_id, CAT_DRINKS);
  const c = ok<{ result: string; map: unknown }>(await w.items({ op: 'clear', action_id: crypto.randomUUID(), key: set.key }));
  assertEquals([c.result, c.map], ['applied', null]);
  assertEquals((await itemsOf(w))[0].mapped, false);
  assertEquals(ok<{ result: string }>(await w.items({ op: 'clear', action_id: crypto.randomUUID(), key: set.key })).result, 'noop');
  const l = ok<ListBody>(await w.items({ op: 'list' }));
  assertEquals(l.maps, []);
});

Deno.test('set: the fallback category (settings carry it; unmapped lines route as it, mapped false); clear → null', async () => {
  const w = await khWorld();
  w.db.insertRow('external_orders', khRow(w.nowIso(), { items: [{ name: 'Mystery Box' }] }));
  const f = ok<{ result: string; fallback_category_id: string | null }>(await w.items({ op: 'set', action_id: crypto.randomUUID(), key: { kind: 'fallback' }, category_id: CAT_SIDES }));
  assertEquals([f.result, f.fallback_category_id], ['applied', CAT_SIDES]);
  const p = ok<{ settings: OnlineSettingsWire; orders: OnlineOrderWire[] }>(await w.poll());
  assertEquals([p.settings.kitchenhub_fallback_category_id, p.orders[0].items[0].category_id, p.orders[0].items[0].mapped], [CAT_SIDES, CAT_SIDES, false]);
  const c = ok<{ result: string; fallback_category_id: string | null }>(await w.items({ op: 'clear', action_id: crypto.randomUUID(), key: { kind: 'fallback' } }));
  assertEquals([c.result, c.fallback_category_id], ['applied', null]);
});

Deno.test('set: validation — op, action_id, provider, value, targets (exactly one; the fallback a category), not on the menu → 404; another restaurant / inactive register', async () => {
  const w = await khWorld();
  const base = { op: 'set', action_id: crypto.randomUUID(), key: { kind: 'name', provider: 'doordash', value: 'Soda' }, menu_item_id: ITEM_CHEESE };
  assertEquals(err(await w.items({ op: 'nope' })).code, 'invalid_payload');
  assertEquals(err(await w.items({ ...base, action_id: 'x' })).code, 'invalid_payload');
  assertEquals(err(await w.items({ ...base, key: { kind: 'name', provider: 'Door Dash!', value: 'Soda' } })).code, 'invalid_payload');
  assertEquals(err(await w.items({ ...base, key: { kind: 'name', provider: 'doordash', value: '!!!' } })).code, 'invalid_payload');
  assertEquals(err(await w.items({ ...base, key: { kind: 'plu', provider: 'doordash', value: 'x' } })).code, 'invalid_payload');
  assertEquals(err(await w.items({ ...base, category_id: CAT_PIZZA })).code, 'invalid_payload', 'both targets');
  assertEquals(err(await w.items({ ...base, menu_item_id: null })).code, 'invalid_payload', 'no target');
  assertEquals(err(await w.items({ ...base, key: { kind: 'fallback' } })).code, 'invalid_payload', 'the fallback is a category');
  assertEquals(err(await w.items({ ...base, menu_item_id: 'd0000000-0000-4000-8000-000000000000' })).code, 'item_not_found');
  assertEquals(err(await w.items({ ...base, menu_item_id: null, category_id: 'd0000000-0000-4000-8000-000000000000' })).code, 'category_not_found');
  assertEquals(err(await w.items({ ...base, restaurant_id: 'd0000000-0000-4000-8000-000000000000' })).code, 'restaurant_mismatch');
  w.online.devices.get(w.A.device_id)!.status = 'revoked';
  assertEquals(err(await w.items(base)).status, 403);
  assertEquals(w.db.rows('pos_kitchenhub_item_maps').length, 0);
});

Deno.test('PgOnlineStore.kitchenhubMapChange: RPC + argument names match 117', async () => {
  const { PgOnlineStore } = await import('../store.ts');
  const calls: [string, string[]][] = [];
  const pg = new PgOnlineStore({ rpc: (fn: string, args: Record<string, unknown>) => (calls.push([fn, Object.keys(args)]), Promise.resolve({ data: { outcome: 'applied' }, error: null })), from: () => ({}) });
  await pg.kitchenhubMapChange({ actionId: 'a', restaurantId: R1, deviceId: 'd', op: 'set', kind: 'name', provider: 'doordash', key: 'x', menuItemId: ITEM_CHEESE, categoryId: null, label: 'X', request: {}, actor: null, approver: null, deviceTime: null });
  assertEquals(calls, [['pos_kitchenhub_item_map_change', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_op', 'p_kind', 'p_provider', 'p_key', 'p_menu_item_id', 'p_category_id', 'p_label', 'p_request', 'p_actor', 'p_approver', 'p_device_time']]]);
});

// ---- the mapping cache (CP21 follow-up) --------------------------------------------------------------------------

Deno.test('KhContextCache: 30 s per restaurant + revision; one in-flight build; a failure cached 30 s and logged once', async () => {
  const { KhContextCache, KH_CONTEXT_TTL_MS } = await import('../khContextCache.ts');
  const c = new KhContextCache();
  const logs: string[] = [];
  const log = (e: string) => void logs.push(e);
  let loads = 0;
  let fail = false;
  const load = () => {
    loads++;
    return fail ? Promise.reject(new Error('relation "public.pos_kitchenhub_item_maps" does not exist')) : Promise.resolve({ maps: [], items: [], categories: [{ id: `v${loads}` }] });
  };
  const [a, b] = await Promise.all([c.get(R1, 0, 0, load, log), c.get(R1, 0, 0, load, log)]);
  assertEquals([loads, a === b], [1, true], 'concurrent misses share one build');
  await c.get(R1, 0, KH_CONTEXT_TTL_MS - 1, load, log);
  assertEquals(loads, 1, 'hit');
  assertEquals((await c.get(R1, 1, KH_CONTEXT_TTL_MS - 1, load, log))!.categories, [{ id: 'v2' }], 'a new revision rebuilds at once');
  await c.get(R1, 1, 2 * KH_CONTEXT_TTL_MS, load, log);
  assertEquals(loads, 3, 'expired');
  fail = true;
  const t0 = 3 * KH_CONTEXT_TTL_MS;
  assertEquals(await c.get(R1, 1, t0, load, log), null);
  for (const dt of [1, 1000, KH_CONTEXT_TTL_MS - 1]) assertEquals(await c.get(R1, 2, t0 + dt, load, log), null);
  assertEquals([loads, logs.length], [4, 1], 'failure remembered 30 s (even across a revision), logged once');
  await c.get(R1, 2, t0 + KH_CONTEXT_TTL_MS, load, log);
  assertEquals([loads, logs.length], [5, 2]);
  fail = false;
  assertEquals((await c.get(R1, 2, t0 + 2 * KH_CONTEXT_TTL_MS, load, log))!.categories, [{ id: 'v6' }], 'recovers');
});

Deno.test('feed with the cache: a hit makes no mapping reads; a set / clear via pos-v1-kitchenhub-items shows on the NEXT poll (maps revision); a noop does not rebuild', async () => {
  const { KhContextCache } = await import('../khContextCache.ts');
  const w = await khWorld();
  const cache = new KhContextCache();
  w.deps.khContext = cache;
  w.db.insertRow('external_orders', khRow(w.nowIso(), { items: [{ name: 'Mystery Box' }] }));
  const mapReads = () => w.db.calls.filter(([t, op]) => (t === 'pos_kitchenhub_item_maps' || t === 'menu_items' || t === 'menu_categories') && op === 'select').length;
  assertEquals((await itemsOf(w))[0].mapped, false);
  const r1 = mapReads();
  assertEquals([cache.builds, r1], [1, 3]);
  await itemsOf(w);
  assertEquals([cache.builds, mapReads()], [1, r1], 'hit: 0 mapping reads');
  const key = { kind: 'name', provider: 'doordash', value: 'Mystery Box' };
  ok(await w.items({ op: 'set', action_id: crypto.randomUUID(), key, menu_item_id: ITEM_KNOTS }));
  assertEquals((await itemsOf(w))[0].category_id, CAT_SIDES, 'the next poll, not 30 s later');
  assertEquals(cache.builds, 2);
  ok(await w.items({ op: 'set', action_id: crypto.randomUUID(), key, menu_item_id: ITEM_KNOTS })); // noop: no revision bump
  await itemsOf(w);
  assertEquals(cache.builds, 2);
  ok(await w.items({ op: 'clear', action_id: crypto.randomUUID(), key }));
  assertEquals((await itemsOf(w))[0].mapped, false, 'a clear shows on the next poll too');
  // the fallback is not cached (fresh settings every poll)
  ok(await w.items({ op: 'set', action_id: crypto.randomUUID(), key: { kind: 'fallback' }, category_id: CAT_DRINKS }));
  const builds = cache.builds;
  assertEquals((await itemsOf(w))[0].category_id, CAT_DRINKS);
  assertEquals(cache.builds, builds);
});

Deno.test('feed with the cache, 117 not applied: polls stay 200, lines unmapped, the read failure logged once per 30 s (not per poll)', async () => {
  const { KhContextCache, KH_CONTEXT_TTL_MS } = await import('../khContextCache.ts');
  const w = await khWorld();
  w.deps.khContext = new KhContextCache();
  w.db.insertRow('external_orders', khRow(w.nowIso()));
  w.db.failReads.add('pos_kitchenhub_item_maps');
  const logged = () => w.h.logs.filter((l) => l.includes('online_kh_mapping_unavailable')).length;
  for (let i = 0; i < 5; i++) {
    assert((await itemsOf(w)).every((it) => !it.mapped && it.category_id === null));
    w.h.clock.advance(5_000);
  }
  assertEquals(logged(), 1);
  w.h.clock.advance(KH_CONTEXT_TTL_MS);
  await itemsOf(w);
  assertEquals(logged(), 2);
});

Deno.test('PgOnlineStore.getSettings: kitchenhub_maps_rev (bigint as number or string; absent before 117 → 0)', async () => {
  const { PgOnlineStore } = await import('../store.ts');
  let row: Record<string, unknown> = { restaurant_id: R1, print_register_device_id: null, pos_online_orders_enabled: true };
  // deno-lint-ignore no-explicit-any
  const q: any = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: row, error: null }) };
  const pg = new PgOnlineStore({ rpc: () => Promise.resolve({ data: null, error: null }), from: () => q });
  assertEquals((await pg.getSettings(R1))!.kitchenhub_maps_rev, 0);
  row = { ...row, kitchenhub_maps_rev: '7' };
  assertEquals((await pg.getSettings(R1))!.kitchenhub_maps_rev, 7);
  row = { ...row, kitchenhub_maps_rev: 8 };
  assertEquals((await pg.getSettings(R1))!.kitchenhub_maps_rev, 8);
});
