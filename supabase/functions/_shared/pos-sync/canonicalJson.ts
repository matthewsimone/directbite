/**
 * Canonical JSON + content hashes (ordr-pos docs/SYNC-CONTRACT.md §7).
 *
 * A strict subset of RFC 8785 (JCS). Both sides must produce identical bytes:
 *  1. values: object, array, string, true, false, null, and integers in the safe range. No
 *     fractional numbers, NaN, Infinity or undefined (all errors). -0 serializes as 0.
 *  2. objects: keys sorted by UTF-16 code unit (JS default sort); keys must match ^[a-z0-9_]+$.
 *  3. arrays: order preserved.
 *  4. strings: well-formed Unicode (no lone surrogates); escaped exactly as JSON.stringify.
 *  5. integers: shortest decimal form. 6. no whitespace. 7. UTF-8, no BOM.
 *  8. hash: SHA-256 over the UTF-8 bytes, lowercase hex.
 *
 * Tested against the §7.1 vector (502 bytes, 88812ec3…1a12).
 */

export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path || '<root>'}: ${message}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

const KEY_PATTERN = /^[a-z0-9_]+$/;

function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function write(v: unknown, path: string, out: string[]): void {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number': {
      if (!Number.isFinite(v)) throw new CanonicalJsonError(path, `not a finite number (${String(v)})`);
      if (!Number.isInteger(v)) throw new CanonicalJsonError(path, 'fractional numbers are not allowed (use integer cents or a decimal string)');
      if (!Number.isSafeInteger(v)) throw new CanonicalJsonError(path, 'integer outside the safe range');
      out.push(Object.is(v, -0) ? '0' : String(v));
      return;
    }
    case 'string':
      if (!isWellFormed(v)) throw new CanonicalJsonError(path, 'string contains a lone surrogate');
      out.push(JSON.stringify(v));
      return;
    case 'object': {
      if (Array.isArray(v)) {
        out.push('[');
        v.forEach((item, i) => {
          if (i) out.push(',');
          write(item, `${path}[${i}]`, out);
        });
        out.push(']');
        return;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(path, 'only plain objects are allowed');
      const keys = Object.keys(v as Record<string, unknown>).sort();
      out.push('{');
      keys.forEach((k, i) => {
        if (!KEY_PATTERN.test(k)) throw new CanonicalJsonError(path ? `${path}.${k}` : k, 'key must match ^[a-z0-9_]+$');
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) throw new CanonicalJsonError(path ? `${path}.${k}` : k, 'undefined is not allowed (use null)');
        if (i) out.push(',');
        out.push(JSON.stringify(k), ':');
        write(val, path ? `${path}.${k}` : k, out);
      });
      out.push('}');
      return;
    }
    default:
      throw new CanonicalJsonError(path, `${typeof v} is not allowed`);
  }
}

/** Canonical JSON text of `value` (throws CanonicalJsonError). */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, '', out);
  return out.join('');
}

/** `obj` without the given top-level keys (shallow). */
export function withoutKeys(obj: Record<string, unknown>, exclude: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!exclude.includes(k)) out[k] = v;
  return out;
}

/** SYNC-CONTRACT §7 rule 8: order / entity content_hash excludes these top-level keys. */
export const ORDER_HASH_EXCLUDES = ['content_hash', 'device_time'] as const;
/** Menu / staff snapshot hash excludes these. */
export const SNAPSHOT_HASH_EXCLUDES = ['hash', 'server_time'] as const;

export async function sha256HexOfText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 (lowercase hex) of the canonical JSON of `obj` minus `exclude`. */
export async function contentHash(obj: Record<string, unknown>, exclude: readonly string[] = ORDER_HASH_EXCLUDES): Promise<string> {
  return await sha256HexOfText(canonicalJson(withoutKeys(obj, exclude)));
}
