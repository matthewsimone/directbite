/**
 * Canonical JSON (SYNC-CONTRACT §7) against the §7.1 test vector, byte for byte.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { canonicalJson, CanonicalJsonError, contentHash, ORDER_HASH_EXCLUDES, sha256HexOfText, withoutKeys } from '../canonicalJson.ts';

const VECTOR_INPUT = {
  order_id: '0b9f6c1e-6f5a-4c51-9d7e-2b8a4f7d3c10',
  version: 2,
  base_server_version: 1,
  status: 'open',
  customer: { phone_e164: '+15165551234', name: 'José "Joe" Núñez\n' },
  lines: [
    {
      id: 'a1', position: 0, quantity: 2, base_price_cents: 1899, discount_exempt: false, seat: null,
      modifiers: [{ id: 'm1', position: 0, kind: 'pizza', placement: 'left', price_cents: 115, price_half_cents: null }],
    },
  ],
  pricing_config: { tax_rate: '0.08875', promo_percent: null, base_service_fee_cents: 0 },
  payments: [],
  content_hash: 'EXCLUDED',
  device_time: 'EXCLUDED',
};

const VECTOR_CANONICAL =
  '{"base_server_version":1,"customer":{"name":"José \\"Joe\\" Núñez\\n","phone_e164":"+15165551234"},"lines":[{"base_price_cents":1899,"discount_exempt":false,"id":"a1","modifiers":[{"id":"m1","kind":"pizza","placement":"left","position":0,"price_cents":115,"price_half_cents":null}],"position":0,"quantity":2,"seat":null}],"order_id":"0b9f6c1e-6f5a-4c51-9d7e-2b8a4f7d3c10","payments":[],"pricing_config":{"base_service_fee_cents":0,"promo_percent":null,"tax_rate":"0.08875"},"status":"open","version":2}';
const VECTOR_HASH = '88812ec3c1667653a89a0a571233f91a594a1922449d03383952c359826f1a12';

Deno.test('§7.1 vector: exact canonical bytes (502 UTF-8 bytes) and SHA-256', async () => {
  const text = canonicalJson(withoutKeys(VECTOR_INPUT, ORDER_HASH_EXCLUDES));
  assertEquals(text, VECTOR_CANONICAL);
  assertEquals(new TextEncoder().encode(text).length, 502);
  assertEquals(await sha256HexOfText(text), VECTOR_HASH);
  assertEquals(await contentHash(VECTOR_INPUT), VECTOR_HASH);
});

Deno.test('rejects fractional numbers, NaN / Infinity, unsafe integers, undefined, bad keys, lone surrogates, non-plain objects', () => {
  for (const bad of [
    { a: 1.5 },
    { a: NaN },
    { a: Infinity },
    { a: 2 ** 53 },
    { a: undefined },
    { A: 1 },
    { 'a-b': 1 },
    { a: '\uD800' },
    { a: 'x\uDC00' },
    { a: new Date(0) },
    { a: [1, 0.1] },
    { a: () => 1 },
  ]) {
    assertThrows(() => canonicalJson(bad), CanonicalJsonError, undefined, JSON.stringify(bad) ?? String(bad));
  }
});

Deno.test('rules: sorted keys, -0 → 0, escaping as JSON.stringify (lowercase \\u00xx), non-ASCII literal, arrays keep order, surrogate pairs ok', () => {
  assertEquals(canonicalJson({ b: 1, a: [3, 1, 2], c: -0 }), '{"a":[3,1,2],"b":1,"c":0}');
  assertEquals(canonicalJson({ s: '\u0001\u001f\b\t\n\f\r"\\é😀' }), '{"s":"\\u0001\\u001f\\b\\t\\n\\f\\r\\"\\\\é😀"}');
  assertEquals(canonicalJson([null, true, false, -5, 'x']), '[null,true,false,-5,"x"]');
  assertEquals(canonicalJson({ z_1: 0, a_2: {} }), '{"a_2":{},"z_1":0}');
});
