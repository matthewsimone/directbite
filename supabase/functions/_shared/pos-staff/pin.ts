/**
 * PINs for scripts/pos-staff.ts (ordr-pos STAFF.md §4.2, S4 / S5; DIRECTBITE-HANDOFF item 8).
 * NOT imported by any edge function — PIN hashes are computed only by Matt's local script.
 *
 * scrypt = Deno's built-in node:crypto scryptSync (no third-party code). Proven against RFC 7914 #1/#2
 * and the shared vector (tests/pin.test.ts; selfCheck() runs before every hash the script makes).
 * Encoding = ordr-pos src/core/pinHashJs.ts: password = UTF-8 of the PIN, salt = bytes of the hex salt,
 * output hex.
 */
import { scryptSync } from 'node:crypto';
import { validKdf, type KdfParams } from './kdf.ts';

export { DEFAULT_KDF, validKdf, type KdfParams } from './kdf.ts';

/** The POS's rule (ordr-pos src/core/staff.ts PIN_PATTERN). */
export const PIN_PATTERN = /^\d{4,6}$/;
export const isValidPin = (pin: string): boolean => PIN_PATTERN.test(pin);

/** Shared test vector (ordr-pos test/db/staff.test.ts:179-182, STAFF.md CP1.5). */
export const SHARED_VECTOR = {
  pin: '1234',
  salt: '00000000000000000000000000000001',
  kdf: { alg: 'scrypt', n: 1024, r: 8, p: 1, dk_len: 32 } as KdfParams,
  hash: 'ef9f198026d8413d3e44bb203cc629e1e8edd972a981a0dfb0a10bc174cd9443',
};

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(h)) throw new Error('salt must be lowercase hex');
  return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
}

/** scrypt(pin, salt) hex — what pos_staff.pin_hash stores and the staff snapshot carries. */
export function pinHashHex(pin: string, saltHex: string, k: KdfParams): string {
  if (!validKdf(k)) throw new Error('invalid pin_kdf');
  const out = scryptSync(new TextEncoder().encode(pin), fromHex(saltHex), k.dk_len, { N: k.n, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 });
  return toHex(new Uint8Array(out));
}

/** A new 16-byte random salt, hex. */
export const newSaltHex = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)));

/** Throws unless this scrypt reproduces the shared vector (run before first use). */
export function selfCheck(): void {
  const v = SHARED_VECTOR;
  if (pinHashHex(v.pin, v.salt, v.kdf) !== v.hash) throw new Error('scrypt self-check FAILED: the shared test vector does not match');
}

/**
 * Weak PINs (handoff item 8: warn + confirm, never refuse): every digit the same (0000, 1111…), or a
 * sequential run up or down (1234, 2345, 4321, 98765…). Returns the reason, or null.
 */
export function weakPinReason(pin: string): string | null {
  if (!isValidPin(pin)) return null;
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return 'every digit is the same';
  const steps = d.slice(1).map((x, i) => x - d[i]);
  if (steps.every((s) => s === 1)) return 'sequential digits (ascending)';
  if (steps.every((s) => s === -1)) return 'sequential digits (descending)';
  return null;
}
