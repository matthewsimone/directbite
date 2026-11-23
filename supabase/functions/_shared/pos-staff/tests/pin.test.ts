/**
 * The script's scrypt (Deno node:crypto) proven against RFC 7914 and the shared directbite vector
 * (ordr-pos test/db/staff.test.ts:167-189 — the same assertions), plus the PIN rules.
 */
import { assert, assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@1';
import { scryptSync } from 'node:crypto';
import { DEFAULT_KDF, isValidPin, newSaltHex, pinHashHex, selfCheck, SHARED_VECTOR, validKdf, weakPinReason } from '../pin.ts';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

Deno.test('node:crypto scrypt matches RFC 7914 test vectors #1 and #2', () => {
  assertEquals(
    hex(scryptSync('', '', 64, { N: 16, r: 1, p: 1 })),
    '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
  );
  assertEquals(
    hex(scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 })),
    'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
  );
});

Deno.test('shared vector: PIN 1234, salt 00…01, n 1024 r 8 p 1 → ef9f1980…9443 (the device self-test value); selfCheck passes', () => {
  const v = SHARED_VECTOR;
  assertEquals(v.hash, 'ef9f198026d8413d3e44bb203cc629e1e8edd972a981a0dfb0a10bc174cd9443');
  assertEquals(pinHashHex('1234', '00000000000000000000000000000001', { alg: 'scrypt', n: 1024, r: 8, p: 1, dk_len: 32 }), v.hash);
  assertEquals(pinHashHex(v.pin, v.salt, v.kdf), v.hash, 'deterministic');
  assertNotEquals(pinHashHex('1235', v.salt, v.kdf), v.hash);
  selfCheck();
  // default kdf: 32-byte output, hex
  assertEquals(pinHashHex('5678', newSaltHex(), DEFAULT_KDF).length, 64);
  assertThrows(() => pinHashHex('1234', 'XYZ', v.kdf));
});

Deno.test('KDF params validated as the POS does (power-of-two N ≥ 1024, sane r / p / length); salts are 16 random bytes hex', () => {
  assertEquals(validKdf(DEFAULT_KDF), true);
  assertEquals(validKdf(SHARED_VECTOR.kdf), true);
  for (const bad of [{ ...DEFAULT_KDF, n: 1000 }, { ...DEFAULT_KDF, n: 512 }, { ...DEFAULT_KDF, r: 0 }, { ...DEFAULT_KDF, p: 9 }, { ...DEFAULT_KDF, dk_len: 8 }, { ...DEFAULT_KDF, alg: 'argon2' }]) {
    assertEquals(validKdf(bad), false, JSON.stringify(bad));
  }
  const a = newSaltHex();
  assert(/^[0-9a-f]{32}$/.test(a));
  assertNotEquals(a, newSaltHex());
});

Deno.test('PIN rule = the POS PIN_PATTERN (4–6 digits); weak PINs: repeats + sequential up / down (warn, never refuse)', () => {
  for (const ok of ['1357', '0000', '123456', '908172']) assertEquals(isValidPin(ok), true, ok);
  for (const bad of ['123', '1234567', '12a4', ' 1234', '1234 ', '', '١٢٣٤']) assertEquals(isValidPin(bad), false, JSON.stringify(bad));
  assertEquals(weakPinReason('0000'), 'every digit is the same');
  assertEquals(weakPinReason('111111'), 'every digit is the same');
  assertEquals(weakPinReason('1234'), 'sequential digits (ascending)');
  assertEquals(weakPinReason('2345'), 'sequential digits (ascending)');
  assertEquals(weakPinReason('456789'), 'sequential digits (ascending)');
  assertEquals(weakPinReason('4321'), 'sequential digits (descending)');
  assertEquals(weakPinReason('98765'), 'sequential digits (descending)');
  for (const fine of ['1357', '9012', '1212', '2580', '1243']) assertEquals(weakPinReason(fine), null, fine);
});
