/**
 * pos-v1-register-device (ordr-pos docs/DEVICE-AUTH.md §4.1 + §5). The only unauthenticated
 * device function.
 *
 * Order — exactly as the reference (ordr-pos test/support/fakeDeviceAuth.ts `register`):
 *  0. IP gate: 5 FAILED attempts in 15 min, or 50 in 24 h → 429 rate_limited + Retry-After (until
 *     the oldest counted failure ages out). The gate itself writes no attempt row. Successes and
 *     replays never count.
 *  1. Normalize + validate the code (and the nonce) → else enrollment_invalid, no per-code count.
 *  2. Replay of a lost response: the NEWEST USED enrollment for the lookup id, same nonce, used
 *     < 10 min ago, right secret → a FRESH token for used_device_id, same body. Not an attempt.
 *  3. The live enrollment (unused + unlocked) for the lookup id; none → invalid, no per-code count.
 *  4. Wrong secret → invalid, counted. Expired (even with the right secret) → invalid, counted.
 *  5. New-device code + existing_device_id → invalid, counted. Re-enroll code: existing_device_id
 *     must equal target_device_id, else invalid, counted; reactivates a revoked device.
 *  Every failure is the SAME 400 body (no oracle) and writes a failed attempt row for the IP; a
 *  counted failure bumps failed_attempts and locks the code at 5.
 */
import { errorResult, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import type { DeviceLog } from './log.ts';
import type { DeviceRow, DeviceStore, EnrollmentRow } from './store.ts';
import { hexEqual, isUuid, newDeviceToken, sha256Hex, splitCode } from './tokens.ts';

export const REPLAY_WINDOW_MS = 10 * 60_000;
export const ENROLLMENT_TTL_MS = 30 * 60_000;
export const IP_WINDOW_MS = 15 * 60_000;
export const IP_MAX_FAILS = 5;
export const IP_DAY_MS = 24 * 3_600_000;
export const IP_DAY_CAP = 50;
/** Bucket for callers whose IP can't be determined (all of them share one rate limit). */
export const UNKNOWN_IP = '0.0.0.0';

export const ENROLLMENT_INVALID_MESSAGE = 'Code invalid or expired';
export const RATE_LIMITED_MESSAGE = 'too many failed registration attempts';

export interface RegisterDeps {
  store: DeviceStore;
  now: () => number;
  log: DeviceLog;
}

/** ms until an IP with these FAILED-attempt times (ascending, within 24 h) may try again, or null. */
export function ipLockMs(failTimes: number[], now: number): number | null {
  const recent = failTimes.filter((t) => t > now - IP_WINDOW_MS);
  const day = failTimes.filter((t) => t > now - IP_DAY_MS);
  let until = 0;
  if (recent.length >= IP_MAX_FAILS) until = Math.max(until, recent[recent.length - IP_MAX_FAILS] + IP_WINDOW_MS);
  if (day.length >= IP_DAY_CAP) until = Math.max(until, day[day.length - IP_DAY_CAP] + IP_DAY_MS);
  return until > now ? until - now : null;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function okBody(d: DeviceRow, token: string, now: number) {
  return {
    status: 200,
    body: { device_id: d.id, device_token: token, restaurant_id: d.restaurant_id, prefix: d.prefix, label: d.label, server_time: new Date(now).toISOString() },
  } satisfies DeviceResult;
}

export async function handleRegister(req: DeviceRequest, deps: RegisterDeps): Promise<DeviceResult> {
  const { store, log } = deps;
  const now = deps.now();
  const ip = req.ip ?? UNKNOWN_IP;
  const ip_source = req.ip ? (req.ipSource ?? 'unknown') : 'none';

  // 0. IP gate — before touching any enrollment; writes nothing.
  const locked = ipLockMs(await store.failedAttemptTimes(ip, now - IP_DAY_MS), now);
  if (locked !== null) {
    log('register_rate_limited', { retry_after_ms: locked, ip_source });
    return errorResult(429, 'rate_limited', RATE_LIMITED_MESSAGE, { retryAfterMs: locked });
  }

  const invalid = async (enrollment: EnrollmentRow | null, why: string): Promise<DeviceResult> => {
    await store.recordEnrollmentFailure({ ip, enrollmentId: enrollment?.id ?? null, at: now });
    log('register_invalid', { why, lookup_id: enrollment?.lookup_id ?? null, ip_source });
    return errorResult(400, 'enrollment_invalid', ENROLLMENT_INVALID_MESSAGE);
  };

  // 1. body + code + nonce. A malformed body is just another invalid attempt (no oracle).
  let body: Record<string, unknown> = {};
  try {
    const v = req.bodyText.trim() ? JSON.parse(req.bodyText) : {};
    if (v && typeof v === 'object' && !Array.isArray(v)) body = v as Record<string, unknown>;
  } catch {
    body = {};
  }
  const parts = splitCode(body.enrollment_code);
  const nonce = body.registration_nonce;
  if (!parts || !isUuid(nonce)) return await invalid(null, 'malformed');
  const secretHash = await sha256Hex(parts.secret);
  const existing = body.existing_device_id ?? null;
  const hardwareModel = str(body.hardware_model, 100);
  const appVersion = str(body.app_version, 40);

  // 2. replay of a lost response
  const used = await store.newestUsedEnrollment(parts.lookupId);
  if (used && used.used_nonce === nonce && used.used_at !== null && now - used.used_at < REPLAY_WINDOW_MS && hexEqual(used.secret_hash, secretHash)) {
    const token = newDeviceToken();
    const d = await store.replayEnrollment({ enrollmentId: used.id, nonce, tokenHash: await sha256Hex(token), windowMs: REPLAY_WINDOW_MS, at: now });
    if (d) {
      log('register_replay', { device_id: d.id, lookup_id: used.lookup_id, ip_source });
      return okBody(d, token, now);
    }
    // lost a race with the window edge: fall through like any other request
  }

  // 3. the usable enrollment
  const live = await store.liveEnrollment(parts.lookupId);
  if (!live) return await invalid(null, 'unknown_used_or_locked');
  // 4. secret, then expiry (both counted)
  if (!hexEqual(live.secret_hash, secretHash)) return await invalid(live, 'wrong_secret');
  // A non-uuid existing_device_id can never equal a target and isn't null: a counted mismatch.
  if (existing !== null && !isUuid(existing)) return await invalid(live, now >= live.expires_at ? 'expired' : 'device_mismatch');

  // 5. atomic consume (re-checks used / locked / expired / device rule under a row lock and does
  //    its own failure bookkeeping)
  const token = newDeviceToken();
  const r = await store.consumeEnrollment({
    enrollmentId: live.id,
    nonce,
    tokenHash: await sha256Hex(token),
    existingDeviceId: existing as string | null,
    hardwareModel,
    appVersion,
    ip,
    at: now,
  });
  if (!r.ok) {
    log('register_invalid', { why: r.reason, lookup_id: live.lookup_id, ip_source });
    return errorResult(400, 'enrollment_invalid', ENROLLMENT_INVALID_MESSAGE);
  }
  log(r.reenrolled ? 'register_reenrolled' : 'register_enrolled', { device_id: r.device.id, restaurant_id: r.device.restaurant_id, prefix: r.device.prefix, lookup_id: live.lookup_id, ip_source });
  return okBody(r.device, token, now);
}
