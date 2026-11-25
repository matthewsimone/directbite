/**
 * pos-admin-devices logic (ordr-pos docs/DEVICE-AUTH.md §6, Matt-only at launch).
 *
 * Admin JWT only (admin_users, same pattern as admin-refund:50-54; the check is injected so tests run
 * without Supabase). Actions:
 *   list               { restaurant_id }               → devices (never hashes)
 *   create_enrollment  { restaurant_id, label? }       → code XXXX-XXXXXX + QR + prefix + expires_at (30 min)
 *   create_reenrollment{ restaurant_id, device_id, label? } → same, bound to that device record
 *   revoke             { device_id, reason, restaurant_id? }
 *   locked_ips         {}                              → IPs currently locked out of registration
 * The code is returned ONCE; only sha256(secret) is stored. Revoke writes a `revoked` event with
 * actor = the admin's auth uid. (Enrollment creation has no event type in DEVICE-AUTH §2; the
 * enrollment row itself records created_by / created_at.)
 */
import { errorResult, okResult, parseJsonObject, type DeviceResult } from '../pos-sync/http.ts';
import type { DeviceLog } from './log.ts';
import { ENROLLMENT_TTL_MS, IP_DAY_MS, IP_WINDOW_MS, ipLockMs } from './register.ts';
import type { DeviceRow, DeviceStore } from './store.ts';
import { enrollmentQr, isUuid, newEnrollmentCode, sha256Hex } from './tokens.ts';

export const ADMIN_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export type AdminCheck = { ok: true; adminId: string } | { ok: false; status: 401 | 403 };

export interface AdminDeps {
  store: DeviceStore;
  now: () => number;
  log: DeviceLog;
  /** Bearer token → admin auth uid (admin_users), or 401 / 403. */
  verifyAdmin: (authorization: string | null) => Promise<AdminCheck>;
}

export interface AdminRequest {
  method: string;
  headers: Headers;
  bodyText: string;
}

const LOOKUP_RETRIES = 5;
const MAX_LABEL = 60;
const MAX_REASON = 500;

function deviceView(d: DeviceRow, now: number) {
  return {
    device_id: d.id,
    label: d.label,
    prefix: d.prefix,
    status: d.status,
    hardware_model: d.hardware_model,
    app_version: d.last_app_version,
    last_seen_at: d.last_seen_at === null ? null : new Date(d.last_seen_at).toISOString(),
    token_age_seconds: Math.max(0, Math.floor((now - d.token_issued_at) / 1000)),
    created_at: new Date(d.created_at).toISOString(),
    revoked_at: d.revoked_at === null ? null : new Date(d.revoked_at).toISOString(),
    revoked_reason: d.revoked_reason,
  };
}

async function createCode(deps: AdminDeps, adminId: string, restaurantId: string, label: string | null, targetDeviceId: string | null): Promise<DeviceResult> {
  const now = deps.now();
  for (let i = 0; i < LOOKUP_RETRIES; i++) {
    const code = newEnrollmentCode();
    const r = await deps.store.createEnrollment({
      restaurantId,
      label,
      targetDeviceId,
      lookupId: code.lookupId,
      secretHash: await sha256Hex(code.secret),
      expiresAt: now + ENROLLMENT_TTL_MS,
      createdBy: adminId,
      at: now,
    });
    if (r.ok) {
      deps.log('enrollment_created', { restaurant_id: restaurantId, prefix: r.prefix, lookup_id: code.lookupId, reenroll_device_id: targetDeviceId });
      return okResult({
        enrollment_id: r.enrollmentId,
        code: code.display,
        qr: enrollmentQr(code.code),
        prefix: r.prefix,
        label: r.label,
        expires_at: new Date(now + ENROLLMENT_TTL_MS).toISOString(),
        reenroll_device_id: targetDeviceId,
      });
    }
    if (r.reason === 'lookup_taken') continue;
    if (r.reason === 'unknown_device') return errorResult(404, 'unknown_device', 'no such device for this restaurant', { field: 'device_id' });
    if (r.reason === 'unknown_restaurant') return errorResult(404, 'unknown_restaurant', 'no such restaurant', { field: 'restaurant_id' });
    return errorResult(409, 'no_prefixes', 'this restaurant has no register prefixes left');
  }
  return errorResult(503, 'try_again', 'could not allocate an enrollment code; try again');
}

export async function handleAdmin(req: AdminRequest, deps: AdminDeps): Promise<DeviceResult> {
  if (req.method !== 'POST') return errorResult(405, 'method_not_allowed', 'POST only');
  const auth = await deps.verifyAdmin(req.headers.get('authorization'));
  if (!auth.ok) return auth.status === 401 ? errorResult(401, 'unauthorized', 'admin sign-in required') : errorResult(403, 'forbidden', 'admins only');

  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const b = parsed.value;
  const now = deps.now();
  const restaurantId = b.restaurant_id ?? null;
  const needRestaurant = () => (isUuid(restaurantId) ? null : errorResult(400, 'invalid_payload', 'restaurant_id must be a uuid', { field: 'restaurant_id' }));
  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, MAX_LABEL) : null;

  switch (b.action) {
    case 'list': {
      const bad = needRestaurant();
      if (bad) return bad;
      const devices = await deps.store.listDevices(restaurantId as string);
      return okResult({ restaurant_id: restaurantId, devices: devices.map((d) => deviceView(d, now)) });
    }
    case 'create_enrollment': {
      const bad = needRestaurant();
      if (bad) return bad;
      return await createCode(deps, auth.adminId, restaurantId as string, label, null);
    }
    case 'create_reenrollment': {
      const bad = needRestaurant();
      if (bad) return bad;
      if (!isUuid(b.device_id)) return errorResult(400, 'invalid_payload', 'device_id must be a uuid', { field: 'device_id' });
      return await createCode(deps, auth.adminId, restaurantId as string, label, b.device_id);
    }
    case 'revoke': {
      if (!isUuid(b.device_id)) return errorResult(400, 'invalid_payload', 'device_id must be a uuid', { field: 'device_id' });
      if (restaurantId !== null && !isUuid(restaurantId)) return errorResult(400, 'invalid_payload', 'restaurant_id must be a uuid', { field: 'restaurant_id' });
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, MAX_REASON) : '';
      if (!reason) return errorResult(400, 'invalid_payload', 'a reason is required', { field: 'reason' });
      const r = await deps.store.revokeDevice({ deviceId: b.device_id, restaurantId: restaurantId as string | null, reason, actor: auth.adminId, at: now });
      if (r === 'unknown_device') return errorResult(404, 'unknown_device', 'no such device', { field: 'device_id' });
      deps.log('device_revoked', { device_id: b.device_id });
      return okResult({ device_id: b.device_id, status: 'revoked' });
    }
    case 'locked_ips': {
      const rows = await deps.store.failedAttemptsSince(now - IP_DAY_MS);
      const byIp = new Map<string, number[]>();
      for (const r of rows) byIp.set(r.ip, [...(byIp.get(r.ip) ?? []), r.at]);
      const locked = [...byIp.entries()]
        .map(([ip, times]) => {
          times.sort((x, y) => x - y);
          const ms = ipLockMs(times, now);
          return ms === null ? null : {
            ip,
            retry_after_seconds: Math.ceil(ms / 1000),
            failures_15m: times.filter((t) => t > now - IP_WINDOW_MS).length,
            failures_24h: times.length,
          };
        })
        .filter((x) => x !== null);
      return okResult({ locked_ips: locked });
    }
    default:
      return errorResult(400, 'invalid_payload', 'action must be list | create_enrollment | create_reenrollment | revoke | locked_ips', { field: 'action' });
  }
}
