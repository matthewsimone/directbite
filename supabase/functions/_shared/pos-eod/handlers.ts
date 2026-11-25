/**
 * pos-v1-submit-shift / pos-v1-submit-refund / pos-v1-submit-day-close (SYNC-CONTRACT §3a, §1a;
 * END-OF-DAY §7; DIRECTBITE-HANDOFF item 7 FINAL CP3). Reference: ordr-pos test/support/fakeServer.ts
 *   invoke :218-228 (identity: entityIdentity with the stored entity), entity() :579-608 (hash → card
 *   guard → idempotency (type, id, version) → apply), entityOk :610-612, applyShift :619-649,
 *   verifyDrawer :651-676, reverifyDrawers :678-683, applyRefund :685-704, applyDayClose :706-721.
 *
 * Server-only additions (marked +): JSON object / nesting / id-is-a-UUID before the lookup; structural
 * validation after the card guard (400 invalid_payload). Flags never reject money (§3a).
 */
import { authenticateDevice, type AuthDeps } from '../pos-device/auth.ts';
import { entityIdentity } from '../pos-device/identity.ts';
import { CanonicalJsonError, contentHash, ORDER_HASH_EXCLUDES } from '../pos-sync/canonicalJson.ts';
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import { jsonDepth, MAX_DEPTH, UUID_RE } from '../pos-sync/orderPayload.ts';
import { findCardNumbers } from '../ordr-core-ext/cardData.ts';
import { dayCloseStaffFlags, refundStaffFlags, shiftStaffFlags, type StaffContext } from '../pos-staff/flags.ts';
import { dayCloseProblem, ID_KEY, refundProblem, shiftProblem, type DayClosePayload, type EntityType, type RefundPayload, type ShiftPayload } from './payloads.ts';
import { attributionIds, isPostZ, isPostZOrder, verifyDrawer, type DrawerShift } from './rules.ts';
import type { EntityResponse, EodOutcome, EodStore } from './store.ts';
import type { Principal } from '../pos-device/auth.ts';

export interface EodDeps extends AuthDeps {
  eod: EodStore;
  staff: { context(restaurantId: string): Promise<StaffContext> };
}

const entityResponse = (id: string, version: number, serverVersion: number, flags: Record<string, boolean>, nowMs: number, result: EntityResponse['result'] = 'applied'): EntityResponse =>
  ({ result, id, version, server_version: serverVersion, flags, server_time: new Date(nowMs).toISOString() });

const invalid = (message: string, field?: string | null) => errorResult(400, 'invalid_payload', message, field ? { field } : {});

function outcomeResult(o: EodOutcome, type: EntityType, id: string, version: number, nowMs: number): DeviceResult {
  switch (o.outcome) {
    case 'applied': return okResult(o.response);
    case 'duplicate': return okResult({ ...o.response, result: 'duplicate' });
    case 'idempotency_key_reuse': return errorResult(409, 'idempotency_key_reuse', `${type}:${id}:${version} was already applied with different content`);
    case 'stale_ignored': return okResult(entityResponse(id, version, o.server_version, o.flags, nowMs, 'stale_ignored'));
    case 'shift_closed': return errorResult(409, 'shift_closed', 'a closed shift is immutable');
    case 'unknown_payment': return errorResult(409, 'unknown_payment', 'payment not known on that order yet');
    case 'day_close_sequence_taken': return errorResult(409, 'day_close_sequence_taken', 'that Z sequence exists for this register and business day');
    case 'restaurant_mismatch': return errorResult(400, 'restaurant_mismatch', 'it belongs to another restaurant');
    case 'invalid_payload': return invalid(o.message, o.field);
  }
}

/** The §3a envelope (fakeServer entity() :579-608, after invoke's identity :218-228). */
async function entity<P extends { content_hash: string }>(
  type: EntityType,
  req: DeviceRequest,
  deps: EodDeps,
  o: {
    existingRestaurant: (id: string) => Promise<string | null>;
    version: (p: Record<string, unknown>) => number;
    problem: (p: Record<string, unknown>) => { field: string; message: string } | null;
    apply: (p: P, pr: Principal, nowMs: number) => Promise<DeviceResult>;
  },
): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const p = parsed.value;
  const idKey = ID_KEY[type];
  // +
  if (jsonDepth(p) > MAX_DEPTH) return invalid(`nesting deeper than ${MAX_DEPTH}`);
  if (typeof p[idKey] !== 'string' || !UUID_RE.test(p[idKey] as string)) return invalid(`${idKey} must be a UUID`, idKey);
  const id = p[idKey] as string;
  // identity (§1a): restaurant / device / an existing entity of another restaurant
  const idBad = entityIdentity(p, a.principal, await o.existingRestaurant(id));
  if (idBad) return idBad;
  // content hash
  let recomputed: string;
  try {
    recomputed = await contentHash(p, ORDER_HASH_EXCLUDES);
  } catch (err) {
    if (err instanceof CanonicalJsonError) return invalid(`not canonical JSON: ${err.message}`);
    throw err;
  }
  if (recomputed !== p.content_hash) return invalid('content_hash does not match', 'content_hash');
  // card data (UUID-format *_ids values skipped; any other free text scanned) — nothing stored
  const card = findCardNumbers(p);
  if (card.length) return errorResult(400, 'card_data_rejected', `card-number-like text at ${card.join(', ')}`, { field: card[0] });
  // +
  const shape = o.problem(p);
  if (shape) return invalid(shape.message, shape.field);
  // idempotency (type, id, version)
  const version = o.version(p);
  const prior = await deps.eod.submission(type, id, version);
  if (prior) {
    if (prior.content_hash === p.content_hash) return okResult({ ...prior.response, result: 'duplicate' });
    return errorResult(409, 'idempotency_key_reuse', `${type}:${id}:${version} was already applied with different content`);
  }
  return await o.apply(p as unknown as P, a.principal, deps.now());
}

// ---- drawer re-verification -------------------------------------------------------------------------

async function drawerFlags(eod: EodStore, restaurantId: string, s: DrawerShift) {
  const ids = attributionIds(s.attribution!);
  const [payments, refunds] = await Promise.all([eod.payments(restaurantId, ids.paymentIds), eod.refunds(restaurantId, ids.refundIds)]);
  return verifyDrawer(s, { payments, refunds });
}

/**
 * END-OF-DAY §7: a closed shift flagged drawer_unverified is re-checked when its missing payments /
 * refunds arrive (called after an applied order / refund). Flags only; failures are logged, never
 * returned (the order / refund is already stored and answered).
 */
export async function reverifyShifts(eod: EodStore, restaurantId: string, log: AuthDeps['log']): Promise<void> {
  try {
    for (const s of await eod.unverifiedShifts(restaurantId)) {
      const f = await drawerFlags(eod, restaurantId, s.payload);
      if (f.drawer_unverified !== s.flags.drawer_unverified || f.drawer_mismatch !== s.flags.drawer_mismatch) await eod.setDrawerFlags(s.shift_id, f);
    }
  } catch (err) {
    log('reverify_failed', { restaurant_id: restaurantId, error: err instanceof Error ? err.message : 'unknown' });
  }
}

/** post_z for a submit-order response: the order's sales day vs that register's Zs of the day. */
export async function orderPostZ(eod: EodStore, deviceId: string, salesDay: string | null, orderId: string): Promise<boolean> {
  if (!salesDay) return false;
  return isPostZOrder(salesDay, await eod.zs(deviceId, salesDay), orderId);
}

// ---- pos-v1-submit-shift ----------------------------------------------------------------------------

export function handleShift(req: DeviceRequest, deps: EodDeps): Promise<DeviceResult> {
  return entity<ShiftPayload>('shift', req, deps, {
    existingRestaurant: async (id) => (await deps.eod.shift(id))?.restaurant_id ?? null,
    version: (p) => p.version as number,
    problem: shiftProblem,
    apply: async (p, pr, nowMs) => {
      const rid = pr.restaurant_id;
      const cur = await deps.eod.shift(p.shift_id);
      // versions apply in order; a closed shift is immutable
      if (cur && p.version <= cur.version) return okResult(entityResponse(p.shift_id, p.version, cur.version, cur.flags, nowMs, 'stale_ignored'));
      if (cur && cur.status === 'closed') return errorResult(409, 'shift_closed', 'a closed shift is immutable');
      // movements insert-only by id
      const prev = await deps.eod.movements(p.movements.map((m) => m.id));
      for (const m of p.movements) {
        const x = prev.get(m.id);
        if (x && (x.shift_id !== p.shift_id || x.amount_cents !== m.amount_cents || x.kind !== m.kind)) return invalid(`movement ${m.id} changed`, 'movements');
      }
      const flags: Record<string, boolean> = {};
      if (p.status === 'closed') {
        if (!p.attribution || p.counted_cash_cents === null || p.expected_cash_cents === null) return invalid('closed shift without count / attribution');
        Object.assign(flags, await drawerFlags(deps.eod, rid, p));
      }
      flags.post_z = isPostZ(await deps.eod.zs(pr.device_id, p.business_date), 'shift_ids', p.shift_id) && p.status === 'closed';
      Object.assign(flags, shiftStaffFlags(await deps.staff.context(rid), p));
      const response = entityResponse(p.shift_id, p.version, p.version, flags, nowMs);
      const out = await deps.eod.applyShift({ payload: p, deviceId: pr.device_id, restaurantId: rid, response, receivedAt: response.server_time });
      return outcomeResult(out, 'shift', p.shift_id, p.version, nowMs);
    },
  });
}

// ---- pos-v1-submit-refund ---------------------------------------------------------------------------

export function handleRefund(req: DeviceRequest, deps: EodDeps): Promise<DeviceResult> {
  return entity<RefundPayload>('refund', req, deps, {
    existingRestaurant: (id) => deps.eod.refundRestaurant(id),
    version: () => 1,
    problem: refundProblem,
    apply: async (p, pr, nowMs) => {
      const rid = pr.restaurant_id;
      if ((await deps.eod.refundRestaurant(p.refund_id)) !== null) return errorResult(409, 'idempotency_key_reuse', 'refund already stored with other content');
      const pay = (await deps.eod.payments(rid, [p.payment_id])).get(p.payment_id);
      if (!pay || pay.order_id !== p.order_id) return errorResult(409, 'unknown_payment', `payment ${p.payment_id} on order ${p.order_id} not known yet`);
      if (pay.method !== p.method) return invalid('refund method must equal the payment method', 'method');
      if (!(Number.isSafeInteger(p.amount_cents) && p.amount_cents > 0)) return invalid('amount must be > 0', 'amount_cents');
      const prior = await deps.eod.refundAmountsOfPayment(p.payment_id);
      const flags: Record<string, boolean> = {
        refund_exceeds_payment: [...prior, p.amount_cents].reduce((x, y) => x + y, 0) > pay.amount_cents,
        post_z: isPostZ(await deps.eod.zs(pr.device_id, p.business_date), 'refund_ids', p.refund_id),
        ...refundStaffFlags(await deps.staff.context(rid), p),
      };
      const response = entityResponse(p.refund_id, 1, 1, flags, nowMs);
      const out = await deps.eod.applyRefund({ payload: p, deviceId: pr.device_id, restaurantId: rid, response, receivedAt: response.server_time });
      if (out.outcome === 'applied') await reverifyShifts(deps.eod, rid, deps.log);
      return outcomeResult(out, 'refund', p.refund_id, 1, nowMs);
    },
  });
}

// ---- pos-v1-submit-day-close ------------------------------------------------------------------------

export function handleDayClose(req: DeviceRequest, deps: EodDeps): Promise<DeviceResult> {
  return entity<DayClosePayload>('day_close', req, deps, {
    existingRestaurant: (id) => deps.eod.dayCloseRestaurant(id),
    version: () => 1,
    problem: dayCloseProblem,
    apply: async (p, pr, nowMs) => {
      const rid = pr.restaurant_id;
      if ((await deps.eod.dayCloseRestaurant(p.day_close_id)) !== null) return errorResult(409, 'idempotency_key_reuse', 'day close already stored with other content');
      if ((await deps.eod.zs(pr.device_id, p.business_date)).some((z) => z.sequence === p.sequence)) {
        return errorResult(409, 'day_close_sequence_taken', `Z #${p.sequence} for ${p.business_date} exists`);
      }
      if (p.supplemental !== p.sequence > 1) return invalid('supplemental must equal sequence > 1', 'supplemental');
      // z_mismatch: not computed yet (handoff item 7: "later — once the server recomputes Zs")
      const flags: Record<string, boolean> = { z_mismatch: false, ...dayCloseStaffFlags(await deps.staff.context(rid), p) };
      const response = entityResponse(p.day_close_id, 1, 1, flags, nowMs);
      const out = await deps.eod.applyDayClose({ payload: p, deviceId: pr.device_id, restaurantId: rid, response, receivedAt: response.server_time });
      return outcomeResult(out, 'day_close', p.day_close_id, 1, nowMs);
    },
  });
}
