/**
 * CP8 checkout enforcement for create-payment-intent (G1-lite + P2 + P6, decision A).
 * Loaded ONLY through enforceGuard.ts for restaurants on POS_V1_ENFORCE_RESTAURANTS.
 *
 * Order of checks (first failure wins):
 *   1. pause (decision A, Matt 2026-11-23): restaurants.is_open = false → 409 restaurant_closed,
 *      for ASAP AND scheduled orders.
 *   2. P2: delivery while restaurants.delivery_available = false → 409 delivery_unavailable.
 *   3. P6 hours (restaurants.timezone): ASAP outside the order type's effective schedule →
 *      409 restaurant_closed; a scheduled time outside the schedule, in the past, unparseable or
 *      beyond 7 local days → 409 slot_unavailable.
 *   4. G1-lite price: the cart is priced synchronously with the same translate + loader + vendored
 *      module as shadow mode. client amount < server total − 2¢ → 409 price_changed
 *      (+ server_total_cents). Paying MORE than the server total is left alone (unchanged).
 *      Untranslatable cart / in-house delivery without coords / any pricer error → 503
 *      pricing_unavailable (fail closed) with a `reason`.
 * Returns null when the order may proceed.
 */
import { priceOrder, PricingError } from '../ordr-core/order/index.ts';
import { checkSlot, getEffectiveSchedule, isOpenAt, isValidTimeZone, type HoursRow } from '../hours/serviceHours.ts';
import type { PricingDb } from './db.ts';
import { ApiError, fromPricingError } from './errors.ts';
import type { GuardBlock } from './enforceGuard.ts';
import { loadPricingInput } from './loader.ts';
import { parsePriceRequest } from './request.ts';
import { translateOrderData } from './shadow.ts';

/** Underpayment tolerance (the existing D-1 ±2¢ of create-payment-intent's Uber branch). */
export const PRICE_TOLERANCE_CENTS = 2;

export interface ServiceInfo {
  is_open: boolean | null;
  delivery_available: boolean | null;
  pickup_schedule: unknown;
  delivery_schedule: unknown;
  timezone: string | null;
  hours: HoursRow[];
}

export interface EnforceInput {
  restaurantId: string;
  orderData: unknown;
  /** The `amount` create-payment-intent is about to charge (cents, from the client). */
  clientAmount: unknown;
  sessionToken: unknown;
  now: Date;
}

export interface EnforceDeps {
  db: PricingDb;
  loadServiceInfo: (restaurantId: string) => Promise<ServiceInfo | null>;
}

const block = (status: number, error: string, extra: Record<string, unknown> = {}): GuardBlock => ({ status, body: { error, ...extra } });
const unavailable = (reason: string) => block(503, 'pricing_unavailable', { reason });

export async function enforceCheckout(input: EnforceInput, deps: EnforceDeps): Promise<GuardBlock | null> {
  const od = (input.orderData && typeof input.orderData === 'object' ? input.orderData : {}) as Record<string, unknown>;
  const type = od.order_type;
  if (type !== 'pickup' && type !== 'delivery') return unavailable('order_type');

  const info = await deps.loadServiceInfo(input.restaurantId);
  if (!info) return unavailable('restaurant_info');
  if (!isValidTimeZone(info.timezone)) return unavailable('timezone');

  // 1. pause — ASAP and scheduled alike (decision A)
  if (info.is_open !== true) return block(409, 'restaurant_closed', { reason: 'paused' });

  // 2. delivery switch
  if (type === 'delivery' && info.delivery_available !== true) return block(409, 'delivery_unavailable');

  // 3. hours
  const schedule = getEffectiveSchedule(info, info.hours, type);
  const rawSlot = od.scheduled_for;
  if (rawSlot === null || rawSlot === undefined || rawSlot === '') {
    if (!isOpenAt(schedule, input.now, info.timezone)) return block(409, 'restaurant_closed', { reason: 'outside_hours' });
  } else {
    const slot = typeof rawSlot === 'string' ? new Date(rawSlot) : null;
    if (!slot || Number.isNaN(slot.getTime())) return block(409, 'slot_unavailable', { reason: 'invalid' });
    const verdict = checkSlot(schedule, slot, input.now, info.timezone);
    if (verdict !== 'ok') return block(409, 'slot_unavailable', { reason: verdict });
  }

  // 4. price
  const t = translateOrderData(input.orderData, input.restaurantId, input.sessionToken);
  if (t.noCoords) return unavailable('no_coords');
  if (t.untranslatable.length || !t.body) return unavailable('untranslatable');
  let total: number;
  try {
    const req = parsePriceRequest(t.body);
    const loaded = await loadPricingInput(deps.db, req, { channel: 'online', now: input.now });
    total = priceOrder(loaded.order, loaded.config).total;
  } catch (err) {
    const api = err instanceof ApiError ? err : err instanceof PricingError ? fromPricingError(err) : null;
    if (!api) throw err; // → enforceGuard: 503 internal_error
    return unavailable(api.code);
  }
  const amount = input.clientAmount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < total - PRICE_TOLERANCE_CENTS) {
    return block(409, 'price_changed', { server_total_cents: total });
  }
  return null;
}

/** Service-role read of what the checks need (explicit columns; never secrets). */
// deno-lint-ignore no-explicit-any
export function supabaseServiceInfo(client: { from(table: string): any }) {
  return async (restaurantId: string): Promise<ServiceInfo | null> => {
    const [r, h] = await Promise.all([
      client.from('restaurants').select('is_open, delivery_available, pickup_schedule, delivery_schedule, timezone').eq('id', restaurantId).maybeSingle(),
      client.from('hours').select('day_of_week, is_open, open_time, close_time').eq('restaurant_id', restaurantId).order('day_of_week'),
    ]);
    if (r.error) throw new Error(`restaurants read failed: ${r.error.message}`);
    if (h.error) throw new Error(`hours read failed: ${h.error.message}`);
    if (!r.data) return null;
    return { ...r.data, hours: h.data ?? [] } as ServiceInfo;
  };
}
