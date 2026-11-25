/**
 * pos-v1-submit-order (SYNC-CONTRACT §1a, §3; DIRECTBITE-HANDOFF items 2, 3, 6).
 *
 * Check order = the reference (ordr-pos a685442 test/support/fakeServer.ts; line numbers below), with the
 * server-only steps marked +:
 *   1. device middleware (401 device_unregistered / device_revoked, 403 device_mismatch)
 *   +  JSON object, nesting ≤ 32                                                           → 400 invalid_payload
 *   2. identity §1a: restaurant_mismatch, device_mismatch, existing order of another restaurant,
 *      ticket prefix (new = principal's; existing = stored), channel in person, modifier size_prices
 *      (the size_prices rule is also in step 3)                         invoke :204, orderIdentity :261-280
 *   3. structure = orderPayloadCheck.ts (UUID ids incl. order_id :46, no duplicate ids, integers, ISO
 *      times, tip shape, size_prices array, payments[].void_reason :107-109) → 400 invalid_payload  handle :918-920
 *   4. content_hash recompute (canonical JSON minus content_hash / device_time)                 :921-923
 *   5. redemption / reward keys anywhere except provisional_pricing → 400 redemption_not_allowed  :924-926
 *   6. card-number-like free text (vendored cardData.ts) → 400 card_data_rejected               :929-930
 *   7. payment shape (cash / external_card) → 400 invalid_payload                               :931-934
 *   8. §3.1 idempotency + versions: duplicate (ORIGINAL response) / 409 idempotency_key_reuse /
 *      stale_ignored / 409 version_conflict (+ server_version, server_writer_device_id)    :936-953
 *   9. price against the PINNED snapshot (unknown → current + unknown_snapshot; none → 400) with the
 *      vendored priceOrder, in-person config; PricingError → 400 pricing_error:<code>;
 *      unknown_menu_item / unknown_topping / invalid_payload from the builder              :955-963, price()
 *  10. payments insert-only, ALL-OR-NOTHING: every payment checked before any is written (amount / order /
 *      method / card fields immutable; captured → voided only) → 400 invalid_payload       :965-985
 *  11. store (one transaction) → 200 applied: flags mismatch / stale_price / unknown_snapshot /
 *      availability_flag (+ delivery), diff, pricing_module_hash, order_number, server_time  :987-1011
 *
 * Steps 8, 10, 11 run again atomically inside the store's apply (pos_apply_order_submission), so a
 * concurrent writer between the pre-check and the apply gets the same §3.1 answer.
 *
 * Staff flags (item 8, _shared/pos-staff/flags.ts): unknown_actor, approval_missing,
 * register_actor_after_staff — on applied responses + stored; stale_ignored echoes the stored ones.
 * post_z (item 7): from the order's sales day (sticky, pos_orders.sales_day) vs that register's Zs.
 * After an applied order, closed shifts still drawer_unverified are re-verified (END-OF-DAY §7).
 * Not here: module_drift (device-side in the reference — sync.ts:128-142).
 */
import { authenticateDevice, type AuthDeps } from '../pos-device/auth.ts';
import { orderIdentity } from '../pos-device/identity.ts';
import { PRICING_MODULE_HASH } from '../pos-v1/moduleInfo.ts';
import { CanonicalJsonError, contentHash, ORDER_HASH_EXCLUDES } from './canonicalJson.ts';
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from './http.ts';
import { buildMenuSnapshot, SnapshotError, type MenuSnapshot, type SnapshotDb } from './menuSnapshot.ts';
import { CACHE_TTL_MS } from './menuSnapshotHandler.ts';
import { cardDataPaths, findRedemptionKey, jsonDepth, MAX_DEPTH, paymentsShapeProblem, scannedPart, UUID_RE, validateOrderPayload, type OrderPayload } from './orderPayload.ts';
import { availabilityViolation, diffBreakdowns, priceAgainstSnapshot, PricingError, ServerValidation, type DeliveryQuoteLookup } from './orderPricing.ts';
import { decideVersion, type ApplyOutcome, type OrderHead, type OrderStore, type SubmitOrderOk } from './orderStore.ts';
import { orderStaffFlags, type StaffContext } from '../pos-staff/flags.ts';
import { orderPostZ, reverifyShifts } from '../pos-eod/handlers.ts';
import { businessDate } from '../pos-eod/rules.ts';
import type { EodStore } from '../pos-eod/store.ts';

/**
 * The restaurant's CURRENT snapshot (for unknown_snapshot repricing and stale_price): built from the
 * menu tables like pos-v1-menu-snapshot, persisted before use (priced_against_hash must be stored),
 * cached per instance for CACHE_TTL_MS — the same staleness the menu-snapshot endpoint has.
 */
export class CurrentSnapshots {
  private readonly m = new Map<string, { snap: MenuSnapshot; at: number }>();
  constructor(
    private readonly db: SnapshotDb,
    private readonly persist: (s: MenuSnapshot) => Promise<void>,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}
  async get(restaurantId: string, nowMs: number): Promise<MenuSnapshot> {
    const e = this.m.get(restaurantId);
    if (e && nowMs - e.at < this.ttlMs) return e.snap;
    const snap = await buildMenuSnapshot(this.db, restaurantId, new Date(nowMs));
    if (e?.snap.hash !== snap.hash) await this.persist(snap);
    this.m.set(restaurantId, { snap, at: nowMs });
    return snap;
  }
}

export interface SubmitOrderDeps extends AuthDeps {
  orders: OrderStore;
  current: { get(restaurantId: string, nowMs: number): Promise<MenuSnapshot> };
  /** Item 8: staff ids / roles / first publication / settings history of the restaurant. */
  staff: { context(restaurantId: string): Promise<StaffContext> };
  /** Item 7: Zs for post_z; closed shifts to re-verify once payments arrive. */
  eod: EodStore;
  moduleHash?: string;
  /**
   * CP23: the stored delivery quotes (migration 115 — pos_delivery_quotes / pos_delivery_provider_quotes) the fee is
   * derived from (fee_source quoted / uber). Absent → those fees are delivery_quote_unknown at the offline fee.
   */
  deliveryQuotes?: {
    getQuote(restaurantId: string, id: string): Promise<{ distance_miles: string; in_radius: boolean; expires_at: string } | null>;
    getProviderQuote(restaurantId: string, id: string): Promise<{ customer_fee_cents: number; expires_at: string } | null>;
  };
}

const STAFF_FLAG_KEYS = ['unknown_actor', 'approval_missing', 'register_actor_after_staff'] as const;

const invalid = (message: string, field?: string) => errorResult(400, 'invalid_payload', message, field ? { field } : {});

function conflictResult(server_version: number | null, server_writer_device_id: string | null): DeviceResult {
  if (server_version === null) return errorResult(409, 'version_conflict', 'order unknown to the server but base_server_version > 0');
  return errorResult(409, 'version_conflict', 'order was changed by another device', { server_version, server_writer_device_id });
}

const reuseResult = (p: OrderPayload) => errorResult(409, 'idempotency_key_reuse', `(${p.order_id}, ${p.version}) was already applied with different content`);

/** stale_ignored: the newer stored version's pricing; flags as the reference's response() defaults. */
function staleResponse(head: OrderHead, requestVersion: number, nowIso: string, moduleHash: string, postZ: boolean): SubmitOrderOk {
  const diff = diffBreakdowns(head.provisional_pricing, head.pricing);
  return {
    result: 'stale_ignored',
    order_id: head.order_id,
    version: requestVersion,
    server_version: head.version,
    order_number: head.order_number,
    pricing: head.pricing,
    priced_against_hash: head.priced_against_hash,
    flags: {
      mismatch: Object.keys(diff).length > 0, stale_price: false, unknown_snapshot: false, availability_flag: false,
      // item 8: the stored version's staff flags
      ...Object.fromEntries(STAFF_FLAG_KEYS.map((k) => [k, head.flags[k] === true])),
      post_z: postZ,
    },
    diff,
    pricing_module_hash: moduleHash,
    server_time: nowIso,
  };
}

function outcomeResult(o: ApplyOutcome, p: OrderPayload, nowIso: string, moduleHash: string, stalePostZ: boolean): DeviceResult {
  switch (o.outcome) {
    case 'applied': return okResult(o.response);
    case 'duplicate': return okResult({ ...o.response, result: 'duplicate' });
    case 'idempotency_key_reuse': return reuseResult(p);
    case 'stale_ignored': return okResult(staleResponse(o.head, p.version, nowIso, moduleHash, stalePostZ));
    case 'version_conflict': return conflictResult(o.server_version, o.server_writer_device_id);
    case 'restaurant_mismatch': return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant', { field: 'order_id' });
    case 'prefix_mismatch': return errorResult(400, 'prefix_mismatch', `the order's ticket prefix is ${o.expected}`, { field: 'ticket.prefix' });
    case 'invalid_payload': return invalid(o.message, o.field ?? undefined);
  }
}

export async function handleSubmitOrder(req: DeviceRequest, deps: SubmitOrderDeps): Promise<DeviceResult> {
  const moduleHash = deps.moduleHash ?? PRICING_MODULE_HASH;
  // 1. middleware
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const pr = a.principal;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  // + nesting cap before any recursive walk
  if (jsonDepth(body) > MAX_DEPTH) return invalid(`nesting deeper than ${MAX_DEPTH}`);

  // 2. identity (§1a) — needs the stored order (restaurant + ticket prefix). A non-UUID order_id can't be
  //    stored, so it is a new order here; the structural check below then refuses it (reference order).
  const head = typeof body.order_id === 'string' && UUID_RE.test(body.order_id) ? await deps.orders.getHead(body.order_id) : null;
  const idBad = orderIdentity(body as Parameters<typeof orderIdentity>[0], pr, head ? { restaurant_id: head.restaurant_id, ticket_prefix: head.ticket_prefix } : null);
  if (idBad) return idBad;

  // 3. structure (a685442 handle :918-920, before the hash): UUID ids incl. order_id, types, void_reason …
  //    payments must be objects for this; their cash / card shape rules stay at step 7 (reference order)
  const shape = validateOrderPayload(body);
  if (shape) return invalid(shape.message, shape.field);

  // 4. content hash
  let recomputed: string;
  try {
    recomputed = await contentHash(body, ORDER_HASH_EXCLUDES);
  } catch (err) {
    if (err instanceof CanonicalJsonError) return invalid(`not canonical JSON: ${err.message}`);
    throw err;
  }
  if (recomputed !== body.content_hash) return invalid('content_hash does not match the canonical payload', 'content_hash');

  // 5. redemption keys (provisional_pricing's loyalty_* fields are pricing output, not a redemption)
  const red = findRedemptionKey(scannedPart(body));
  if (red) return errorResult(400, 'redemption_not_allowed', 'offline orders cannot carry a redemption', { field: red });

  // 6. card data — nothing is stored
  const card = cardDataPaths(body);
  if (card.length) return errorResult(400, 'card_data_rejected', `card-number-like text at ${card.join(', ')}`, { field: card[0] });

  // 7. payment shape
  const pay = paymentsShapeProblem(body);
  if (pay) return invalid(pay.message, pay.field);

  const p = body as unknown as OrderPayload;

  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();

  // 8. §3.1 pre-check (re-decided atomically in apply)
  const prior = await deps.orders.getSubmission(p.order_id, p.version);
  const d = decideVersion(p, pr.device_id, prior, head);
  if (d === 'duplicate') return okResult({ ...prior!.response, result: 'duplicate' });
  if (d === 'idempotency_key_reuse') return reuseResult(p);
  if (d === 'stale_ignored') return okResult(staleResponse(head!, p.version, nowIso, moduleHash, await orderPostZ(deps.eod, head!.writer_device_id, head!.sales_day, p.order_id)));
  if (d === 'version_conflict') return conflictResult(head?.version ?? null, head?.writer_device_id ?? null);

  // 9. price against the pinned snapshot
  const rid = pr.restaurant_id;
  const pinned = await deps.orders.getSnapshot(p.menu_snapshot_hash, rid);
  let current: MenuSnapshot | null = null;
  try {
    current = await deps.current.get(rid, nowMs);
  } catch (err) {
    if (!(err instanceof SnapshotError)) throw err;
    deps.log('current_snapshot_failed', { restaurant_id: rid, code: err.code, field: err.field });
    if (!pinned) return errorResult(500, 'snapshot_config_invalid', err.message, err.field ? { field: err.field } : {});
  }
  const unknown = !pinned;
  const snap = pinned ?? current;
  if (!snap) return invalid('no snapshot to price against', 'menu_snapshot_hash');
  // CP23: the stored quote the delivery fee comes from (server data — never the device's cents)
  const lookup: DeliveryQuoteLookup = {};
  const dl = p.order_type === 'delivery' ? p.delivery : null;
  if (dl && deps.deliveryQuotes) {
    if (dl.fee_source === 'quoted' && typeof dl.quote_id === 'string') lookup.quote = await deps.deliveryQuotes.getQuote(rid, dl.quote_id);
    const uq = (dl.uber as { quote_id?: unknown } | null)?.quote_id;
    if (dl.fee_source === 'uber' && typeof uq === 'string') lookup.provider = await deps.deliveryQuotes.getProviderQuote(rid, uq);
  }
  let priced: ReturnType<typeof priceAgainstSnapshot>;
  try {
    priced = priceAgainstSnapshot(p, snap, deps.deliveryQuotes ? lookup : undefined);
  } catch (err) {
    if (err instanceof PricingError) return errorResult(400, `pricing_error:${err.code}`, err.message);
    if (err instanceof ServerValidation) return errorResult(400, err.code, err.message, err.field ? { field: err.field } : {});
    throw err;
  }
  const stale = !unknown && current !== null && current.hash !== p.menu_snapshot_hash;
  const availability = availabilityViolation(p, snap);
  const diff = diffBreakdowns(p.provisional_pricing, priced.pricing);
  // item 8: never a rejection
  const staffFlags = orderStaffFlags(await deps.staff.context(rid), p, head ? { actorPaths: head.actor_paths, registerAfterStaff: head.flags.register_actor_after_staff === true } : null);
  // item 7: sales day = business day of the device_time of the version that first closed / voided it
  const dayOf = (current ?? snap).restaurant;
  const salesDay = head?.sales_day ?? (p.status === 'open' ? null : businessDate(Date.parse(p.device_time), dayOf.timezone, dayOf.business_day_cutoff));
  const postZ = await orderPostZ(deps.eod, pr.device_id, salesDay, p.order_id);
  const response: SubmitOrderOk = {
    result: 'applied',
    order_id: p.order_id,
    version: p.version,
    server_version: p.version,
    order_number: 0,
    pricing: priced.pricing,
    priced_against_hash: snap.hash,
    flags: {
      mismatch: Object.keys(diff).length > 0,
      stale_price: stale,
      unknown_snapshot: unknown,
      availability_flag: availability,
      ...(priced.delivery ? { delivery: priced.delivery } : {}),
      ...staffFlags,
      post_z: postZ,
    },
    diff,
    pricing_module_hash: moduleHash,
    server_time: nowIso,
  };

  // 10 + 11. payments insert-only + store, one transaction (pos_apply_order_submission)
  const outcome = await deps.orders.apply({ payload: p, writer: pr.device_id, restaurantId: rid, response, receivedAt: nowIso, salesDay });
  if (outcome.outcome === 'applied') {
    await reverifyShifts(deps.eod, rid, deps.log);
    deps.log('order_applied', { restaurant_id: rid, device_id: pr.device_id, order_id: p.order_id, version: p.version, mismatch: response.flags.mismatch, stale_price: stale, unknown_snapshot: unknown, availability_flag: availability });
  }
  const stalePostZ = outcome.outcome === 'stale_ignored' ? await orderPostZ(deps.eod, outcome.head.writer_device_id, outcome.head.sales_day ?? null, p.order_id) : false;
  return outcomeResult(outcome, p, nowIso, moduleHash, stalePostZ);
}

/** For the function's index.ts: the Supabase store. */
export { PgOrderStore } from './orderStore.ts';
