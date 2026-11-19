/**
 * Handler-level tests: API version, input caps, error mapping, response shape
 * (no restaurant row data / secrets), module identity, explicit columns, CORS.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { PricingError, type PricingErrorCode } from '../../ordr-core/order/index.ts';
import { RESTAURANT_COLUMNS } from '../db.ts';
import { API_ERROR_STATUS, fromPricingError } from '../errors.ts';
import { handlePriceRequest, type QuoteResponse } from '../handler.ts';
import { PRICING_MODULE_HASH, SOURCE_COMMIT } from '../moduleInfo.ts';
import { MAX_BODY_BYTES, MAX_LINES, MAX_MODIFIERS_PER_LINE, MAX_QUANTITY } from '../request.ts';
import { supabasePricingDb } from '../supabaseDb.ts';
import { isOriginAllowed, parseOriginList } from '../cors.ts';
import { addMenu, emptyTables, FakeDb, headers, id, line, NOW, restaurantRow, SECRET_VALUES } from './fixtures.ts';

const rk = 'handler';
const t = emptyTables();
t.restaurants.push(restaurantRow(id(rk)));
addMenu(t, rk);

async function call(bodyText: string, h: Headers = headers(), method = 'POST') {
  return await handlePriceRequest({ method, headers: h, bodyText }, { db: new FakeDb(t), now: () => NOW, channel: 'online', log: () => {} });
}
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ restaurantId: id(rk), orderType: 'pickup', lines: [line(rk, 'pie', 'Large')], ...extra });
const codeOf = (r: { status: number; body: unknown }) => ({ status: r.status, code: (r.body as { code?: string }).code });

// ---- api version -------------------------------------------------------------------------------

Deno.test('x-ordr-api-version must be exactly 1', async () => {
  for (const v of [null, '2', '1.0', '', 'v1']) {
    assertEquals(codeOf(await call(body(), headers(v))), { status: 400, code: 'unsupported_api_version' }, `version ${v}`);
  }
  assertEquals((await call(body())).status, 200);
});

Deno.test('only POST', async () => {
  assertEquals(codeOf(await call(body(), headers(), 'GET')), { status: 405, code: 'method_not_allowed' });
});

// ---- caps -------------------------------------------------------------------------------------------

Deno.test(`input caps: ${MAX_LINES} lines, ${MAX_MODIFIERS_PER_LINE} modifiers/line, quantity ${MAX_QUANTITY}, ${MAX_BODY_BYTES} bytes`, async () => {
  const pie = line(rk, 'pie', 'Large');
  const fill = (n: number) => Array.from({ length: n }, () => pie);
  assertEquals((await call(body({ lines: fill(MAX_LINES) }))).status, 200);
  assertEquals(codeOf(await call(body({ lines: fill(MAX_LINES + 1) }))), { status: 400, code: 'too_many_lines' });
  const mods = Array.from({ length: MAX_MODIFIERS_PER_LINE + 1 }, (_, i) => ({ toppingId: id(`cap-top-${i}`), placement: 'whole' }));
  assertEquals(codeOf(await call(body({ lines: [{ ...pie, modifiers: mods }] }))), { status: 400, code: 'too_many_modifiers' });
  assertEquals((await call(body({ lines: [{ ...pie, quantity: MAX_QUANTITY }] }))).status, 200);
  assertEquals(codeOf(await call(body({ lines: [{ ...pie, quantity: MAX_QUANTITY + 1 }] }))), { status: 400, code: 'quantity_too_large' });
  for (const q of [0, -1, 1.5, '2']) {
    assertEquals(codeOf(await call(body({ lines: [{ ...pie, quantity: q }] }))), { status: 400, code: 'invalid_quantity' }, `q=${q}`);
  }
  const big = body({ pad: 'x'.repeat(MAX_BODY_BYTES) });
  assertEquals(codeOf(await call(big)), { status: 400, code: 'request_too_large' });
});

Deno.test('money fields from the client are rejected, not ignored', async () => {
  for (const extra of [{ total: 100 }, { subtotal: 1 }, { promoPercent: 90 }, { deliveryFeeCents: 0 }]) {
    assertEquals(codeOf(await call(body(extra))), { status: 400, code: 'invalid_request' }, JSON.stringify(extra));
  }
  const pie = line(rk, 'pie', 'Large');
  assertEquals(codeOf(await call(body({ lines: [{ ...pie, basePrice: 1 }] }))), { status: 400, code: 'invalid_request' });
  assertEquals(codeOf(await call(body({ lines: [{ ...pie, modifiers: [{ toppingId: id(`${rk}:top:pepperoni`), placement: 'whole', price: 0 }] }] }))), { status: 400, code: 'invalid_request' });
});

Deno.test('malformed requests', async () => {
  assertEquals(codeOf(await call('{not json')), { status: 400, code: 'invalid_request' });
  assertEquals(codeOf(await call('[]')), { status: 400, code: 'invalid_request' });
  assertEquals(codeOf(await call(body({ restaurantId: 'not-a-uuid' }))), { status: 400, code: 'invalid_request' });
  assertEquals(codeOf(await call(body({ tip: { mode: 'percent', percent: '18.5.1' } }))), { status: 400, code: 'invalid_tip' });
  assertEquals(codeOf(await call(body({ tip: { mode: 'percent', percent: '150' } }))), { status: 400, code: 'invalid_tip' });
  assertEquals(codeOf(await call(body({ tip: { mode: 'amount', amountCents: 2.5 } }))), { status: 400, code: 'invalid_tip' });
  assertEquals(codeOf(await call(body({ restaurantId: id('nowhere') }))), { status: 404, code: 'restaurant_not_found' });
});

// ---- error mapping ----------------------------------------------------------------------------------------

Deno.test('every PricingError code maps to exactly one API code + status; 5xx bodies are generic', () => {
  const expected: Record<PricingErrorCode, [string, number]> = {
    invalid_quantity: ['invalid_quantity', 400],
    invalid_tip: ['invalid_tip', 400],
    reward_below_minimum: ['reward_below_minimum', 422],
    below_delivery_minimum: ['below_delivery_minimum', 422],
    out_of_delivery_range: ['out_of_delivery_range', 422],
    invalid_amount: ['pricing_config_invalid', 500],
    invalid_rate: ['pricing_config_invalid', 500],
    invalid_reward_line: ['internal_error', 500],
    reward_mismatch: ['internal_error', 500],
    invalid_delivery: ['internal_error', 500],
  };
  for (const [code, [api, status]] of Object.entries(expected)) {
    const e = fromPricingError(new PricingError(code as PricingErrorCode, 'internal detail 12345'));
    assertEquals([e.code, e.status], [api, status], code);
    const b = e.toBody();
    if (status >= 500) assert(!b.message.includes('12345'), `${code} leaks detail`);
    else assert(b.message.includes('12345'));
  }
  // one status per code
  for (const [code, status] of Object.entries(API_ERROR_STATUS)) assert([400, 403, 404, 405, 409, 422, 500].includes(status), code);
});

// ---- response shape / secrets -----------------------------------------------------------------------------------

Deno.test('response carries breakdown + resolved only: no restaurant row data, no secrets', async () => {
  const r = await call(body());
  assertEquals(r.status, 200);
  const text = JSON.stringify(r.body);
  for (const s of ['uber_client_secret', 'uber_webhook_signing_secret', ...Object.values(SECRET_VALUES), 'acct_fixture', 'stripe_account_id']) {
    assert(!text.includes(s), `response contains ${s}`);
  }
  const q = r.body as QuoteResponse;
  assertEquals(Object.keys(q).sort(), ['apiVersion', 'breakdown', 'pricingModuleHash', 'resolved', 'sourceCommit']);
  assertEquals(Object.keys(q.resolved).sort(), ['channel', 'deliveryMode', 'distanceMiles', 'lines', 'localDate', 'orderType', 'promotionId', 'redemption', 'restaurantId', 'uberQuoteId']);
});

Deno.test('RESTAURANT_COLUMNS is explicit and excludes secrets; supabaseDb selects exactly it', async () => {
  for (const c of RESTAURANT_COLUMNS) assert(!/secret|stripe|token|password|key/i.test(c), c);
  const selects: Record<string, string> = {};
  // deno-lint-ignore no-explicit-any
  const builder = (table: string): any => {
    const b = {
      select: (cols: string) => ((selects[table] = cols), b),
      eq: () => b, in: () => b, not: () => b,
      maybeSingle: () => Promise.resolve(table === 'restaurants'
        ? { data: null, error: { code: '42703', message: 'column restaurants.timezone does not exist' } }
        : { data: null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
    };
    return b;
  };
  const db = supabasePricingDb({ from: builder });
  // 42703 (migration 099 not applied) → pricing_config_invalid, not a crash.
  const err = await db.getRestaurant(id(rk)).catch((e) => e);
  assertEquals(err.code, 'pricing_config_invalid');
  assertEquals(selects.restaurants, RESTAURANT_COLUMNS.join(','));
  await db.getMenuItems(id(rk), [id('x')]);
  await db.getToppings(id(rk), [id('x')]);
  await db.getRedemption(id('x'));
  for (const cols of Object.values(selects)) assert(!cols.includes('*'), cols);
});

// ---- module identity ------------------------------------------------------------------------------------------------

Deno.test('pricingModuleHash = sha256 of the vendored files in sha256sum format; sourceCommit from the manifest', async () => {
  const dir = new URL('../../ordr-core/', import.meta.url);
  const manifest = JSON.parse(await Deno.readTextFile(new URL('VENDORED.json', dir)));
  let text = '';
  for (const path of Object.keys(manifest.files).sort()) {
    const bytes = await Deno.readFile(new URL(path, dir));
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
    assertEquals(hex, manifest.files[path], `${path} drifted from the manifest`);
    text += `${hex}  ${path}\n`;
  }
  const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  assertEquals(PRICING_MODULE_HASH, expected);
  const r = (await call(body())).body as QuoteResponse;
  assertEquals([r.apiVersion, r.pricingModuleHash, r.sourceCommit], [1, expected, manifest.sourceCommit]);
  assertEquals(SOURCE_COMMIT, '72d5544de9f08ac380eb0d47d6874dcd4c2cdf1b');
});

// ---- CORS --------------------------------------------------------------------------------------------------------------

Deno.test('CORS: static allowlist + restaurant custom domains (apex/www, https only)', () => {
  const statics = parseOriginList('https://app.example.com, http://localhost:5173/');
  const customs = new Set(['algierispizza.com']);
  const allowed = ['https://app.example.com', 'http://localhost:5173', 'https://algierispizza.com', 'https://www.algierispizza.com'];
  const denied = ['https://evil.com', 'http://algierispizza.com', 'https://algierispizza.com.evil.com', 'https://x.algierispizza.com', 'https://algierispizza.com:8443', 'null'];
  for (const o of allowed) assert(isOriginAllowed(o, statics, customs), o);
  for (const o of denied) assert(!isOriginAllowed(o, statics, customs), o);
});
