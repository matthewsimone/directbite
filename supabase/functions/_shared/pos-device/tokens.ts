/**
 * Device-auth secrets (ordr-pos docs/DEVICE-AUTH.md §3).
 *
 *  - Device token: `odt_` + base64url(32 random bytes) (43 chars, no padding). Stored only as
 *    sha256 hex. High entropy, so plain SHA-256 is correct (no bcrypt).
 *  - Enrollment code: 10 chars Crockford base32 (no I L O U). The first 4 are the public lookup id,
 *    the last 6 the secret (~30 bits, stored as sha256 hex). Shown as `XXXX-XXXXXX`.
 *
 * Neither value is ever logged. Logs carry `token_hash[:8]` / `lookup_id` at most.
 * Reference: ordr-pos test/support/fakeDeviceAuth.ts (normalizeCode, newDeviceToken, randomCode).
 */

/** Crockford base32 without I L O U (DEVICE-AUTH §3). */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;
export const TOKEN_PREFIX = 'odt_';
export const LOOKUP_LENGTH = 4;
export const SECRET_LENGTH = 6;

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new device token: `odt_` + base64url(32 random bytes). */
export function newDeviceToken(): string {
  return TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** n random Crockford characters (256 % 32 == 0, so `byte % 32` is unbiased). */
export function randomCode(n: number): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += CROCKFORD[b[i] % 32];
  return s;
}

export interface EnrollmentCode {
  /** 10 chars, normalized. */
  code: string;
  /** `XXXX-XXXXXX` for display. */
  display: string;
  lookupId: string;
  secret: string;
}

export function newEnrollmentCode(): EnrollmentCode {
  const lookupId = randomCode(LOOKUP_LENGTH);
  const secret = randomCode(SECRET_LENGTH);
  return { code: lookupId + secret, display: `${lookupId}-${secret}`, lookupId, secret };
}

/** Normalize as the device does: uppercase, strip `-` and whitespace, I/L → 1, O → 0. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

/** Normalized + valid → { lookupId, secret }; else null. */
export function splitCode(raw: unknown): { lookupId: string; secret: string } | null {
  if (typeof raw !== 'string') return null;
  const code = normalizeCode(raw);
  if (!CODE_PATTERN.test(code)) return null;
  return { lookupId: code.slice(0, LOOKUP_LENGTH), secret: code.slice(LOOKUP_LENGTH) };
}

/** QR payload for an enrollment code (DEVICE-AUTH §3). */
export function enrollmentQr(code: string): string {
  return `ordrpos://enroll?code=${code}`;
}

/** Constant-time compare of two equal-length hex strings. */
export function hexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The only form of a token / hash a log line may carry. */
export function hashTag(tokenHash: string | null | undefined): string | null {
  return tokenHash ? tokenHash.slice(0, 8) : null;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);
