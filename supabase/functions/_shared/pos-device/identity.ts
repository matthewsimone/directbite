/**
 * Identity rules for device functions (ordr-pos SYNC-CONTRACT §1a, DEVICE-AUTH §4.3).
 * Reference: `orderIdentity` / `entityIdentity` / the snapshot checks in fakeServer.ts `invoke`.
 * Run these AFTER the middleware and BEFORE the content-hash check, in this order.
 *
 * Ticket prefix rule — APPROVED (Matt, 2026-11-21; DEVICE-AUTH §4.3), quoted from
 * DIRECTBITE-HANDOFF item 0:
 *   "a **new** order's `ticket.prefix` must be the principal's prefix; an order the server
 *   **already has** keeps its stored ticket prefix — the request's prefix must equal it (another
 *   register of the restaurant may write the order under SYNC-CONTRACT §3.1, but can never change
 *   its ticket). Either violation → `400 prefix_mismatch`."
 */
import { errorResult, type DeviceResult } from '../pos-sync/http.ts';
import type { Principal } from './auth.ts';

export const IN_PERSON_CHANNELS = new Set(['counter', 'phone', 'dine_in']);

/** What the server already stores for an order (null = new order). */
export interface ExistingOrder {
  restaurant_id: string;
  ticket_prefix: string;
}

/** pos-v1-submit-order (§1a rows 1–5). */
export function orderIdentity(
  p: { restaurant_id?: unknown; device_id?: unknown; ticket?: { prefix?: unknown } | null; channel?: unknown },
  pr: Principal,
  existing: ExistingOrder | null,
): DeviceResult | null {
  if (p.restaurant_id !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', "restaurant_id is not this device's restaurant", { field: 'restaurant_id' });
  if (p.device_id !== pr.device_id) return errorResult(403, 'device_mismatch', 'device_id is not this device', { field: 'device_id' });
  if (existing && existing.restaurant_id !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant', { field: 'order_id' });
  const expected = existing ? existing.ticket_prefix : pr.prefix;
  const got = p.ticket?.prefix;
  if (got !== expected) {
    return errorResult(400, 'prefix_mismatch', existing ? `the order's ticket prefix is ${expected}` : `ticket prefix ${String(got)} is not this device's (${pr.prefix})`, { field: 'ticket.prefix' });
  }
  if (typeof p.channel !== 'string' || !IN_PERSON_CHANNELS.has(p.channel)) {
    return errorResult(400, 'invalid_payload', `channel ${String(p.channel)}: a register submits counter | phone | dine_in only`, { field: 'channel' });
  }
  return null;
}

/** submit-shift / -refund / -day-close / -staff-events (§1a row 7). */
export function entityIdentity(p: { restaurant_id?: unknown; device_id?: unknown }, pr: Principal, existingRestaurantId: string | null): DeviceResult | null {
  if (p.restaurant_id !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', "restaurant_id is not this device's restaurant", { field: 'restaurant_id' });
  if (p.device_id !== pr.device_id) return errorResult(403, 'device_mismatch', 'device_id is not this device', { field: 'device_id' });
  if (existingRestaurantId !== null && existingRestaurantId !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', 'it belongs to another restaurant');
  return null;
}

/** menu-snapshot / staff-snapshot (and any body that names a restaurant): body restaurant_id = principal. */
export function restaurantIdentity(p: { restaurant_id?: unknown }, pr: Principal): DeviceResult | null {
  if (p.restaurant_id !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', "not this device's restaurant", { field: 'restaurant_id' });
  return null;
}
