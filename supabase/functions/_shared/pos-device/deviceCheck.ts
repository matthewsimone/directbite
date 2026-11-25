/**
 * pos-v1-device-check — DIAGNOSTIC device-authed function (not part of SYNC-CONTRACT §2).
 * Proves on a deployed project that the gateway passes x-ordr-device-token / x-ordr-device-id
 * through untouched with verify_jwt = false (DEVICE-AUTH §4; audit item 0.g), before
 * pos-v1-menu-snapshot exists. Returns the principal + server_time. Body `restaurant_id`, when
 * present, must be the principal's (same rule as the snapshots).
 */
import { okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import { authenticateDevice, type AuthDeps } from './auth.ts';
import { restaurantIdentity } from './identity.ts';

export async function handleDeviceCheck(req: DeviceRequest, deps: AuthDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  if ('restaurant_id' in parsed.value) {
    const bad = restaurantIdentity(parsed.value, a.principal);
    if (bad) return bad;
  }
  return okResult({ ...a.principal, server_time: new Date(deps.now()).toISOString() });
}
