/**
 * POS delivery for COUNTER / PHONE orders (CP23; ordr-pos @ 4f729e4 DELIVERY.md §2, §6.3, §7; SYNC-CONTRACT §2):
 *   pos-v1-quote-delivery     address → server geocode → haversine → pinned-snapshot tier fee (pos_delivery_quotes);
 *                             include_uber → Uber quote split by the restaurant's EXISTING passthrough
 *                             (pos_delivery_provider_quotes) → the customer delivery fee for the ticket.
 *   pos-v1-delivery-dispatch  a PAID-IN-FULL, CARD-ONLY POS delivery order → book the provider (Uber Direct) courier.
 *   pos-v1-delivery-cancel    cancel the booked courier (refused once the driver has the food).
 *   pos-v1-delivery-status    the deliveries of some POS orders; a booked one is refreshed from the provider at
 *                             most every 30 s (polling — the live uber-webhook is not used, Matt).
 * Matt's decisions: card only, paid in full before dispatch; driver tip default $0 (delivery.uber.driver_tip_cents);
 * dispatch behind pos_restaurant_settings.pos_delivery_dispatch_enabled (default off; quotes work when off); a full
 * per-delivery ledger; provider-neutral tables. CP20's never-double-book rules: a pending dispatch → 503; a STALE one
 * is re-run only when NO booking row exists (provably nothing sent), else never (booked → applied; booking → stored
 * "outcome unknown"); a provider booking whose row could not be updated → one loud reconcile line; rate_limited →
 * 503 + Retry-After, not stored. No Stripe; nothing touches orders / order_items / uber_quotes.
 */
import { authenticateDevice, type AuthDeps } from '../pos-device/auth.ts';
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import { DRIVER_TIP_MAX_CENTS, UUID_RE } from '../pos-sync/orderPayload.ts';
import { deliveryFeeOf, tiersFromWire, PricingError } from '../pos-sync/orderPricing.ts';
import type { MenuSnapshot } from '../pos-sync/menuSnapshot.ts';
import { haversineDistanceMiles, isValidTimeZone } from '../pos-v1/loader.ts';
import { businessDate } from '../pos-eod/rules.ts';
import { BUSINESS_DAY_CUTOFF } from '../pos-sync/menuSnapshot.ts';
import { localTimeToEpochMs } from '../pos-online/feedQuery.ts';
import type { GeocodeResult } from './geocode.ts';
import { ALERT_CHOICES, DeliveryStoreError, type AlertChoice, type DeliveryAction, type DeliveryRow, type DeliveryStore, type ProviderQuoteRow } from './store.ts';
import { scheduledPickupMs, UBER_RESTAURANT_COLUMNS, uberCancel, uberCreate, uberGet, uberQuote, type UberDeps } from './uberCalls.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export interface DeliveryDeps extends AuthDeps {
  /** Service-role client: restaurants read (the Uber / coordinate columns). */
  // deno-lint-ignore no-explicit-any
  db: { from(table: string): any };
  delivery: DeliveryStore;
  /** The Uber calls' deps (the shared modules imported unchanged). null → provider not configured (quotes: no Uber; dispatch: 501). */
  uber: Omit<UberDeps, 'log'> | null;
  geocode: (address: string) => Promise<GeocodeResult>;
  /** The menu snapshot the order is pinned to (pos_menu_snapshots — a hash of another restaurant counts as unknown). */
  snapshot: (hash: string, restaurantId: string) => Promise<MenuSnapshot | null>;
  /** _shared/uberMode.ts resolveMode (imported unchanged). */
  resolveMode: (restaurant: Row) => { resolved_mode: 'in_house' | 'uber_direct'; reason?: string };
  /** 32 lowercase hex chars (ids dq_… / pq_…). */
  hexId?: () => string;
}

export const QUOTE_TTL_MS = 24 * 3600_000;
export const POLL_EVERY_MS = 30_000;
export const PENDING_STALE_MS = 10 * 60_000;
const PREP = { min: 5, max: 120 } as const;
const UNKNOWN = 'outcome unknown — check the Uber dashboard before dispatching again';
const REASON_PREFIX = /^\[([a-z_]+)\] /;

const bad = (field: string, message: string) => errorResult(400, 'invalid_payload', message, { field });
const hex32 = () => crypto.randomUUID().replace(/-/g, '');
const isoNow = (deps: DeliveryDeps) => new Date(deps.now()).toISOString();
const nullableString = (v: unknown) => v === null || v === undefined || typeof v === 'string';
const uberDeps = (deps: DeliveryDeps): UberDeps | null => (deps.uber ? { ...deps.uber, log: deps.log } : null);

async function auth(req: DeviceRequest, deps: DeliveryDeps, restaurantOptional = false) {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return { result: a.result } as const;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return { result: parsed.result } as const;
  const body = parsed.value as Row;
  if ((!restaurantOptional || body.restaurant_id !== undefined) && body.restaurant_id !== a.principal.restaurant_id) {
    return { result: errorResult(400, 'restaurant_mismatch', "not this device's restaurant", { field: 'restaurant_id' }) } as const;
  }
  return { pr: a.principal, body } as const;
}

async function readRestaurant(deps: DeliveryDeps, rid: string): Promise<Row | null> {
  const { data, error } = await deps.db.from('restaurants').select(UBER_RESTAURANT_COLUMNS).eq('id', rid).maybeSingle();
  if (error) throw new Error(`restaurants read failed: ${error.message}`);
  return data ?? null;
}

function whoOf(body: Row): { actor: string | null; approver: string | null } | DeviceResult {
  const a = body.actor_staff_id;
  if (!(a === null || a === undefined || a === 'register' || (typeof a === 'string' && UUID_RE.test(a)))) return bad('actor_staff_id', "actor_staff_id must be a staff id or 'register'");
  const p = body.approver_staff_id;
  if (!(p === null || p === undefined || (typeof p === 'string' && UUID_RE.test(p)))) return bad('approver_staff_id', 'approver_staff_id must be a staff id or null');
  if (!nullableString(body.device_time)) return bad('device_time', 'device_time must be a string');
  return { actor: typeof a === 'string' ? a.toLowerCase() : null, approver: typeof p === 'string' ? p.toLowerCase() : null };
}
const isResult = (v: unknown): v is DeviceResult => !!v && typeof v === 'object' && 'status' in v && 'body' in v;
const deviceTime = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

// ---- the wire ------------------------------------------------------------------------------------------------

export interface DeliveryWire {
  id: string; order_id: string; provider: string; state: string; provider_status: string | null; tracking_url: string | null;
  courier: { name: string | null; phone: string | null } | null; pickup_ready_at: string | null; pickup_eta: string | null;
  dropoff_eta: string | null; dispatched_at: string | null; delivered_at: string | null; canceled_at: string | null;
  customer_fee_cents: number; driver_tip_cents: number;
  /** Matt (CP23 change): the provider fee booked − the one quoted at the phone call; the restaurant absorbs it (0 normally). */
  fee_delta_cents: number;
  /** null = none charged / not canceled; integer cents when Uber charged one (a POS cancel). */
  cancellation_fee_cents: number | null;
  canceled_by: 'restaurant' | 'provider' | null;
  failure_code: string | null; updated_at: string;
  /**
   * 118 (additive) — the every-register toast: 'provider_canceled' (Uber canceled / returned / failed it) or
   * 'booking_failed' (the booking failed for good — not a rate limit, which the register retries); null = nothing to
   * show. The shared handled mark: once one register handles it, every register clears the toast on its next poll.
   */
  alert: DeliveryAlert | null;
  alert_handled_at: string | null;
  alert_handled_by: string | null;
  alert_choice: AlertChoice | null;
}
export type DeliveryAlert = 'provider_canceled' | 'booking_failed';
/** What the toast is about (null = nothing). Evaluated on an order's LATEST delivery (a re-dispatch supersedes it). */
export function alertOf(r: DeliveryRow): DeliveryAlert | null {
  if (r.state === 'canceled' && r.canceled_by === 'provider') return 'provider_canceled';
  if (r.state === 'failed' && r.failure_code !== 'rate_limited') return 'booking_failed';
  return null;
}
export function deliveryWire(r: DeliveryRow): DeliveryWire {
  return {
    id: r.id, order_id: r.pos_order_id, provider: r.provider, state: r.state, provider_status: r.provider_status, tracking_url: r.tracking_url,
    courier: r.courier, pickup_ready_at: r.pickup_ready_dt, pickup_eta: r.pickup_eta, dropoff_eta: r.dropoff_eta, dispatched_at: r.dispatched_at,
    delivered_at: r.delivered_at, canceled_at: r.canceled_at, customer_fee_cents: r.customer_fee_cents, driver_tip_cents: r.driver_tip_cents,
    // != null: a row read before 116 has no quoted_provider_fee_cents (undefined) → 0
    fee_delta_cents: r.provider_fee_cents != null && r.quoted_provider_fee_cents != null ? r.provider_fee_cents - r.quoted_provider_fee_cents : 0,
    cancellation_fee_cents: r.cancellation_fee_cents ?? null, canceled_by: r.canceled_by ?? null,
    failure_code: r.failure_code, updated_at: r.updated_at,
    alert: alertOf(r), alert_handled_at: r.alert_handled_at ?? null, alert_handled_by: r.alert_handled_by ?? null, alert_choice: r.alert_choice ?? null,
  };
}

// ---- pos-v1-quote-delivery --------------------------------------------------------------------------------------

const ADDRESS_KEYS = ['street', 'city', 'state', 'zip'] as const;

export async function handleQuoteDelivery(req: DeviceRequest, deps: DeliveryDeps): Promise<DeviceResult> {
  const au = await auth(req, deps, true); // DeliveryQuoteRequest has no restaurant_id (contract.ts :263-266)
  if ('result' in au) return au.result!;
  const { pr, body } = au;
  const rid = pr.restaurant_id;
  const a = body.address;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return bad('address', 'address is required');
  for (const k of ADDRESS_KEYS) if (typeof a[k] !== 'string' || !a[k].trim() || a[k].length > 200) return bad(`address.${k}`, `address.${k} is required (≤ 200 characters)`);
  if (!(a.unit === null || a.unit === undefined || (typeof a.unit === 'string' && a.unit.length <= 50))) return bad('address.unit', 'address.unit must be a string or null');
  if (typeof body.menu_snapshot_hash !== 'string' || !body.menu_snapshot_hash || body.menu_snapshot_hash.length > 200) return bad('menu_snapshot_hash', 'menu_snapshot_hash is required');
  if (!(body.include_uber === undefined || typeof body.include_uber === 'boolean')) return bad('include_uber', 'include_uber must be true or false');
  const pickupAt = body.pickup_at;
  if (!(pickupAt === undefined || pickupAt === null || (typeof pickupAt === 'string' && Number.isFinite(Date.parse(pickupAt))))) return bad('pickup_at', 'pickup_at must be ISO-8601 or null');

  const restaurant = await readRestaurant(deps, rid);
  if (!restaurant) return errorResult(400, 'restaurant_mismatch', 'unknown restaurant');
  const rLat = Number(restaurant.latitude);
  const rLng = Number(restaurant.longitude);
  if (restaurant.latitude == null || restaurant.longitude == null || !Number.isFinite(rLat) || !Number.isFinite(rLng)) {
    deps.log('quote_delivery_no_restaurant_coords', { restaurant_id: rid });
    return errorResult(500, 'delivery_config_invalid', 'the restaurant has no coordinates');
  }
  const snap = await deps.snapshot(body.menu_snapshot_hash, rid);
  if (!snap) return errorResult(400, 'unknown_snapshot', 'the menu snapshot is not known for this restaurant', { field: 'menu_snapshot_hash' });

  const unit = typeof a.unit === 'string' && a.unit.trim() ? ` ${a.unit.trim()}` : '';
  const line = `${a.street.trim()}${unit}, ${a.city.trim()}, ${a.state.trim()} ${a.zip.trim()}`;
  const geo = await deps.geocode(line);
  if (geo.kind === 'not_found') return errorResult(400, 'address_not_found', 'the address could not be found — check it', { field: 'address' });
  if (geo.kind === 'unavailable') {
    deps.log('quote_delivery_geocode_unavailable', { restaurant_id: rid, detail: geo.detail });
    return errorResult(503, 'geocode_unavailable', 'the address service is unavailable — use the offline rate', { retryAfterMs: 5_000 });
  }
  // haversine from the restaurant's stored coordinates (pos-v1/loader.ts — R = 3958.8 mi), 2 decimals
  const miles = Math.round(haversineDistanceMiles(rLat, rLng, geo.lat, geo.lng) * 100) / 100;
  const tiers = tiersFromWire(snap.restaurant.delivery);
  let fee: number | null = null;
  try {
    fee = Number(deliveryFeeOf({ mode: 'in_house', distanceMiles: miles, tiers }));
  } catch (err) {
    if (!(err instanceof PricingError)) throw err; // out_of_delivery_range → out of radius (staff may override, §5)
  }
  const inRadius = fee !== null;
  const tier = inRadius ? (tiers.tier1MaxMiles && miles > tiers.tier1MaxMiles ? 2 : 1) : null;
  const nowMs = deps.now();
  const id = `dq_${(deps.hexId ?? hex32)()}`;
  const quote = {
    id, restaurant_id: rid, device_id: pr.device_id,
    address: { street: a.street, unit: a.unit ?? null, city: a.city, state: a.state, zip: a.zip },
    normalized_address: geo.formatted.slice(0, 500), lat: geo.lat.toFixed(6), lng: geo.lng.toFixed(6), distance_miles: miles.toFixed(2),
    in_radius: inRadius, tier, fee_cents: fee, needs_confirmation: geo.partial, menu_snapshot_hash: body.menu_snapshot_hash,
    created_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
  };
  await deps.delivery.insertQuote(quote);

  let uber: Row | null = null;
  let uberReason: string | null = null;
  if (body.include_uber === true) {
    const u = uberDeps(deps);
    const mode = deps.resolveMode(restaurant);
    if (mode.resolved_mode !== 'uber_direct') uberReason = 'not_active';
    else if (!u) uberReason = 'not_configured';
    else {
      const q = await uberQuote(u, restaurant, { dropoff_address: quote.normalized_address, dropoff_lat: geo.lat, dropoff_lng: geo.lng, dropoff_phone: null, scheduled_for: pickupAt ?? null });
      if (!q.success) {
        uberReason = q.error === 'rate_limited' ? 'rate_limited' : q.error === 'delivery_unavailable' ? 'delivery_unavailable' : 'provider_error';
        deps.log('quote_delivery_uber_failed', { restaurant_id: rid, error: q.error, step: q.step ?? null });
      } else {
        const pq: ProviderQuoteRow = {
          id: `pq_${(deps.hexId ?? hex32)()}`, provider: 'uber_direct', provider_quote_id: q.quote_id, restaurant_id: rid, device_id: pr.device_id,
          delivery_quote_id: id, provider_fee_cents: q.fee_cents, customer_fee_cents: q.customer_cents, restaurant_absorbs_cents: q.restaurant_cents,
          passthrough_mode: restaurant.uber_passthrough_mode ?? 'customer_full', passthrough_value: Number(restaurant.uber_passthrough_value || 0),
          billing_mode: restaurant.uber_billing_mode === 'platform' ? 'platform' : 'self', provider_environment: q.environment === 'sandbox' ? 'sandbox' : 'production',
          pickup_ready_dt: pickupAt ? new Date(pickupAt).toISOString() : null, dropoff_eta: q.dropoff_eta ? new Date(q.dropoff_eta).toISOString() : null,
          // uberCreateDelivery.ts :353-355: no expiry from Uber → now + 5 min
          expires_at: q.expires_at ? new Date(q.expires_at).toISOString() : new Date(nowMs + 5 * 60_000).toISOString(),
          created_at: new Date(nowMs).toISOString(),
        };
        await deps.delivery.insertProviderQuote(pq);
        uber = { provider: 'uber_direct', quote_id: pq.id, customer_fee_cents: pq.customer_fee_cents, expires_at: pq.expires_at, dropoff_eta: pq.dropoff_eta };
      }
    }
  }
  return okResult({
    quote_id: id, expires_at: quote.expires_at, normalized_address: quote.normalized_address, needs_confirmation: quote.needs_confirmation,
    lat: quote.lat, lng: quote.lng, distance_miles: quote.distance_miles, in_radius: inRadius, tier, fee_cents: fee,
    max_radius_miles: snap.restaurant.delivery.max_radius_miles, uber, uber_unavailable_reason: uberReason,
  });
}

// ---- dispatch / cancel shared ------------------------------------------------------------------------------------

interface Call { deps: DeliveryDeps; rid: string; deviceId: string; actionId: string; orderId: string }

/** A stored / fresh error as the wire answers it: delivery_failed carries reason. */
function deliveryError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): DeviceResult {
  let msg = message;
  const x: Record<string, unknown> = { ...extra };
  if (code === 'delivery_failed') {
    const r = REASON_PREFIX.exec(message);
    x.reason = r ? r[1] : 'provider_error';
    if (r) msg = message.slice(r[0].length);
  }
  return errorResult(status, code, msg, x);
}

async function currentDelivery(c: Call): Promise<DeliveryWire | null> {
  const r = await c.deps.delivery.latestDelivery(c.rid, c.orderId);
  return r ? deliveryWire(r) : null;
}
async function ok(c: Call, result: 'applied' | 'noop' | 'duplicate'): Promise<DeviceResult> {
  return okResult({ result, delivery: await currentDelivery(c), server_time: isoNow(c.deps) });
}
async function stored(c: Call, status: number, code: string, message: string): Promise<DeviceResult> {
  await c.deps.delivery.finishAction(c.actionId, c.deviceId, 'error', { status, code, message });
  return deliveryError(status, code, message, { delivery: await currentDelivery(c) });
}
async function retryLater(c: Call, retryAfter: unknown): Promise<DeviceResult> {
  await c.deps.delivery.releaseAction(c.actionId, c.deviceId);
  const s = Number(retryAfter);
  return errorResult(503, 'rate_limited', 'Uber is busy — trying again shortly', { retryAfterMs: (Number.isFinite(s) && s > 0 ? s : 60) * 1000 });
}

type Begun = { go: true; stale: boolean } | { go: false; result: DeviceResult };
async function begin(c: Call, action: DeliveryAction, request: Row, who: { actor: string | null; approver: string | null }, dt: string | null): Promise<Begun> {
  const b = await c.deps.delivery.beginAction({ actionId: c.actionId, restaurantId: c.rid, deviceId: c.deviceId, orderId: c.orderId, action, request, actor: who.actor, approver: who.approver, deviceTime: dt });
  if (b.outcome === 'action_id_reused') return { go: false, result: errorResult(409, 'action_id_reused', 'this action_id was used for another request') };
  if (b.outcome === 'duplicate') {
    if (b.stored === 'error') return { go: false, result: deliveryError(b.error_status ?? 500, b.error_code ?? 'internal_error', b.error_message ?? '', { delivery: await currentDelivery(c) }) };
    return { go: false, result: await ok(c, 'duplicate') };
  }
  if (b.outcome === 'pending') {
    const since = Date.parse(b.since ?? '');
    if (!Number.isFinite(since) || c.deps.now() - since < PENDING_STALE_MS) {
      return { go: false, result: errorResult(503, 'action_pending', 'this request is still being processed — try again in a moment', { retryAfterMs: 5_000 }) };
    }
    return { go: true, stale: true };
  }
  return { go: true, stale: false };
}

function requestOf(body: Row): Row {
  // accepted_quote_id: retired (Matt, CP23 change) — ignored if an older POS sends it, and kept out of the request hash so
  // a resend with / without it is the same request
  const { device_time: _d, accepted_quote_id: _a, ...rest } = body;
  void _d;
  void _a;
  return rest;
}

// ---- pos-v1-delivery-dispatch ------------------------------------------------------------------------------------

export async function handleDeliveryDispatch(req: DeviceRequest, deps: DeliveryDeps): Promise<DeviceResult> {
  const au = await auth(req, deps);
  if ('result' in au) return au.result!;
  const { pr, body } = au;
  const rid = pr.restaurant_id;
  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  if (typeof body.order_id !== 'string' || !UUID_RE.test(body.order_id)) return bad('order_id', 'order_id must be a UUID');
  // ASAP: pickup_ready_minutes (5–120) from now. Scheduled (cp23b, Matt's R1 — online's mechanism): pickup_ready_at =
  // the customer's slot; booked NOW for slot − the restaurant's lead (scheduledPickupMs). Exactly one of the two.
  const prep = body.pickup_ready_minutes;
  const slot = body.pickup_ready_at;
  const hasPrep = prep !== undefined && prep !== null;
  const hasSlot = slot !== undefined && slot !== null;
  if (hasPrep === hasSlot) return bad('pickup_ready_minutes', 'send exactly one of pickup_ready_minutes / pickup_ready_at');
  if (hasPrep && !(typeof prep === 'number' && Number.isInteger(prep) && prep >= PREP.min && prep <= PREP.max)) return bad('pickup_ready_minutes', `pickup_ready_minutes must be ${PREP.min}–${PREP.max}`);
  const slotMs = hasSlot && typeof slot === 'string' ? Date.parse(slot) : NaN;
  // uber-create-delivery :170-182: an absolute pickup time must be in the future
  if (hasSlot && !(Number.isFinite(slotMs) && slotMs > deps.now())) return bad('pickup_ready_at', 'pickup_ready_at must be a future ISO-8601 time');
  const who = whoOf(body);
  if (isResult(who)) return who;
  const u = uberDeps(deps);
  if (!u) return errorResult(501, 'not_implemented', 'delivery dispatch is not configured on this server');
  // Matt: per-restaurant switch, default off (platform-billing recovery undecided). Quotes still work.
  if (!(await deps.delivery.dispatchEnabled(rid))) return errorResult(403, 'delivery_not_enabled', 'delivery dispatch is not switched on for this restaurant');

  const c: Call = { deps, rid, deviceId: pr.device_id, actionId: body.action_id.toLowerCase(), orderId: body.order_id.toLowerCase() };
  const order = await deps.delivery.getPosOrder(rid, c.orderId);
  if (!order) return errorResult(400, 'unknown_order', 'no such order (sync it first)', { field: 'order_id' });

  const b = await begin(c, 'dispatch', requestOf(body), who, deviceTime(body.device_time));
  if (!b.go) return b.result;
  if (b.stale) {
    const prior = await deps.delivery.deliveryByAction(c.actionId);
    deps.log('delivery_dispatch_stale', { action_id: c.actionId, order_id: c.orderId, prior_state: prior?.state ?? null });
    if (prior) {
      // never re-run a dispatch that reached the provider step
      if (prior.state === 'booked' || prior.state === 'delivered' || prior.state === 'canceled') {
        await deps.delivery.finishAction(c.actionId, c.deviceId, 'applied');
        return ok(c, 'applied');
      }
      if (prior.state === 'booking') {
        await deps.delivery.updateDelivery(prior.id, { state: 'failed', failure_code: 'outcome_unknown', failure_message: UNKNOWN });
        return stored(c, 502, 'delivery_failed', `[provider_error] ${UNKNOWN}`);
      }
      return stored(c, 502, 'delivery_failed', `[provider_error] ${prior.failure_message ?? 'the earlier attempt failed'}`);
    }
    // no booking row: the claim precedes every provider call → provably nothing sent; run it now
  }

  // the order: a provider delivery, paid in full, card only (Matt)
  const d = order.delivery ?? {};
  if (order.order_type !== 'delivery') return stored(c, 400, 'action_not_allowed', 'not a delivery order');
  if (d.driver_type !== 'uber_direct' || d.fee_source !== 'uber') return stored(c, 400, 'action_not_allowed', 'not an Uber delivery (driver_type uber_direct, fee_source uber)');
  const captured = order.payments.filter((p) => p.status === 'captured');
  if (captured.some((p) => p.method === 'cash')) return stored(c, 400, 'card_only', 'Uber deliveries are paid by card only');
  const paid = captured.reduce((s, p) => s + p.amount_cents, 0);
  if (order.status !== 'closed' || paid < order.total_cents) return stored(c, 409, 'not_paid', 'the order must be paid in full before dispatch');
  const quoteRef = d.uber?.quote_id;
  const pq = typeof quoteRef === 'string' ? await deps.delivery.getProviderQuote(rid, quoteRef) : null;
  if (!pq) return stored(c, 400, 'quote_unknown', 'the order has no Uber quote of this restaurant');
  const dq = await deps.delivery.getQuote(rid, pq.delivery_quote_id);
  if (!dq) return stored(c, 400, 'quote_unknown', 'the delivery quote is missing');
  // Matt, R2 / option A — online's rule: ONE tip, the order's own; Uber gets min(tip, 500) (the copied create call),
  // anything above stays with the restaurant. delivery.uber.driver_tip_cents is retired (ignored).
  const tip = order.tip_cents;
  const driverTip = Math.min(tip, DRIVER_TIP_MAX_CENTS);

  const claim = await deps.delivery.claimDelivery({
    pos_order_id: c.orderId, restaurant_id: rid, provider: 'uber_direct', action_id: c.actionId, provider_quote_ref: pq.id, provider_quote_id: null,
    customer_fee_cents: pq.customer_fee_cents, quoted_provider_fee_cents: pq.provider_fee_cents, driver_tip_cents: driverTip, billing_mode: pq.billing_mode,
    provider_environment: pq.provider_environment,
  });
  if (claim.outcome === 'active_exists') return stored(c, 409, 'already_dispatched', `this order already has a ${claim.delivery.state} delivery`);
  const row = claim.delivery;
  const failRow = async (code: string, message: string) => {
    await deps.delivery.updateDelivery(row.id, { state: 'failed', failure_code: code, failure_message: message.slice(0, 500) });
  };

  const restaurant = await readRestaurant(deps, rid);
  if (!restaurant) {
    await failRow('restaurant_not_found', 'restaurant not found');
    return stored(c, 400, 'restaurant_mismatch', 'unknown restaurant');
  }

  // Matt (CP23 change): the customer's fee is LOCKED at the phone call. The order's quote if still fresh; else the
  // server re-quotes and books automatically — never a 409, never a staff prompt, the customer never re-charged. Any
  // difference (+ or −) is the restaurant's (restaurant_absorbs_cents, signed). The copied price guard (priceChanged,
  // webPins.json) stays pinned but is not branched on.
  let use: ProviderQuoteRow = pq;
  const fresh = (q: ProviderQuoteRow) => Date.parse(q.expires_at) > deps.now() + 60_000; // the web's 60 s buffer
  if (!fresh(pq)) {
    const q = await uberQuote(u, restaurant, { dropoff_address: dq.normalized_address, dropoff_lat: Number(dq.lat), dropoff_lng: Number(dq.lng), dropoff_phone: order.customer_phone_e164, scheduled_for: null });
    if (!q.success) {
      if (q.error === 'rate_limited') {
        await failRow('rate_limited', 'Uber rate limited the re-quote');
        return retryLater(c, q.retry_after);
      }
      await failRow(q.error === 'delivery_unavailable' ? 'no_courier_available' : 'provider_error', `re-quote: ${q.error}`);
      return stored(c, 502, 'delivery_failed', q.error === 'delivery_unavailable'
        ? '[no_courier_available] no Uber courier is available for this address right now'
        : `[provider_error] Uber could not re-quote the delivery (${q.error})`);
    }
    const nowMs = deps.now();
    const fresher: ProviderQuoteRow = {
      ...pq, id: `pq_${(deps.hexId ?? hex32)()}`, provider_quote_id: q.quote_id, device_id: c.deviceId, provider_fee_cents: q.fee_cents,
      customer_fee_cents: q.customer_cents, restaurant_absorbs_cents: q.restaurant_cents, dropoff_eta: q.dropoff_eta ? new Date(q.dropoff_eta).toISOString() : null,
      expires_at: q.expires_at ? new Date(q.expires_at).toISOString() : new Date(nowMs + 5 * 60_000).toISOString(), created_at: new Date(nowMs).toISOString(),
    };
    await deps.delivery.insertProviderQuote(fresher);
    if (fresher.provider_fee_cents !== pq.provider_fee_cents) {
      deps.log('delivery_dispatch_fee_delta', { order_id: c.orderId, action_id: c.actionId, quoted_cents: pq.provider_fee_cents, booked_cents: fresher.provider_fee_cents });
    }
    use = fresher;
  }

  const created = await uberCreate(u, restaurant, {
    quote_id: use.provider_quote_id, order_label: order.ticket_label, customer_name: order.customer_name, customer_phone: order.customer_phone_e164,
    delivery_address: dq.normalized_address, dropoff_notes: d.address?.instructions ?? order.note ?? null, dropoff_lat: Number(dq.lat), dropoff_lng: Number(dq.lng),
    lines: order.lines, subtotal_cents: order.subtotal_cents, tip_cents: tip,
    pickup_ready_ms: hasSlot ? scheduledPickupMs(restaurant, slotMs, deps.now(), deps.log) : deps.now() + (prep as number) * 60_000, external_id: c.orderId,
  });
  if (!created.success) {
    if (created.error === 'rate_limited') {
      await failRow('rate_limited', 'Uber rate limited the booking');
      return retryLater(c, created.retry_after);
    }
    const reason = created.error === 'bad_address' ? 'bad_address' : 'provider_error';
    await failRow(reason, `${created.error}${created.detail ? `: ${created.detail}` : ''}`);
    deps.log('delivery_dispatch_failed', { order_id: c.orderId, action_id: c.actionId, error: created.error, step: created.step ?? null });
    return stored(c, 502, 'delivery_failed', reason === 'bad_address' ? '[bad_address] Uber rejected this address' : `[provider_error] Uber could not book the delivery (${created.error})`);
  }
  const now = isoNow(deps);
  try {
    await deps.delivery.updateDelivery(row.id, {
      state: 'booked', provider_delivery_id: created.delivery_id, tracking_url: created.tracking_url, provider_status: created.status, status_updated_at: now,
      dispatched_at: now, pickup_ready_dt: created.pickup_ready_dt, provider_quote_ref: use.id, provider_quote_id: use.provider_quote_id,
      provider_fee_cents: use.provider_fee_cents,
      // the restaurant covers whatever the customer's locked fee does not — signed, never floored (Matt): negative when
      // Uber got cheaper than the customer paid
      restaurant_absorbs_cents: use.provider_fee_cents - row.customer_fee_cents,
    });
  } catch (err) {
    // the courier IS booked; the row could not say so — one loud line for the manual reconcile, never retried
    deps.log('POS_DELIVERY_UNPERSISTED_RECONCILE', { order_id: c.orderId, provider_delivery_id: created.delivery_id, action_id: c.actionId, error: err instanceof Error ? err.message : String(err) });
    return stored(c, 502, 'delivery_failed', '[provider_error] Uber booked a courier but it could not be saved — check the Uber dashboard');
  }
  await deps.delivery.finishAction(c.actionId, c.deviceId, 'applied');
  return ok(c, 'applied');
}

// ---- pos-v1-delivery-cancel --------------------------------------------------------------------------------------

export async function handleDeliveryCancel(req: DeviceRequest, deps: DeliveryDeps): Promise<DeviceResult> {
  const au = await auth(req, deps);
  if ('result' in au) return au.result!;
  const { pr, body } = au;
  const rid = pr.restaurant_id;
  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  if (typeof body.order_id !== 'string' || !UUID_RE.test(body.order_id)) return bad('order_id', 'order_id must be a UUID');
  const who = whoOf(body);
  if (isResult(who)) return who;
  const u = uberDeps(deps);
  if (!u) return errorResult(501, 'not_implemented', 'delivery cancel is not configured on this server');
  const c: Call = { deps, rid, deviceId: pr.device_id, actionId: body.action_id.toLowerCase(), orderId: body.order_id.toLowerCase() };
  const b = await begin(c, 'cancel', requestOf(body), who, deviceTime(body.device_time));
  if (!b.go) return b.result;
  if (b.stale) deps.log('delivery_cancel_rerun', { action_id: c.actionId, order_id: c.orderId }); // Uber answers 200 to a re-cancel: safe

  const row = await deps.delivery.latestDelivery(rid, c.orderId);
  if (!row || row.state === 'failed') return stored(c, 400, 'no_active_delivery', 'this order has no booked delivery');
  if (row.state === 'canceled') {
    await deps.delivery.finishAction(c.actionId, c.deviceId, 'noop');
    return ok(c, 'noop');
  }
  if (row.state === 'delivered') return stored(c, 400, 'already_delivered', 'the order was already delivered');
  if (row.state === 'booking') return stored(c, 409, 'dispatch_in_flight', 'a dispatch is still in progress — try again in a moment');
  const restaurant = await readRestaurant(deps, rid);
  if (!restaurant) return stored(c, 400, 'restaurant_mismatch', 'unknown restaurant');
  const r = await uberCancel(u, restaurant, row.provider_delivery_id!);
  if (!r.success) {
    if (r.error === 'rate_limited') return retryLater(c, r.retry_after);
    const reason = r.error === 'uber_cancel_failed' ? 'cannot_cancel' : 'provider_error';
    deps.log('delivery_cancel_failed', { order_id: c.orderId, action_id: c.actionId, error: r.error });
    return stored(c, 502, 'delivery_failed', reason === 'cannot_cancel' ? '[cannot_cancel] Uber could not cancel — the driver may already have the food' : `[provider_error] Uber could not cancel the delivery (${r.error})`);
  }
  const now = isoNow(deps);
  await deps.delivery.updateDelivery(row.id, {
    state: 'canceled', canceled_by: 'restaurant', canceled_at: now, provider_status: 'canceled', status_updated_at: now,
    // null = Uber charged none (uberCancel.ts gives uberFee only when Uber reports a fee)
    cancellation_fee_cents: Number.isSafeInteger(r.uberFee) && (r.uberFee as number) > 0 ? r.uberFee as number : null,
  });
  await deps.delivery.finishAction(c.actionId, c.deviceId, 'applied');
  return ok(c, 'applied');
}

// ---- pos-v1-delivery-status ---------------------------------------------------------------------------------------

/** Uber's delivery statuses that end a booking (the webhook's own words: delivered / canceled / returned). */
const DONE_DELIVERED = new Set(['delivered']);
// + 'failed' (cp23b, Matt): online treats it as terminal (uber-webhook/index.ts :124-129)
const DONE_CANCELED = new Set(['canceled', 'returned', 'failed']);

/** Refresh a booked delivery from the provider at most every POLL_EVERY_MS (restaurant-wide: claimPoll is shared). */
async function refreshBooked(deps: DeliveryDeps, rid: string, row: DeliveryRow, cache: { restaurant?: Row | null }, label: string): Promise<DeliveryRow> {
  const u = uberDeps(deps);
  if (row.state !== 'booked' || !row.provider_delivery_id || !u) return row;
  const nowMs = deps.now();
  const cutoff = new Date(nowMs - POLL_EVERY_MS).toISOString();
  if (row.last_polled_at !== null && row.last_polled_at >= cutoff) return row; // refreshed < 30 s ago by some register
  if (!(await deps.delivery.claimPoll(row.id, cutoff, new Date(nowMs).toISOString()))) return row;
  if (cache.restaurant === undefined) cache.restaurant = await readRestaurant(deps, rid);
  const g = cache.restaurant ? await uberGet(u, cache.restaurant, row.provider_delivery_id) : null;
  if (g && g.success) {
    const now = new Date(nowMs).toISOString();
    const patch: Row = { courier: g.courier, pickup_eta: g.pickup_eta, dropoff_eta: g.dropoff_eta };
    if (g.tracking_url) patch.tracking_url = g.tracking_url;
    if (g.status && g.status !== row.provider_status) Object.assign(patch, { provider_status: g.status, status_updated_at: now });
    if (g.status && DONE_DELIVERED.has(g.status)) Object.assign(patch, { state: 'delivered', delivered_at: now });
    if (g.status && DONE_CANCELED.has(g.status)) Object.assign(patch, { state: 'canceled', canceled_by: 'provider', canceled_at: now });
    try {
      return await deps.delivery.updateDelivery(row.id, patch);
    } catch (err) {
      if (!(err instanceof DeliveryStoreError)) throw err;
      deps.log('delivery_status_apply_refused', { order_id: label, error: err.message });
    }
  } else if (g) deps.log('delivery_status_refresh_failed', { order_id: label, error: g.error });
  return row;
}

/** 118: the restaurant-wide read answers at most this many orders. */
export const RESTAURANT_SCOPE_LIMIT = 100;

export async function handleDeliveryStatus(req: DeviceRequest, deps: DeliveryDeps): Promise<DeviceResult> {
  const au = await auth(req, deps);
  if ('result' in au) return au.result!;
  const { pr, body } = au;
  const rid = pr.restaurant_id;
  if (body.scope !== undefined && body.scope !== null) {
    if (body.scope !== 'restaurant') return bad('scope', "scope must be 'restaurant' or absent");
    if (body.order_ids !== undefined && body.order_ids !== null) return bad('order_ids', "scope 'restaurant' takes no order_ids");
    return restaurantStatus(deps, rid);
  }
  const ids = body.order_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every((x) => typeof x === 'string' && UUID_RE.test(x))) return bad('order_ids', 'order_ids: 1–50 order ids');
  const out: { order_id: string; delivery: DeliveryWire | null }[] = [];
  const cache: { restaurant?: Row | null } = {};
  for (const raw of [...new Set(ids.map((x: string) => x.toLowerCase()))] as string[]) {
    let row = await deps.delivery.latestDelivery(rid, raw);
    if (row) row = await refreshBooked(deps, rid, row, cache, raw);
    out.push({ order_id: raw, delivery: row ? deliveryWire(row) : null });
  }
  return okResult({ deliveries: out, server_time: isoNow(deps) });
}

/**
 * 118 — scope 'restaurant' (POS-005, the every-register toast): every POS order's LATEST delivery that is live
 * (booking / booked) or changed since the business-day start (the restaurant's time zone, 04:00 cutoff — the feed's
 * rule), newest first, with the ticket label and the customer's name / phone (staff only — device-authed). Booked
 * deliveries are refreshed exactly as in the order_ids mode (at most once per 30 s per delivery, shared by all
 * registers).
 */
async function restaurantStatus(deps: DeliveryDeps, rid: string): Promise<DeviceResult> {
  const { data: r, error } = await deps.db.from('restaurants').select('timezone').eq('id', rid).maybeSingle();
  if (error) throw new Error(`restaurants read failed: ${error.message}`);
  if (!r || !isValidTimeZone(r.timezone)) return errorResult(500, 'delivery_config_invalid', 'the restaurant has no valid time zone');
  const nowMs = deps.now();
  const day = businessDate(nowMs, r.timezone, BUSINESS_DAY_CUTOFF);
  const since = new Date(localTimeToEpochMs(day, BUSINESS_DAY_CUTOFF, r.timezone)).toISOString();
  const rows = await deps.delivery.restaurantDeliveries(rid, since, RESTAURANT_SCOPE_LIMIT);
  const cache: { restaurant?: Row | null } = {};
  const out = [];
  for (const x of rows) {
    const d = await refreshBooked(deps, rid, x.delivery, cache, x.delivery.pos_order_id);
    out.push({
      order_id: d.pos_order_id, ticket_label: x.order.ticket_label,
      customer: { name: x.order.customer_name, phone: x.order.customer_phone_e164 },
      delivery: deliveryWire(d),
    });
  }
  return okResult({ deliveries: out, business_day: day, server_time: isoNow(deps) });
}

// ---- pos-v1-delivery-alert (118) ---------------------------------------------------------------------------------

/**
 * The every-register toast's shared "handled" mark (POS-005): { action_id, restaurant_id, order_id, delivery_id,
 * choice: in_house | acknowledged, actor_staff_id, approver_staff_id, device_time }. Idempotent by action_id
 * (pos_delivery_actions, action 'alert'). The FIRST register wins — set once; another register's mark answers noop
 * with the existing mark. Every register clears the toast on its next status poll (alert_handled_at set).
 *   - the order's latest delivery isn't `delivery_id` (re-dispatched meanwhile) → 409 delivery_changed (+ the latest)
 *   - nothing to handle (no provider cancel / failed booking) → 400 no_alert
 * Errors are stored (a resend replays them). No provider call.
 */
export async function handleDeliveryAlert(req: DeviceRequest, deps: DeliveryDeps): Promise<DeviceResult> {
  const au = await auth(req, deps);
  if ('result' in au) return au.result!;
  const { pr, body } = au;
  const rid = pr.restaurant_id;
  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  if (typeof body.order_id !== 'string' || !UUID_RE.test(body.order_id)) return bad('order_id', 'order_id must be a UUID');
  if (typeof body.delivery_id !== 'string' || !UUID_RE.test(body.delivery_id)) return bad('delivery_id', 'delivery_id must be a UUID');
  if (!ALERT_CHOICES.includes(body.choice)) return bad('choice', `choice must be ${ALERT_CHOICES.join(' or ')}`);
  const who = whoOf(body);
  if (isResult(who)) return who;
  const c: Call = { deps, rid, deviceId: pr.device_id, actionId: body.action_id.toLowerCase(), orderId: body.order_id.toLowerCase() };
  const b = await begin(c, 'alert', requestOf(body), who, deviceTime(body.device_time));
  if (!b.go) return b.result;
  if (b.stale) deps.log('delivery_alert_rerun', { action_id: c.actionId, order_id: c.orderId }); // set-once: a re-run is safe
  const row = await deps.delivery.latestDelivery(rid, c.orderId);
  if (row && row.id !== body.delivery_id.toLowerCase()) return stored(c, 409, 'delivery_changed', 'the order has a newer delivery — refresh');
  if (!row || alertOf(row) === null) return stored(c, 400, 'no_alert', 'nothing to handle on this delivery');
  const marked = await deps.delivery.markAlert(row.id, { at: isoNow(deps), by: who.actor ?? 'register', deviceId: c.deviceId, choice: body.choice as AlertChoice });
  await deps.delivery.finishAction(c.actionId, c.deviceId, marked === 'marked' ? 'applied' : 'noop');
  return ok(c, marked === 'marked' ? 'applied' : 'noop');
}
