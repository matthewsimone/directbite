/**
 * The charge path must be untouchable by shadow mode: a throwing, rejecting
 * or hanging shadow computation leaves create-payment-intent's Response
 * byte-for-byte unchanged, returned immediately, with no exception.
 */
import { assert, assertEquals, assertStrictEquals } from 'jsr:@std/assert@1';
import { parseShadowAllowlist, type ShadowOptions, takeShadowSnapshot, withShadow } from '../shadowGuard.ts';

/** Mirrors create-payment-intent's success return: the Response is built first, then withShadow. */
function chargePathReturn(task: (() => Promise<unknown>) | null, opts: ShadowOptions): Response {
  const response = new Response(JSON.stringify({ clientSecret: 'pi_123_secret_abc', paymentIntentId: 'pi_123', stripeAccount: 'acct_1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
  const returned = withShadow(response, task, opts);
  assertStrictEquals(returned, response, 'withShadow must return the exact same Response object');
  return returned;
}

async function snapshotOf(r: Response) {
  return { status: r.status, headers: [...r.headers.entries()], body: await r.text() };
}

function harness(timeoutMs = 50) {
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const pending: Promise<unknown>[] = [];
  const opts: ShadowOptions = { timeoutMs, log: (event, data) => logs.push({ event, data }), waitUntil: (p) => pending.push(p) };
  return { logs, pending, opts, settle: () => Promise.all(pending) };
}

const BASELINE = await snapshotOf(chargePathReturn(null, harness().opts));

const TASKS: Record<string, () => Promise<unknown>> = {
  'throws synchronously': () => {
    throw new Error('boom (sync)');
  },
  'rejects': () => Promise.reject(new Error('boom (async)')),
  'hangs forever': () => new Promise(() => {}),
  'dynamic import fails': async () => {
    await import('./does-not-exist.ts');
  },
};

for (const [name, task] of Object.entries(TASKS)) {
  Deno.test(`charge path unchanged when the shadow task ${name}`, async () => {
    const h = harness();
    const t0 = performance.now();
    const response = chargePathReturn(task, h.opts);
    const elapsed = performance.now() - t0;
    assert(elapsed < 20, `returned after ${elapsed.toFixed(1)} ms (must not wait for the task)`);
    assertEquals(await snapshotOf(response), BASELINE);
    await h.settle(); // the guarded promise itself never rejects
    if (name === 'hangs forever') assertEquals(h.logs.map((l) => l.event), ['shadow timeout']);
    if (name === 'throws synchronously' || name === 'rejects' || name === 'dynamic import fails') {
      assertEquals(h.logs.map((l) => l.event), ['shadow failed']);
    }
  });
}

Deno.test('a throwing logger and a throwing waitUntil never escape', async () => {
  const opts: ShadowOptions = {
    timeoutMs: 20,
    log: () => {
      throw new Error('logger down');
    },
    waitUntil: () => {
      throw new Error('waitUntil down');
    },
  };
  const response = chargePathReturn(() => Promise.reject(new Error('x')), opts);
  assertEquals(await snapshotOf(response), BASELINE);
  await new Promise((r) => setTimeout(r, 40)); // let the abandoned guarded promise settle
});

Deno.test('no waitUntil available (local / tests): still non-blocking and non-throwing', async () => {
  const logs: string[] = [];
  const response = chargePathReturn(() => Promise.reject(new Error('x')), { timeoutMs: 20, log: (e) => logs.push(e) });
  assertEquals(await snapshotOf(response), BASELINE);
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(logs, ['shadow failed']);
});

Deno.test('snapshot: only allowlisted restaurants; deep copy isolated from later mutation; never throws', () => {
  const allow = parseShadowAllowlist(' AAAA-1 , bbbb-2,, ');
  assertEquals([...allow], ['aaaa-1', 'bbbb-2']);
  const od = { items: [{ quantity: 1 }], dropoff_lat: null as number | null };
  assertEquals(takeShadowSnapshot(allow, 'cccc-3', od), null);
  assertEquals(takeShadowSnapshot(allow, undefined, od), null);
  const snap = takeShadowSnapshot(allow, 'AAAA-1', od)!;
  od.dropoff_lat = 40.1; // create-payment-intent's coord backfill happens after the snapshot
  od.items[0].quantity = 9;
  assertEquals(snap, { items: [{ quantity: 1 }], dropoff_lat: null });
  assertEquals(takeShadowSnapshot(allow, 'aaaa-1', { fn: () => 1 }), null); // uncloneable → null, no throw
  assertEquals(takeShadowSnapshot(parseShadowAllowlist(undefined), 'aaaa-1', od), null); // env unset = off
});
