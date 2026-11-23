/** pin_kdf params (ordr-pos src/core/pinHash.ts) — no crypto here, safe for edge functions. */

export interface KdfParams { alg: 'scrypt'; n: number; r: number; p: number; dk_len: number }

/** Default pin_kdf (STAFF.md CP1.5: 316 ms on the Galaxy Tab A9). */
export const DEFAULT_KDF: KdfParams = { alg: 'scrypt', n: 8192, r: 7, p: 1, dk_len: 32 };

/** ordr-pos src/core/pinHash.ts validKdf (power-of-two N ≥ 1024, sane r / p / length). */
export function validKdf(k: unknown): k is KdfParams {
  const x = k as KdfParams;
  return (
    !!x && x.alg === 'scrypt' &&
    Number.isSafeInteger(x.n) && x.n >= 1024 && (x.n & (x.n - 1)) === 0 &&
    Number.isSafeInteger(x.r) && x.r >= 1 && x.r <= 32 &&
    Number.isSafeInteger(x.p) && x.p >= 1 && x.p <= 4 &&
    Number.isSafeInteger(x.dk_len) && x.dk_len >= 16 && x.dk_len <= 64
  );
}

