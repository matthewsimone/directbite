/**
 * Device-function HTTP envelope (SYNC-CONTRACT §1, §3.3, §5, §6): the 426 gate, the error body,
 * Retry-After, CORS, caller IP, body cap, and the generic 500.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { callerIp, callerIpWithSource, DEVICE_CORS_HEADERS, errorResult, handleDeviceHttp, MAX_DEVICE_BODY_BYTES, okResult, parseIp, type DeviceRequest, type DeviceResult, versionGate } from '../http.ts';

const call = (init: RequestInit & { headers?: Record<string, string> }, handler: (r: DeviceRequest) => Promise<DeviceResult> = () => Promise.resolve(okResult({ fine: true })), logs: string[] = []) =>
  handleDeviceHttp(new Request('http://x/functions/v1/pos-v1-device-check', init), handler, (m) => logs.push(m));

Deno.test('426 upgrade_required unless x-ordr-api-version is exactly 1 (not pos-v1-price-order\'s 400)', async () => {
  for (const v of [null, '2', '1.0', '', 'v1']) {
    const h = new Headers(v === null ? {} : { 'x-ordr-api-version': v });
    const r = versionGate(h)!;
    assertEquals(r.status, 426, String(v));
    assertEquals(r.body, { error: { code: 'upgrade_required', message: 'x-ordr-api-version must be 1', min_api_version: 1 } });
  }
  assertEquals(versionGate(new Headers({ 'x-ordr-api-version': '1' })), null);
  const res = await call({ method: 'POST', headers: { 'x-ordr-api-version': '2' } });
  assertEquals(res.status, 426);
  assertEquals((await res.json()).error.code, 'upgrade_required');
});

Deno.test('error envelope { error: { code, message, field? } } and Retry-After in whole seconds', () => {
  assertEquals(errorResult(400, 'invalid_payload', 'bad', { field: 'x' }).body, { error: { code: 'invalid_payload', message: 'bad', field: 'x' } });
  assertEquals(errorResult(429, 'rate_limited', 'slow', { retryAfterMs: 600_000 }).headers, { 'Retry-After': '600' });
  assertEquals(errorResult(429, 'rate_limited', 'slow', { retryAfterMs: 1 }).headers, { 'Retry-After': '1' });
  assertEquals(errorResult(429, 'rate_limited', 'slow', { retryAfterMs: 1_500 }).headers, { 'Retry-After': '2' });
});

Deno.test('front door: OPTIONS 204 with the device CORS allow-list; POST only; body cap; Retry-After passes to the Response; a throw → generic 500', async () => {
  const pre = await call({ method: 'OPTIONS' });
  assertEquals(pre.status, 204);
  const allowed = pre.headers.get('access-control-allow-headers')!;
  for (const hdr of ['x-ordr-device-token', 'x-ordr-device-id', 'x-ordr-client', 'x-ordr-api-version', 'apikey']) assert(allowed.includes(hdr), hdr);
  assertEquals((await call({ method: 'GET', headers: { 'x-ordr-api-version': '1' } })).status, 405);
  const big = await call({ method: 'POST', headers: { 'x-ordr-api-version': '1' }, body: 'x'.repeat(MAX_DEVICE_BODY_BYTES + 1) });
  assertEquals([big.status, (await big.json()).error.code], [400, 'invalid_payload']);
  const limited = await call({ method: 'POST', headers: { 'x-ordr-api-version': '1' } }, () => Promise.resolve(errorResult(429, 'rate_limited', 'x', { retryAfterMs: 5_000 })));
  assertEquals([limited.status, limited.headers.get('retry-after'), limited.headers.get('access-control-allow-origin')], [429, '5', DEVICE_CORS_HEADERS['Access-Control-Allow-Origin']]);
  const logs: string[] = [];
  const boom = await call({ method: 'POST', headers: { 'x-ordr-api-version': '1' } }, () => Promise.reject(new Error('db exploded at odt_secret')), logs);
  assertEquals([boom.status, await boom.json()], [500, { error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } }]);
  assertEquals(logs.length, 1);
});

Deno.test('caller IP order: cf-connecting-ip → x-real-ip → x-forwarded-for first hop (last resort) → none; each must parse as an IP', () => {
  const src = (h: Record<string, string>) => callerIpWithSource(new Headers(h));
  // a spoofed first x-forwarded-for hop never wins over the proxy-set headers
  assertEquals(src({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), { ip: '203.0.113.7', source: 'cf-connecting-ip' });
  assertEquals(src({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '1.2.3.4' }), { ip: '198.51.100.1', source: 'x-real-ip' });
  assertEquals(src({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), { ip: '203.0.113.7', source: 'x-forwarded-for' });
  // invalid values fall through to the next header
  assertEquals(src({ 'cf-connecting-ip': 'garbage', 'x-real-ip': 'also bad', 'x-forwarded-for': '198.51.100.2:4433' }), { ip: '198.51.100.2', source: 'x-forwarded-for' });
  assertEquals(src({ 'cf-connecting-ip': '2001:DB8::1' }), { ip: '2001:db8::1', source: 'cf-connecting-ip' });
  assertEquals(src({ 'x-real-ip': '[2001:db8::2]:443' }), { ip: '2001:db8::2', source: 'x-real-ip' });
  assertEquals(src({ 'x-forwarded-for': 'unknown' }), { ip: null, source: 'none' });
  assertEquals(src({ 'x-forwarded-for': '999.1.1.1' }), { ip: null, source: 'none' });
  assertEquals(src({}), { ip: null, source: 'none' });
  assertEquals(callerIp(new Headers({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9');
  for (const bad of ['', 'abc', '1.2.3', ':', 'deadbeef', '1.2.3.4.5']) assertEquals(parseIp(bad), null, bad);
});

Deno.test('the front door passes ip + ipSource to the handler', async () => {
  let seen: unknown = null;
  await call({ method: 'POST', headers: { 'x-ordr-api-version': '1', 'x-real-ip': '198.51.100.3', 'x-forwarded-for': '6.6.6.6' } }, (r?: { ip: string | null; ipSource?: string }) => {
    seen = { ip: r?.ip, ipSource: r?.ipSource };
    return Promise.resolve(okResult({}));
  });
  assertEquals(seen, { ip: '198.51.100.3', ipSource: 'x-real-ip' });
});
