/**
 * pos-v1-online-settings (CP18) end to end over the device middleware, MemoryOnlineStore (= 111
 * pos_online_settings_change) and the in-memory PostgREST. Ported from the reference (ordr-pos @ 86c558d):
 *   test/online/settings.test.ts :108-152 (lost answer → noop, same action_id → duplicate, the audit has actor +
 *   approver, pause → 400), :237-249 (malformed → 400; the print flags write pos_restaurant_settings only, both
 *   default off), src/dev/onlineSettingsRules.ts :51-85, test/support/fakeOnline.ts settingsChange :331-350.
 *   :154-182 (estimates whole minutes 1–240; delivery off writes restaurants.delivery_available ONLY), :183-235
 *   (86 an item → menu_items.is_available, a new snapshot hash in the answer; 86 twice = noop with the same hash;
 *   an item not on the menu → 404 item_not_found, nothing changes).
 * CP18: the POS-only settings (print register + the two auto-print flags, 111). CP18b: the web tablet's own
 * (estimates / delivery_available / item_availability, 112) — the tablet's exact columns, nothing more. Every
 * settings answer is read with the POS's own settingsProblem (referenceParse.ts).
 */
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { err, ok, R1, R2 } from '../../pos-device/tests/harness.ts';
import { buildMenuSnapshot } from '../../pos-sync/menuSnapshot.ts';
import type { OnlineSettingsWire } from '../wire.ts';
import { settingsProblem } from './referenceParse.ts';
import { snapshotDbOf, ordrRow, world } from './world.ts';

type Body = { result: string; settings: OnlineSettingsWire; menu_snapshot_hash: string | null; server_time: string };
const okBody = (r: Parameters<typeof ok>[0]): Body => {
  const b = ok<Body>(r);
  assertEquals(Object.keys(b).sort(), ['menu_snapshot_hash', 'result', 'server_time', 'settings']);
  assertEquals(settingsProblem(b.settings), null, 'the POS reads the settings');
  return b;
};
/** The columns that changed on a row. */
function changed(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}
const CAT = 'c0000000-0000-4000-8000-0000000000c1';
const KNOTS = 'c0000000-0000-4000-8000-0000000000a2';
const CHEESE = 'c0000000-0000-4000-8000-0000000000a1';
const THEIRS = 'c0000000-0000-4000-8000-0000000000f9';
function menu(w: Awaited<ReturnType<typeof world>>) {
  w.db.insertRow('menu_categories', { id: CAT, restaurant_id: R1, name: 'Pizza', sort_order: 0 });
  w.db.insertRow('menu_items', { id: CHEESE, restaurant_id: R1, category_id: CAT, name: 'Cheese Pizza', is_available: true, sort_order: 0, featured_on_website: false });
  w.db.insertRow('menu_items', { id: KNOTS, restaurant_id: R1, category_id: CAT, name: 'Garlic Knots', is_available: true, sort_order: 1, featured_on_website: false });
  w.db.insertRow('menu_items', { id: THEIRS, restaurant_id: R2, category_id: CAT, name: 'Elsewhere', is_available: true, sort_order: 0, featured_on_website: false });
}
const item = (w: Awaited<ReturnType<typeof world>>, id: string) => w.db.rows('menu_items').find((m) => m.id === id)!;
const rest = (w: Awaited<ReturnType<typeof world>>) => w.db.rows('restaurants').find((r) => r.id === R1)!;

Deno.test('both flags default off; on → applied (pos_restaurant_settings only), on again → noop; the settings come back with a new hash', async () => {
  const w = await world();
  const restaurantBefore = structuredClone(w.db.rows('restaurants'));
  const first = okBody(await w.settings({ kind: 'online_auto_print', on: true }));
  assertEquals([first.result, first.settings.online_auto_print_enabled, first.settings.kitchenhub_auto_print_enabled], ['applied', true, false]);
  const again = okBody(await w.settings({ kind: 'online_auto_print', on: true }));
  assertEquals([again.result, again.settings.hash], ['noop', first.settings.hash]);
  const kh = okBody(await w.settings({ kind: 'kitchenhub_auto_print', on: true }));
  assertEquals([kh.result, kh.settings.kitchenhub_auto_print_enabled], ['applied', true]);
  assertNotEquals(kh.settings.hash, first.settings.hash);
  assertEquals(okBody(await w.settings({ kind: 'online_auto_print', on: false })).settings.online_auto_print_enabled, false);
  assertEquals(w.db.rows('restaurants'), restaurantBefore, 'no tablet column touched');
  assertEquals(w.db.calls.filter(([, op]) => op === 'update' || op === 'insert'), []);
  const s = w.online.settings.get(R1)!;
  assertEquals([s.online_auto_print_enabled, s.kitchenhub_auto_print_enabled, s.updated_by], [false, true, 'register']);
});

Deno.test('the print register: an active register of this restaurant (or null); the feed serves it as online_print_device_id', async () => {
  const w = await world();
  const set = okBody(await w.settings({ kind: 'online_print_device', device_id: w.B.device_id }));
  assertEquals([set.result, set.settings.online_print_device_id], ['applied', w.B.device_id]);
  assertEquals(okBody(await w.settings({ kind: 'online_print_device', device_id: w.B.device_id })).result, 'noop');
  assertEquals((ok<{ settings: OnlineSettingsWire }>(await w.poll())).settings.online_print_device_id, w.B.device_id);
  // another restaurant's register / an unknown one / a revoked one → 400, nothing changes
  assertEquals(err(await w.settings({ kind: 'online_print_device', device_id: w.X.device_id })).code, 'invalid_payload');
  assertEquals(err(await w.settings({ kind: 'online_print_device', device_id: crypto.randomUUID() })).code, 'invalid_payload');
  w.online.devices.set(w.A.device_id, { id: w.A.device_id, restaurant_id: R1, status: 'revoked' });
  assertEquals(err(await w.settings({ kind: 'online_print_device', device_id: w.A.device_id }, {}, w.B)).code, 'invalid_payload');
  assertEquals(w.online.settings.get(R1)!.print_register_device_id, w.B.device_id);
  const off = okBody(await w.settings({ kind: 'online_print_device', device_id: null }, {}, w.B));
  assertEquals([off.result, off.settings.online_print_device_id], ['applied', null]);
  // nothing set yet + null → noop (no row = every default)
  const fresh = await world();
  assertEquals(okBody(await fresh.settings({ kind: 'online_print_device', device_id: null })).result, 'noop');
});

Deno.test('a lost answer: the same action_id again → duplicate; tapping again (a new id) → noop; another body → 409; the audit has actor + approver', async () => {
  const w = await world();
  const sam = crypto.randomUUID();
  const maria = crypto.randomUUID();
  const id = crypto.randomUUID();
  const body = { action_id: id, actor_staff_id: sam, approver_staff_id: maria };
  assertEquals(okBody(await w.settings({ kind: 'kitchenhub_auto_print', on: true }, { ...body, device_time: '2026-11-19T17:00:00.000Z' })).result, 'applied');
  const dup = okBody(await w.settings({ kind: 'kitchenhub_auto_print', on: true }, { ...body, device_time: '2026-11-19T17:00:09.000Z' }));
  assertEquals([dup.result, dup.settings.kitchenhub_auto_print_enabled], ['duplicate', true]);
  assertEquals(okBody(await w.settings({ kind: 'kitchenhub_auto_print', on: true })).result, 'noop');
  assertEquals(err(await w.settings({ kind: 'kitchenhub_auto_print', on: false }, body)).code, 'action_id_reused');
  const a = w.online.actions.get(id)!;
  assertEquals([a.fn, a.action, a.order_id, a.outcome, a.actor, a.approver, a.device_time], ['settings', 'kitchenhub_auto_print', null, 'applied', sam, maria, '2026-11-19T17:00:00.000Z']);
  assertEquals(w.online.settings.get(R1)!.updated_by, sam, 'updated_by = the actor');
  assertEquals([...w.online.actions.values()].map((x) => x.outcome), ['applied', 'noop']);
});

Deno.test('malformed / unknown changes → 400 like the reference (settings.test.ts :240 + every kind); nothing written', async () => {
  const w = await world();
  menu(w);
  const before = structuredClone(rest(w));
  for (const c of [
    null, 'x', [], { kind: 'nope' }, { kind: 'pause' }, { kind: 'unpause' }, // :240
    { kind: 'delivery_available', on: 'yes' }, { kind: 'item_availability', item_id: 7, available: false }, { kind: 'estimates', estimated_pickup_minutes: 30 },
    { kind: 'online_auto_print', on: 1 }, // :240
    { kind: 'estimates', estimated_pickup_minutes: 0, estimated_delivery_minutes: 45 }, { kind: 'estimates', estimated_pickup_minutes: 20, estimated_delivery_minutes: 241 },
    { kind: 'estimates', estimated_pickup_minutes: 20.5, estimated_delivery_minutes: 45 }, { kind: 'estimates', estimated_pickup_minutes: '20', estimated_delivery_minutes: 45 },
    { kind: 'delivery_available' }, { kind: 'item_availability', item_id: KNOTS }, { kind: 'item_availability', item_id: KNOTS, available: 'no' },
    { kind: 'kitchenhub_auto_print' }, { kind: 'online_print_device', device_id: 7 }, { kind: 'online_print_device', device_id: 'reg-1' },
  ]) assertEquals(err(await w.settings(c)).code, 'invalid_payload', JSON.stringify(c));
  assertEquals(err(await w.settings({ kind: 'online_auto_print', on: true }, { restaurant_id: R2 })).code, 'restaurant_mismatch');
  assertEquals(err(await w.settings({ kind: 'delivery_available', on: false }, { action_id: 'x' })).code, 'invalid_payload');
  assertEquals(err(await w.settings({ kind: 'delivery_available', on: false }, { actor_staff_id: 'Sam' })).code, 'invalid_payload');
  assertEquals(w.online.actions.size, 0);
  assertEquals(w.online.settings.get(R1), undefined, 'nothing written');
  assertEquals(rest(w), before);
  assertEquals(item(w, KNOTS).is_available, true);
});

// ---- the web tablet's own settings (112) ----------------------------------------------------------------------

Deno.test('estimates: whole minutes 1–240 → restaurants.estimated_pickup_minutes / estimated_delivery_minutes ONLY (SettingsTab :414-421); again → noop', async () => {
  const w = await world();
  const before = structuredClone(rest(w));
  const b = okBody(await w.settings({ kind: 'estimates', estimated_pickup_minutes: 25, estimated_delivery_minutes: 50 }));
  assertEquals([b.result, b.settings.estimated_pickup_minutes, b.settings.estimated_delivery_minutes, b.menu_snapshot_hash], ['applied', 25, 50, null]);
  assertEquals(changed(before, rest(w)), ['estimated_delivery_minutes', 'estimated_pickup_minutes'], 'utensils_option_enabled etc. untouched');
  const again = okBody(await w.settings({ kind: 'estimates', estimated_pickup_minutes: 25, estimated_delivery_minutes: 50 }));
  assertEquals([again.result, again.settings.hash], ['noop', b.settings.hash]);
  for (const [p, d] of [[1, 240], [240, 1]]) assertEquals(okBody(await w.settings({ kind: 'estimates', estimated_pickup_minutes: p, estimated_delivery_minutes: d })).result, 'applied');
  assertEquals([rest(w).estimated_pickup_minutes, rest(w).estimated_delivery_minutes], [240, 1]);
});

Deno.test('delivery off writes restaurants.delivery_available ONLY (OrdersTab toggleDelivery :1873-1878) — absolute: off twice = noop; back on', async () => {
  const w = await world();
  const before = structuredClone(rest(w));
  const off = okBody(await w.settings({ kind: 'delivery_available', on: false }));
  assertEquals([off.result, off.settings.delivery_available, off.menu_snapshot_hash], ['applied', false, null]);
  assertEquals(changed(before, rest(w)), ['delivery_available']);
  assertEquals(okBody(await w.settings({ kind: 'delivery_available', on: false })).result, 'noop');
  assertEquals(okBody(await w.settings({ kind: 'delivery_available', on: true })).settings.delivery_available, true);
  assertEquals(w.db.rows('orders'), [], 'no checkout enforcement / nothing else');
});

Deno.test('86 an item: menu_items.is_available ONLY (MenuTab :81-84) → the answer carries the NEW snapshot hash; 86 twice = noop, same hash; back on = the old hash', async () => {
  const w = await world();
  menu(w);
  const snap = () => buildMenuSnapshot(snapshotDbOf(w), R1, new Date(w.h.clock.now()));
  const h0 = (await snap()).hash;
  const before = structuredClone(item(w, KNOTS));
  const off = okBody(await w.settings({ kind: 'item_availability', item_id: KNOTS, available: false }));
  assertEquals(off.result, 'applied');
  assertEquals(changed(before, item(w, KNOTS)), ['is_available']);
  assertEquals(item(w, CHEESE).is_available, true);
  const s1 = await snap();
  assertEquals(off.menu_snapshot_hash, s1.hash);
  assertNotEquals(s1.hash, h0);
  assertEquals(s1.items.find((i) => i.id === KNOTS)!.is_available, false, 'the register that pulls it can no longer sell it');
  const twice = okBody(await w.settings({ kind: 'item_availability', item_id: KNOTS, available: false }));
  assertEquals([twice.result, twice.menu_snapshot_hash], ['noop', s1.hash]);
  const on = okBody(await w.settings({ kind: 'item_availability', item_id: KNOTS.toUpperCase(), available: true }));
  assertEquals([on.result, on.menu_snapshot_hash], ['applied', h0]);
});

Deno.test('86: an item not on the current menu (another restaurant\'s / unknown / not an id) → 404 item_not_found, nothing changes; no snapshot → hash null', async () => {
  const w = await world();
  menu(w);
  for (const id of [THEIRS, crypto.randomUUID(), 'knots']) {
    assertEquals(err(await w.settings({ kind: 'item_availability', item_id: id, available: false })), { status: 404, code: 'item_not_found', message: 'no such item on the current menu' });
  }
  assertEquals(item(w, THEIRS).is_available, true);
  assertEquals(w.online.actions.size, 0);
  // the menu does not build (a bad timezone) → the change stands, menu_snapshot_hash null (the next pull picks it up)
  w.deps.snapshotDb = { ...snapshotDbOf(w), getRestaurant: () => Promise.resolve(null) };
  const b = okBody(await w.settings({ kind: 'item_availability', item_id: KNOTS, available: false }));
  assertEquals([b.result, b.menu_snapshot_hash, item(w, KNOTS).is_available], ['applied', null, false]);
});

Deno.test('tablet settings: same action_id → duplicate; another body → 409; actor + approver in pos_online_actions; a revoked register → 403', async () => {
  const w = await world();
  menu(w);
  const sam = crypto.randomUUID();
  const maria = crypto.randomUUID();
  const id = crypto.randomUUID();
  const body = { action_id: id, actor_staff_id: sam, approver_staff_id: maria };
  assertEquals(okBody(await w.settings({ kind: 'delivery_available', on: false }, body)).result, 'applied');
  assertEquals(okBody(await w.settings({ kind: 'delivery_available', on: false }, { ...body, device_time: '2026-11-19T17:09:00.000Z' })).result, 'duplicate');
  assertEquals(err(await w.settings({ kind: 'delivery_available', on: true }, body)).code, 'action_id_reused');
  assertEquals(err(await w.settings({ kind: 'item_availability', item_id: KNOTS, available: false }, body)).code, 'action_id_reused', 'another kind under the same id');
  const a = w.online.actions.get(id)!;
  assertEquals([a.fn, a.action, a.outcome, a.actor, a.approver], ['settings', 'delivery_available', 'applied', sam, maria]);
  assertEquals(rest(w).delivery_available, false);
  w.online.devices.set(w.A.device_id, { id: w.A.device_id, restaurant_id: R1, status: 'revoked' });
  assertEquals(err(await w.settings({ kind: 'estimates', estimated_pickup_minutes: 33, estimated_delivery_minutes: 44 })).status, 403);
  assertEquals([rest(w).estimated_pickup_minutes, rest(w).estimated_delivery_minutes], [20, 45], 'unchanged (the fixture\'s values)');
});

Deno.test('the claim follows the flags the settings function writes (print register + Ordr auto-print → claim applies)', async () => {
  const w = await world();
  okBody(await w.settings({ kind: 'online_print_device', device_id: w.A.device_id }));
  const row = ordrRow(w.nowIso());
  w.db.insertRow('orders', row);
  const counter = { station: 'p-counter', name: 'Counter', lines: [0, 1] };
  assertEquals(err(await w.print({ order_id: row.id, op: 'claim', stations: [counter] })).code, 'auto_print_off');
  okBody(await w.settings({ kind: 'online_auto_print', on: true }));
  assertEquals(ok<{ result: string; claimed: boolean }>(await w.print({ order_id: row.id, op: 'claim', stations: [counter] })).claimed, true);
});
