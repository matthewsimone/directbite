/**
 * Secrets never logged (DEVICE-AUTH §3, §7.4): no device token, no enrollment code / secret —
 * neither in the injected log nor on the console, through register, replay, auth, reject, revoke.
 * Also the production console logger masks anything token-shaped.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { consoleDeviceLog, redact } from '../log.ts';
import { harness, ok, type Registered } from './harness.ts';

Deno.test('the token and the enrollment secret are never logged (log sink + console spy)', async () => {
  const lines: string[] = [];
  const spied = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const orig = spied.map((k) => console[k]);
  for (const k of spied) console[k] = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try {
    const h = harness();
    const e = await h.enroll();
    const r = h.req(e.code);
    const a = ok<Registered>(await h.register(r));
    const b = ok<Registered>(await h.register(r)); // replay
    await h.check(h.asDevice(b));
    await h.check({ 'x-ordr-device-id': crypto.randomUUID(), 'x-ordr-device-token': b.device_token }); // mismatch
    await h.check(h.asDevice(a)); // dead token
    ok(await h.admin({ action: 'revoke', device_id: b.device_id, reason: 'x' }));
    await h.check(h.asDevice(b)); // revoked
    await h.register(h.req(e.code.slice(0, 4) + 'ZZZZZZ'));
    const all = [...h.logs, ...lines];
    assert(h.logs.length >= 8, `the calls were logged (${h.logs.length})`);
    assert(h.logs.some((l) => l.includes('device_revoked')), 'the reject was logged');
    for (const l of all) {
      assert(!l.includes('odt_'), `token in a log line: ${l}`);
      assert(!l.includes(e.code) && !l.includes(e.code.slice(4)), `enrollment secret in a log line: ${l}`);
      for (const t of [a.device_token, b.device_token]) assert(!l.includes(t.slice(4)));
    }
  } finally {
    spied.forEach((k, i) => (console[k] = orig[i]));
  }
});

Deno.test('consoleDeviceLog masks token-shaped strings as a last line of defence', () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    consoleDeviceLog('t')('oops', { error: 'bad header odt_AbC-123_xyz' });
  } finally {
    console.log = orig;
  }
  assertEquals(lines, ['{"fn":"t","event":"oops","error":"bad header [device token]"}']);
  assertEquals(redact('a odt_ b'), 'a [device token] b');
});
