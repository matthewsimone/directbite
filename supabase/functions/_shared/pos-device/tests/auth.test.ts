/**
 * Middleware (DEVICE-AUTH §4.2, amended 2026-11-21). Ported from ordr-pos deviceAuth.test.ts
 * "middleware on EVERY device function (§4.2)", run through pos-v1-device-check.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { AUTH_FAILED_EVENTS_PER_MIN, SEEN_THROTTLE_MS } from '../auth.ts';
import { err, harness, ok, R1, type Registered } from './harness.ts';

async function twoDevices() {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const b = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  return { h, a, b };
}

Deno.test('no token / unknown token → 401 device_unregistered; x-ordr-device-id ≠ the token\'s device or missing → 403 device_mismatch; revoked → 401 device_revoked; auth_failed events', async () => {
  const { h, a, b } = await twoDevices();
  assertEquals(err(await h.check({ 'x-ordr-device-id': a.device_id })), { status: 401, code: 'device_unregistered', message: 'no device token' });
  assertEquals(err(await h.check({ 'x-ordr-device-id': a.device_id, 'x-ordr-device-token': 'odt_nope' })), { status: 401, code: 'device_unregistered', message: 'unknown device token' });
  assertEquals(err(await h.check({ 'x-ordr-device-id': b.device_id, 'x-ordr-device-token': a.device_token })), { status: 403, code: 'device_mismatch', message: "x-ordr-device-id is not this token's device" });
  assertEquals(err(await h.check({ 'x-ordr-device-token': a.device_token })).status, 403);
  ok(await h.admin({ action: 'revoke', device_id: a.device_id, reason: 'test' }));
  assertEquals(err(await h.check(h.asDevice(a))), { status: 401, code: 'device_revoked', message: 'this register was revoked' });
  // revoked wins over a mismatched id header (status before id, as the reference)
  assertEquals(err(await h.check({ 'x-ordr-device-id': b.device_id, 'x-ordr-device-token': a.device_token })).code, 'device_revoked');
  const failed = h.store.events.filter((e) => e.type === 'auth_failed');
  assertEquals(failed.map((e) => e.detail.code), ['device_unregistered', 'device_unregistered', 'device_mismatch', 'device_mismatch', 'device_revoked', 'device_revoked']);
  assertEquals([failed[2].device_id, failed[0].device_id], [a.device_id, null]);
  ok(await h.check(h.asDevice(b))); // the other register is unaffected
});

Deno.test('principal comes from the token: { device_id, restaurant_id, prefix } + server_time; body restaurant ≠ principal → 400 restaurant_mismatch', async () => {
  const { h, b } = await twoDevices();
  const r = ok<Record<string, string>>(await h.check(h.asDevice(b)));
  assertEquals([r.device_id, r.restaurant_id, r.prefix], [b.device_id, R1, 'B']);
  assertEquals(err(await h.check(h.asDevice(b), { restaurant_id: crypto.randomUUID() })).code, 'restaurant_mismatch');
  ok(await h.check(h.asDevice(b), { restaurant_id: R1 }));
});

Deno.test('GUARD: an unknown token or unknown device id never provisions anything', async () => {
  const h = harness();
  const ghost = crypto.randomUUID();
  assertEquals(err(await h.check({ 'x-ordr-device-id': ghost, 'x-ordr-device-token': 'odt_never_issued' })).status, 401);
  assertEquals(err(await h.check({ 'x-ordr-device-id': ghost })).status, 401);
  assertEquals(h.store.devices.size, 0);
});

Deno.test('last_seen_at + app version (x-ordr-client ordr-pos/<v>), throttled to 60 s', async () => {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const d = () => h.store.devices.get(a.device_id)!;
  assertEquals(d().last_seen_at, null);
  await h.check({ ...h.asDevice(a), 'x-ordr-client': 'ordr-pos/1.2.3' });
  const seen = d().last_seen_at;
  assertEquals([seen, d().last_app_version], [h.clock.now(), '1.2.3']);
  h.clock.advance(SEEN_THROTTLE_MS / 2);
  await h.check({ ...h.asDevice(a), 'x-ordr-client': 'ordr-pos/9.9.9' });
  assertEquals([d().last_seen_at, d().last_app_version], [seen, '1.2.3'], 'throttled');
  h.clock.advance(SEEN_THROTTLE_MS / 2 + 1_000);
  await h.check({ ...h.asDevice(a), 'x-ordr-client': 'something-else/2' });
  assert(d().last_seen_at! > seen!);
  assertEquals(d().last_app_version, '1.2.3', 'only an ordr-pos/ client header sets the version');
});

Deno.test('auth_failed events are capped at 10 a minute (visibility without a flood)', async () => {
  const h = harness();
  for (let i = 0; i < 25; i++) await h.check({ 'x-ordr-device-token': `odt_bad${i}` });
  assertEquals(h.store.events.filter((e) => e.type === 'auth_failed').length, AUTH_FAILED_EVENTS_PER_MIN);
  h.clock.advance(61_000);
  await h.check({ 'x-ordr-device-token': 'odt_bad_later' });
  assertEquals(h.store.events.filter((e) => e.type === 'auth_failed').length, AUTH_FAILED_EVENTS_PER_MIN + 1);
});

Deno.test('a failing heartbeat / audit write never fails the request', async () => {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  h.store.touchDevice = () => Promise.reject(new Error('db down'));
  h.store.recordAuthFailed = () => Promise.reject(new Error('db down'));
  ok(await h.check(h.asDevice(a)));
  assertEquals(err(await h.check({ 'x-ordr-device-token': 'odt_x' })).code, 'device_unregistered');
});
