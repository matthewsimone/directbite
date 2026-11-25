/**
 * pos-v1-register-device (DEVICE-AUTH §4.1, §5). Ported from ordr-pos test/sync/deviceAuth.test.ts
 * "pos-v1-register-device (§4.1)" + DEVICE-AUTH §12.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@1';
import { IP_DAY_CAP, IP_DAY_MS, IP_WINDOW_MS, REPLAY_WINDOW_MS } from '../register.ts';
import { CODE_MAX_FAILS } from '../store.ts';
import { normalizeCode, sha256Hex } from '../tokens.ts';
import { err, FAKE_IP, harness, INVALID, ok, R1, type Registered } from './harness.ts';

Deno.test('new device: the code typed any way (dash, lowercase, I/L/O look-alikes) → device_id + odt_ token + allocated prefix + label; only sha256(token) stored; the token works', async () => {
  const h = harness();
  const e1 = await h.enroll({ label: 'Front counter' });
  assertMatch(e1.display, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6}$/);
  const typed = e1.display.toLowerCase().replace(/1/g, () => 'l').replace(/0/g, 'o');
  assertEquals(normalizeCode(typed), e1.code);
  const b = ok<Registered>(await h.register(h.req(typed)));
  assertMatch(b.device_token, /^odt_[A-Za-z0-9_-]{43}$/);
  assertEquals([b.restaurant_id, b.prefix, b.label], [R1, 'A', 'Front counter']);
  assertEquals(new Date(b.server_time).getTime(), h.clock.now());
  const d = h.store.devices.get(b.device_id)!;
  assertEquals(d.token_hash, await sha256Hex(b.device_token), 'only sha256(token) is stored');
  assert(!JSON.stringify([...h.store.devices.values(), ...h.store.enrollments, ...h.store.events]).includes(b.device_token), 'never the token itself');
  assertEquals([d.hardware_model, d.last_app_version], ['iMin Swan 3 Pro', '1.0.0']);
  assertEquals((await h.enroll()).prefix, 'B', 'next unused prefix');
  assertEquals(ok(await h.check(h.asDevice(b))).device_id, b.device_id);
  assertEquals(h.store.events.filter((x) => x.type === 'enrolled').length, 1);
  assertEquals(h.store.attempts, [{ ip: FAKE_IP, at: h.clock.now(), success: true }], 'a success row, never counted');
});

Deno.test('a new-device code with existing_device_id → enrollment_invalid (counts against the code)', async () => {
  const h = harness();
  const e = await h.enroll();
  assertEquals(err(await h.register(h.req(e.code, { existing_device_id: crypto.randomUUID() }))), INVALID);
  assertEquals(h.store.enrollments[0].failed_attempts, 1);
  // a non-uuid existing_device_id is the same counted mismatch
  assertEquals(err(await h.register(h.req(e.code, { existing_device_id: 'not-a-uuid' }))), INVALID);
  assertEquals(h.store.enrollments[0].failed_attempts, 2);
  assertEquals(h.store.devices.size, 0);
});

Deno.test('re-enroll: bound to target_device_id (wrong device → invalid, counted); right device → same id, fresh token, old token dead; reactivates a revoked device', async () => {
  const h = harness();
  const first = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  ok(await h.admin({ action: 'revoke', device_id: first.device_id, reason: 'tablet stolen' }));
  assertEquals(err(await h.check(h.asDevice(first))), { status: 401, code: 'device_revoked', message: 'this register was revoked' });
  const re = await h.enroll({ targetDeviceId: first.device_id });
  assertEquals(re.prefix, 'A', 'a re-enroll keeps the device prefix');
  assertEquals(err(await h.register(h.req(re.code, { existing_device_id: crypto.randomUUID() }))), INVALID);
  assertEquals(err(await h.register(h.req(re.code, { existing_device_id: null }))), INVALID);
  assertEquals(h.store.enrollments[1].failed_attempts, 2);
  const back = ok<Registered>(await h.register(h.req(re.code, { existing_device_id: first.device_id, hardware_model: 'Galaxy Tab A9' })));
  assertEquals([back.device_id, back.prefix], [first.device_id, 'A']);
  assertNotEquals(back.device_token, first.device_token);
  const d = h.store.devices.get(first.device_id)!;
  assertEquals([d.status, d.revoked_at, d.revoked_reason, d.hardware_model], ['active', null, null, 'Galaxy Tab A9'], 'reactivated');
  assertEquals(err(await h.check(h.asDevice(first))).code, 'device_unregistered', 'the old token is dead');
  ok(await h.check(h.asDevice(back)));
  assertEquals(h.store.events.map((x) => x.type).filter((t) => t !== 'auth_failed' && t !== 'enrollment_failed'), ['enrolled', 'revoked', 'reenrolled']);
});

Deno.test('replay of a lost response: same nonce < 10 min → a FRESH token for the same device (the first is dead), not an attempt; other nonce / wrong secret / late → invalid', async () => {
  const h = harness();
  const e = await h.enroll();
  const r = h.req(e.code);
  const a = ok<Registered>(await h.register(r)); // the device never got this response
  h.clock.advance(REPLAY_WINDOW_MS - 1_000);
  const b = ok<Registered>(await h.register(r));
  assertEquals([b.device_id, b.prefix, b.label, b.restaurant_id], [a.device_id, a.prefix, a.label, a.restaurant_id]);
  assertNotEquals(b.device_token, a.device_token);
  assertEquals(h.store.devices.size, 1, 'one device');
  assertEquals(err(await h.check(h.asDevice(a))).code, 'device_unregistered');
  ok(await h.check(h.asDevice(b)));
  assertEquals(h.store.attempts.filter((x) => !x.success).length, 0, 'a replay is not a failed attempt');
  assertEquals(h.store.attempts.filter((x) => x.success).length, 1, 'nor a second success row');
  assertEquals(err(await h.register({ ...r, registration_nonce: crypto.randomUUID() })), INVALID, 'another nonce: the code is used');
  assertEquals(err(await h.register({ ...r, enrollment_code: e.code.slice(0, 4) + (e.code[4] === '0' ? '1' : '0') + e.code.slice(5) })), INVALID, 'wrong secret');
  h.clock.advance(2_000);
  assertEquals(err(await h.register(r)), INVALID, 'after 10 min: enter a new code');
});

Deno.test('enrollment_invalid is ONE answer for unknown / malformed / bad body / bad nonce / expired / used / locked / wrong secret / device mismatch (no oracle)', async () => {
  const h = harness();
  const ip = () => `198.51.100.${Math.floor(Math.random() * 250)}`;
  const results: unknown[] = [];
  results.push(err(await h.register(h.req('ZZZZ-ZZZZZZ'), ip())));
  results.push(err(await h.register(h.req('short'), ip())));
  results.push(err(await h.register('{not json', ip())));
  results.push(err(await h.register('[1,2]', ip())));
  results.push(err(await h.register(h.req('ZZZZ-ZZZZZZ', { registration_nonce: 'nope' }), ip())));
  const exp = await h.enroll();
  h.clock.advance(30 * 60_000);
  results.push(err(await h.register(h.req(exp.code), ip())));
  const used = await h.enroll();
  ok(await h.register(h.req(used.code), ip()));
  results.push(err(await h.register(h.req(used.code), ip())));
  const lock = await h.enroll();
  const wrong = lock.code.slice(0, 4) + 'ZZZZZZ';
  for (let i = 0; i < CODE_MAX_FAILS; i++) results.push(err(await h.register(h.req(wrong), ip())));
  results.push(err(await h.register(h.req(lock.code), ip())));
  const mism = await h.enroll();
  results.push(err(await h.register(h.req(mism.code, { existing_device_id: crypto.randomUUID() }), ip())));
  for (const r of results) assertEquals(r, INVALID);
  // and the body is byte-identical every time
  const bodies = new Set([await h.register(h.req('ZZZZ-ZZZZZZ'), ip()), await h.register('{', ip())].map((r) => JSON.stringify(r.body)));
  assertEquals([...bodies], [JSON.stringify({ error: { code: 'enrollment_invalid', message: 'Code invalid or expired' } })]);
});

Deno.test('expired + RIGHT secret counts against the code; unknown / used / locked lookups never count', async () => {
  const h = harness();
  const exp = await h.enroll();
  h.clock.advance(30 * 60_000);
  await h.register(h.req(exp.code), '192.0.2.1');
  assertEquals(h.store.enrollments[0].failed_attempts, 1);
  const used = await h.enroll();
  ok(await h.register(h.req(used.code), '192.0.2.2'));
  await h.register(h.req(used.code.slice(0, 4) + 'ZZZZZZ'), '192.0.2.3');
  assertEquals(h.store.enrollments[1].failed_attempts, 0, 'a used code is dead, not counted');
});

Deno.test('per-code lock at 5 wrong tries: the right secret is refused after, the admin issues a new code; enrollment_locked event', async () => {
  const h = harness();
  const e = await h.enroll();
  const wrong = e.code.slice(0, 4) + 'ZZZZZZ';
  for (let i = 0; i < CODE_MAX_FAILS; i++) await h.register(h.req(wrong), `192.0.2.${i}`); // different IPs: the code lock, not the IP lock
  assert(h.store.enrollments[0].locked_at !== null);
  assertEquals(h.store.enrollments[0].failed_attempts, CODE_MAX_FAILS);
  assertEquals(err(await h.register(h.req(e.code), '192.0.2.99')), INVALID);
  assertEquals(h.store.events.filter((x) => x.type === 'enrollment_locked').length, 1);
  ok(await h.register(h.req((await h.enroll()).code), '192.0.2.99'));
});

Deno.test('per IP: 5 failures in 15 min → 429 rate_limited + Retry-After (seconds, until the window frees a slot), before touching any enrollment; other IPs unaffected; then unlocked', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    await h.register(h.req('ZZZZ-ZZZZZZ'));
    h.clock.advance(60_000);
  }
  const good = await h.enroll();
  const attemptsBefore = h.store.attempts.length;
  const r = await h.register(h.req(good.code));
  assertEquals(err(r), { status: 429, code: 'rate_limited', message: 'too many failed registration attempts' });
  assertEquals(r.headers?.['Retry-After'], String((IP_WINDOW_MS - 5 * 60_000) / 1000), 'until the oldest counted failure ages out');
  assertEquals(h.store.enrollments[0].used_at, null, 'the gate never touches the enrollment');
  assertEquals(h.store.attempts.length, attemptsBefore, 'the gate writes no attempt row');
  ok(await h.register(h.req(good.code), '192.0.2.50'));
  h.clock.advance(IP_WINDOW_MS - 5 * 60_000);
  assertEquals(err(await h.register(h.req('ZZZZ-ZZZZZZ'))), INVALID, 'unlocked once a slot frees');
});

Deno.test('per IP: successes never count (12 registrations from one IP stay unlocked)', async () => {
  const h = harness();
  for (let i = 0; i < 12; i++) ok(await h.register(h.req((await h.enroll()).code)));
  assertEquals(h.store.attempts.filter((a) => a.success).length, 12);
  ok(await h.register(h.req((await h.enroll()).code)));
});

Deno.test('per IP: hard cap of 50 failures a day (spread out, never 5 in 15 min) → 429 until the first ages out', async () => {
  const h = harness();
  for (let i = 0; i < IP_DAY_CAP; i++) {
    assertEquals(err(await h.register(h.req('ZZZZ-ZZZZZZ'))), INVALID, `attempt ${i + 1}`);
    h.clock.advance(4 * 60_000);
  }
  const r = await h.register(h.req('ZZZZ-ZZZZZZ'));
  assertEquals(err(r).status, 429);
  assertEquals(r.headers?.['Retry-After'], String((IP_DAY_MS - IP_DAY_CAP * 4 * 60_000) / 1000));
  h.clock.advance(IP_DAY_MS - IP_DAY_CAP * 4 * 60_000);
  assertEquals(err(await h.register(h.req('ZZZZ-ZZZZZZ'))), INVALID);
});

Deno.test('unknown caller IP falls into one shared bucket (0.0.0.0)', async () => {
  const h = harness();
  await h.register(h.req('ZZZZ-ZZZZZZ'), null);
  assertEquals(h.store.attempts[0].ip, '0.0.0.0');
});

Deno.test('logs carry ip_source (which header), never the IP itself', async () => {
  const h = harness();
  const ip = '198.51.100.77';
  const e = await h.enroll();
  const { handleRegister } = await import('../register.ts');
  await handleRegister({ method: 'POST', headers: new Headers(), bodyText: JSON.stringify(h.req(e.code)), ip, ipSource: 'x-real-ip' }, h.deps);
  await handleRegister({ method: 'POST', headers: new Headers(), bodyText: JSON.stringify(h.req('ZZZZ-ZZZZZZ')), ip, ipSource: 'x-real-ip' }, h.deps);
  await handleRegister({ method: 'POST', headers: new Headers(), bodyText: '{}', ip: null, ipSource: 'none' }, h.deps);
  const reg = h.logs.filter((l) => l.includes('"register_'));
  assertEquals(reg.map((l) => JSON.parse(l).ip_source), ['x-real-ip', 'x-real-ip', 'none']);
  for (const l of h.logs) assert(!l.includes(ip), `IP in a log line: ${l}`);
});
