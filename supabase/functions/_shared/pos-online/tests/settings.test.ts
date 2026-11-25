/**
 * pos-v1-online-settings (CP18) end to end over the device middleware, MemoryOnlineStore (= 111
 * pos_online_settings_change) and the in-memory PostgREST. Ported from the reference (ordr-pos @ 86c558d):
 *   test/online/settings.test.ts :108-152 (lost answer → noop, same action_id → duplicate, the audit has actor +
 *   approver, pause → 400), :237-249 (malformed → 400; the print flags write pos_restaurant_settings only, both
 *   default off), src/dev/onlineSettingsRules.ts :51-85, test/support/fakeOnline.ts settingsChange :331-350.
 * CP18 builds the POS-only settings (print register + the two auto-print flags); the tablet-column ones
 * (estimates / delivery_available / item_availability) answer 501. Every settings answer is read with the POS's
 * own settingsProblem (referenceParse.ts).
 */
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { err, ok, R1, R2 } from '../../pos-device/tests/harness.ts';
import type { OnlineSettingsWire } from '../wire.ts';
import { settingsProblem } from './referenceParse.ts';
import { ordrRow, world } from './world.ts';

type Body = { result: string; settings: OnlineSettingsWire; menu_snapshot_hash: string | null; server_time: string };
const okBody = (r: Parameters<typeof ok>[0]): Body => {
  const b = ok<Body>(r);
  assertEquals(Object.keys(b).sort(), ['menu_snapshot_hash', 'result', 'server_time', 'settings']);
  assertEquals(settingsProblem(b.settings), null, 'the POS reads the settings');
  assertEquals(b.menu_snapshot_hash, null);
  return b;
};

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

Deno.test('malformed / unknown changes → 400 (pause / unpause included); the tablet-column changes → 501 (not built in CP18)', async () => {
  const w = await world();
  for (const c of [null, 'x', [], { kind: 'nope' }, { kind: 'pause' }, { kind: 'unpause' }, { kind: 'online_auto_print', on: 1 }, { kind: 'kitchenhub_auto_print' }, { kind: 'online_print_device', device_id: 7 }, { kind: 'online_print_device', device_id: 'reg-1' }]) {
    assertEquals(err(await w.settings(c)).code, 'invalid_payload', JSON.stringify(c));
  }
  for (const c of [{ kind: 'estimates', estimated_pickup_minutes: 20, estimated_delivery_minutes: 45 }, { kind: 'delivery_available', on: false }, { kind: 'item_availability', item_id: crypto.randomUUID(), available: false }]) {
    assertEquals(err(await w.settings(c)), { status: 501, code: 'not_implemented', message: `${c.kind} is not available on Ordr yet` });
  }
  assertEquals(err(await w.settings({ kind: 'online_auto_print', on: true }, { restaurant_id: R2 })).code, 'restaurant_mismatch');
  assertEquals(err(await w.settings({ kind: 'online_auto_print', on: true }, { action_id: 'x' })).code, 'invalid_payload');
  assertEquals(err(await w.settings({ kind: 'online_auto_print', on: true }, { actor_staff_id: 'Sam' })).code, 'invalid_payload');
  assertEquals(w.online.actions.size, 0);
  assertEquals(w.online.settings.get(R1), undefined, 'nothing written');
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
