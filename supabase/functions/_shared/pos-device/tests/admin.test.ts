/**
 * pos-admin-devices (DEVICE-AUTH §6) + prefix allocation (§2) on the in-memory store.
 */
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { ENROLLMENT_TTL_MS } from '../register.ts';
import { nextPrefix } from '../store.ts';
import { sha256Hex } from '../tokens.ts';
import { ADMIN, err, harness, ok, R1, R2, type Registered } from './harness.ts';

Deno.test('admin only: no / bad JWT → 401, a non-admin → 403', async () => {
  const h = harness();
  assertEquals(err(await h.admin({ action: 'list', restaurant_id: R1 }, 'none')).status, 401);
  assertEquals(err(await h.admin({ action: 'list', restaurant_id: R1 }, 'other')).status, 403);
  assertEquals(h.store.enrollments.length, 0);
});

Deno.test('create_enrollment: code XXXX-XXXXXX + QR + assigned prefix + label + expires_at (30 min); only sha256(secret) stored; created_by = admin uid', async () => {
  const h = harness();
  const r = ok<Record<string, string>>(await h.admin({ action: 'create_enrollment', restaurant_id: R1, label: '  Front counter ' }));
  assertMatch(r.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6}$/);
  assertEquals(r.qr, `ordrpos://enroll?code=${r.code.replace('-', '')}`);
  assertEquals([r.prefix, r.label], ['A', 'Front counter']);
  assertEquals(Date.parse(r.expires_at), h.clock.now() + ENROLLMENT_TTL_MS);
  const e = h.store.enrollments[0];
  assertEquals([e.lookup_id, e.secret_hash, e.created_by, e.target_device_id], [r.code.slice(0, 4), await sha256Hex(r.code.slice(5)), ADMIN, null]);
  assert(!JSON.stringify(h.store.enrollments).includes(r.code.slice(5)), 'the secret itself is never stored');
  assertEquals(ok<Record<string, string>>(await h.admin({ action: 'create_enrollment', restaurant_id: R1 })).label, 'Register B', 'default label');
  assertEquals(err(await h.admin({ action: 'create_enrollment', restaurant_id: 'nope' })).code, 'invalid_payload');
});

Deno.test('prefixes: A…Z then AA…; never reused (revoked devices and unused / expired new-device codes keep theirs); per restaurant; re-enroll keeps the device prefix', async () => {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  assertEquals(a.prefix, 'A');
  assertEquals((await h.enroll()).prefix, 'B'); // unused: B stays reserved
  h.clock.advance(31 * 60_000); // …even once expired
  ok(await h.admin({ action: 'revoke', device_id: a.device_id, reason: 'lost' }));
  assertEquals((await h.enroll()).prefix, 'C', 'A (revoked) and B (unused code) are never reused');
  assertEquals((await h.enroll({ targetDeviceId: a.device_id })).prefix, 'A', 're-enroll keeps A and reserves nothing new');
  assertEquals((await h.enroll()).prefix, 'D');
  assertEquals((await h.enroll({ restaurantId: R2 })).prefix, 'A', 'per restaurant');
  const taken = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
  assertEquals(nextPrefix(taken), 'AA');
  taken.add('AA');
  assertEquals(nextPrefix(taken), 'AB');
  for (const x of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const y of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') taken.add(x + y);
  assertEquals(nextPrefix(taken), null);
});

Deno.test('create_reenrollment: bound to a device of THIS restaurant; unknown / foreign device → 404', async () => {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  assertEquals(err(await h.admin({ action: 'create_reenrollment', restaurant_id: R2, device_id: a.device_id })).code, 'unknown_device');
  assertEquals(err(await h.admin({ action: 'create_reenrollment', restaurant_id: R1, device_id: crypto.randomUUID() })).code, 'unknown_device');
  const re = ok<Record<string, string>>(await h.admin({ action: 'create_reenrollment', restaurant_id: R1, device_id: a.device_id }));
  assertEquals([re.prefix, re.label, re.reenroll_device_id], ['A', a.label, a.device_id]);
});

Deno.test('revoke: reason required; actor = admin uid; scoped to restaurant when given', async () => {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  assertEquals(err(await h.admin({ action: 'revoke', device_id: a.device_id, reason: '   ' })).code, 'invalid_payload');
  assertEquals(err(await h.admin({ action: 'revoke', device_id: a.device_id, restaurant_id: R2, reason: 'x' })).code, 'unknown_device');
  ok(await h.admin({ action: 'revoke', device_id: a.device_id, restaurant_id: R1, reason: 'stolen' }));
  const ev = h.store.events.find((e) => e.type === 'revoked')!;
  assertEquals([ev.actor, ev.detail.reason, ev.device_id], [ADMIN, 'stolen', a.device_id]);
});

Deno.test('list: label, prefix, status, model, app version, last seen, token age — never a hash or token', async () => {
  const h = harness();
  const a = ok<Registered>(await h.register(h.req((await h.enroll({ label: 'Front' })).code)));
  ok<Registered>(await h.register(h.req((await h.enroll({ restaurantId: R2 })).code)));
  h.clock.advance(90_000);
  await h.check(h.asDevice(a));
  const r = ok<{ devices: Record<string, unknown>[] }>(await h.admin({ action: 'list', restaurant_id: R1 }));
  assertEquals(r.devices.length, 1, 'only this restaurant');
  const d = r.devices[0];
  assertEquals([d.device_id, d.label, d.prefix, d.status, d.hardware_model, d.app_version, d.token_age_seconds], [a.device_id, 'Front', 'A', 'active', 'iMin Swan 3 Pro', '1.0.0', 90]);
  assertEquals(d.last_seen_at, new Date(h.clock.now()).toISOString());
  const text = JSON.stringify(r);
  assert(!text.includes('token_hash') && !text.includes(h.store.devices.get(a.device_id)!.token_hash) && !text.includes('odt_'));
});

Deno.test('locked_ips: IPs locked out of registration, with the wait', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) await h.register(h.req('ZZZZ-ZZZZZZ'), '198.51.100.9');
  await h.register(h.req('ZZZZ-ZZZZZZ'), '198.51.100.10');
  const r = ok<{ locked_ips: Record<string, unknown>[] }>(await h.admin({ action: 'locked_ips' }));
  assertEquals(r.locked_ips, [{ ip: '198.51.100.9', retry_after_seconds: 900, failures_15m: 5, failures_24h: 5 }]);
});

Deno.test('unknown action → 400', async () => {
  assertEquals(err(await harness().admin({ action: 'drop_everything' })).code, 'invalid_payload');
});
