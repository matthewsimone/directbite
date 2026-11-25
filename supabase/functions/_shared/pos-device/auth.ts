/**
 * Device-auth middleware for every pos-v1 device function except register-device
 * (ordr-pos docs/DEVICE-AUTH.md §4.2, SYNC-CONTRACT §1a; reference fakeDeviceAuth.ts `authenticate`).
 *
 *   token  = x-ordr-device-token              missing → 401 device_unregistered
 *   device = pos_devices by sha256(token)     none    → 401 device_unregistered
 *   device.status == 'revoked'                        → 401 device_revoked   (the ONLY lock)
 *   x-ordr-device-id != device.id (incl. missing)     → 403 device_mismatch
 *   → principal { device_id, restaurant_id, prefix }
 *   last_seen_at (+ last_app_version from `x-ordr-client: ordr-pos/<v>`) only if older than 60 s.
 *   Failed lookups write an auth_failed event, capped at 10 a minute.
 *
 * The device pauses on 401 device_unregistered / 403 device_mismatch and locks only on 401
 * device_revoked (DEVICE-AUTH §7.2, amended 2026-11-21) — never send device_revoked for anything else.
 */
import { errorResult, type DeviceResult } from '../pos-sync/http.ts';
import type { DeviceLog } from './log.ts';
import type { DeviceRow, DeviceStore } from './store.ts';
import { hashTag, sha256Hex } from './tokens.ts';

export const SEEN_THROTTLE_MS = 60_000;
export const AUTH_FAILED_EVENTS_PER_MIN = 10;

export interface Principal {
  device_id: string;
  restaurant_id: string;
  prefix: string;
}

export interface AuthDeps {
  store: DeviceStore;
  now: () => number;
  log: DeviceLog;
}

export type AuthResult = { ok: true; principal: Principal; device: DeviceRow } | { ok: false; result: DeviceResult };

export async function authenticateDevice(headers: Headers, deps: AuthDeps): Promise<AuthResult> {
  const { store, log } = deps;
  const now = deps.now();
  const reject = async (status: number, code: string, message: string, device: DeviceRow | null, tokenHash: string | null): Promise<AuthResult> => {
    try {
      await store.recordAuthFailed({ deviceId: device?.id ?? null, restaurantId: device?.restaurant_id ?? null, code, capPerMinute: AUTH_FAILED_EVENTS_PER_MIN, at: now });
    } catch (err) {
      log('auth_failed_event_write_failed', { error: err instanceof Error ? err.message : 'unknown' });
    }
    log('auth_rejected', { code, device_id: device?.id ?? null, token_hash8: hashTag(tokenHash) });
    return { ok: false, result: errorResult(status, code, message) };
  };

  const token = headers.get('x-ordr-device-token');
  if (!token) return await reject(401, 'device_unregistered', 'no device token', null, null);
  const tokenHash = await sha256Hex(token);
  const d = await store.deviceByTokenHash(tokenHash);
  if (!d) return await reject(401, 'device_unregistered', 'unknown device token', null, tokenHash);
  if (d.status === 'revoked') return await reject(401, 'device_revoked', 'this register was revoked', d, tokenHash);
  if (headers.get('x-ordr-device-id') !== d.id) return await reject(403, 'device_mismatch', "x-ordr-device-id is not this token's device", d, tokenHash);

  if (d.last_seen_at === null || d.last_seen_at < now - SEEN_THROTTLE_MS) {
    const client = headers.get('x-ordr-client');
    const appVersion = client?.startsWith('ordr-pos/') ? client.slice('ordr-pos/'.length).slice(0, 40) || null : null;
    try {
      await store.touchDevice({ deviceId: d.id, appVersion, throttleMs: SEEN_THROTTLE_MS, at: now });
    } catch (err) {
      // the heartbeat must never fail a request
      log('touch_failed', { device_id: d.id, error: err instanceof Error ? err.message : 'unknown' });
    }
  }
  return { ok: true, principal: { device_id: d.id, restaurant_id: d.restaurant_id, prefix: d.prefix }, device: d };
}
