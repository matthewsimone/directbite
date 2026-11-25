/**
 * VERBATIM port of the reference Ordr action rule — ordr-pos @ 86c558d src/dev/onlineActionRules.ts :67-258
 * (ServerCtx … applyOnlineActionRule … adminRefundFull) + src/sync/onlineContract.ts :540-546 (scheduledWakeAtMs).
 * Test oracle only (tests/actions.test.ts differential): never imported by a function.
 * Shims for the reference's imports (only reached by actions outside CP18 — adjustment_request / dispatch_delivery):
 * findCardNumbers (core/cardData.ts), cents / subtractCents (core/money.ts); constants from onlineContract.ts :512-519.
 */
import type { OnlineOrderWire } from '../wire.ts';

const ADJUSTMENT_NOTE_MAX = 200;
const EXT_PREP_MINUTES = { min: 1, max: 240 } as const;
const QUOTED_READY_MINUTES = { min: 1, max: 240 } as const;
const findCardNumbers = (s: string): string[] => s.match(/\d{13,19}/g) ?? [];
const cents = (n: number) => n;
const subtractCents = (a: number, b: number) => a - b;
type OnlineActionRequest = {
  action: string; expected_status: string | null; quoted_ready_minutes: number | null; prep_minutes: number | null;
  amount_cents: number | null; adjustment_type: 'charge' | 'refund' | null; accepted_quote_id: string | null; reason: string | null;
  approver_staff_id: string | null; actor_staff_id: string;
};

/** onlineContract.ts :540-546, verbatim. */
export function scheduledWakeAtMs(w: OnlineOrderWire, estimatedPickupMinutes: number | null | undefined): number | null {
  const d = w.delivery;
  if (w.channel !== 'ordr' || w.status !== 'scheduled' || !d || d.provider === 'in_house' || d.dispatched_at === null || !w.scheduled_for) return null;
  const target = Date.parse(d.pickup_ready_at ?? w.scheduled_for);
  if (!Number.isFinite(target)) return null;
  return target - (Number(estimatedPickupMinutes) || 30) * 60_000;
}

// ---- onlineActionRules.ts :67-258, verbatim (export keywords kept) ----------------------------------------
/** Server-side facts the rules need (the FakeServer / dev stub supply them). */
export interface ServerCtx {
  /** What Stripe does with this order's next refund (default ok). */
  refundOutcome?: 'ok' | 'failed';
  newAdjustmentId: () => string;
  /** restaurants.estimated_pickup_minutes (the wake-up lead; the tablet falls back to 30). */
  estimatedPickupMinutes?: number | null;
  /** What Uber does (defaults: dispatch ok, no re-quote, cancel ok unless the driver has the food). */
  delivery?: {
    dispatch?: 'ok' | 'no_courier_available' | 'bad_address' | 'provider_error';
    /** Uber re-quoted: dispatch answers 409 quote_price_changed unless accepted_quote_id = new_quote_id. */
    requote?: { original_fee_cents: number; new_fee_cents: number; new_quote_id: string } | null;
    trackingUrl?: string;
  };
}

export const PREP_MINUTES = { min: 5, max: 120 } as const;
/** Uber refuses to cancel once the courier has the food. */
const DRIVER_HAS_FOOD = new Set(['pickup_complete', 'dropoff']);

export type RuleResult =
  | { kind: 'applied'; readyEmail: boolean }
  | { kind: 'noop' }
  /** `changed`: the attempt was written on the order (refund_status failed) — bump + return the order.
   *  `extra`: more keys inside `error` (quote_price_changed → quote; delivery_failed → reason). */
  | { kind: 'error'; status: number; code: string; message: string; withOrder?: boolean; changed?: boolean; extra?: Record<string, unknown> };

const err = (status: number, code: string, message: string, withOrder = false, changed = false, extra?: Record<string, unknown>): RuleResult => ({ kind: 'error', status, code, message, withOrder, changed, extra });
const intIn = (v: unknown, r: { min: number; max: number }) => typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;

type RuleReq = Pick<OnlineActionRequest, 'action' | 'expected_status' | 'quoted_ready_minutes' | 'prep_minutes'> &
  Partial<Pick<OnlineActionRequest, 'amount_cents' | 'adjustment_type' | 'reason' | 'actor_staff_id' | 'approver_staff_id' | 'accepted_quote_id'>>;

const isUber = (w: OnlineOrderWire) => !!w.delivery && w.delivery.provider !== 'in_house';
const dispatched = (w: OnlineOrderWire) => !!w.delivery && w.delivery.dispatched_at !== null;

/**
 * _shared/uberCancel.ts: never dispatched / already canceled → nothing to do; the driver has the food →
 * Uber refuses; else uber_status canceled. Returns false when Uber refused.
 */
function cancelUber(w: OnlineOrderWire): boolean {
  const d = w.delivery;
  if (!d || !dispatched(w) || d.status === 'cancelled') return true;
  if (DRIVER_HAS_FOOD.has(d.status) || d.status === 'delivered') return false;
  d.status = 'cancelled';
  d.provider_status = 'canceled';
  return true;
}

/** Apply `req` to `w` (mutated in place on success). `nowMs` = server time. */
export function applyOnlineActionRule(w: OnlineOrderWire, req: RuleReq, nowMs: number, ctx: ServerCtx = { newAdjustmentId: () => `adj-${nowMs}` }): RuleResult {
  const now = new Date(nowMs).toISOString();
  const kh = w.channel === 'kitchenhub';
  if (kh !== req.action.startsWith('ext_')) return err(400, 'action_not_allowed', `${req.action} on a ${w.channel} order`);
  if (req.action === 'complete_all_in_progress') return err(400, 'invalid_payload', 'complete_all_in_progress takes no order_id');
  if (req.action === 'ack' || req.action === 'ext_ack') {
    if (w.acknowledged_at !== null) return { kind: 'noop' };
    w.acknowledged_at = now;
    return { kind: 'applied', readyEmail: false };
  }
  if (req.action === 'stuck_ack') {
    w.stuck_acknowledged_at = now;
    return { kind: 'applied', readyEmail: false };
  }
  // ---- everything else: compare-and-set ----
  if (typeof req.expected_status !== 'string') return err(400, 'invalid_payload', 'expected_status is required');
  if (w.status !== req.expected_status) return err(409, 'status_conflict', `the order is ${w.status}`, true);
  const notAllowed = (why: string) => err(400, 'action_not_allowed', why);
  switch (req.action) {
    case 'accept': {
      if (w.status !== 'new') return notAllowed(`accept from ${w.status}`);
      if (w.scheduled_for) return notAllowed('a scheduled order is accepted with schedule');
      if (isUber(w)) return notAllowed('an Uber delivery is accepted by dispatching it');
      if (req.quoted_ready_minutes !== null && !intIn(req.quoted_ready_minutes, QUOTED_READY_MINUTES)) return err(400, 'invalid_payload', 'quoted_ready_minutes must be 1–240 or null');
      w.status = 'in_progress';
      w.accepted_at ??= now;
      if (req.quoted_ready_minutes !== null) w.quoted_for = new Date(nowMs + req.quoted_ready_minutes * 60_000).toISOString();
      return { kind: 'applied', readyEmail: req.quoted_ready_minutes !== null };
    }
    case 'schedule': {
      if (w.status !== 'new') return notAllowed(`schedule from ${w.status}`);
      if (!w.scheduled_for) return notAllowed('not a scheduled order');
      if (isUber(w) && !dispatched(w)) return notAllowed('an Uber delivery is scheduled by booking it');
      w.status = 'scheduled';
      w.accepted_at ??= now;
      return { kind: 'applied', readyEmail: false };
    }
    case 'complete': {
      if (w.status !== 'in_progress' && w.status !== 'scheduled' && w.status !== 'self_delivering') return notAllowed(`complete from ${w.status}`);
      w.status = 'complete';
      return { kind: 'applied', readyEmail: false };
    }
    case 'cancel_refund':
      return adminRefundFull(w, now, ctx);
    case 'adjustment_request': {
      if (w.status !== 'complete') return notAllowed('an adjustment is requested on a complete order');
      if (req.adjustment_type !== 'charge' && req.adjustment_type !== 'refund') return err(400, 'invalid_payload', 'adjustment_type must be charge or refund');
      if (!intIn(req.amount_cents, { min: 1, max: Number.MAX_SAFE_INTEGER })) return err(400, 'amount_invalid', 'amount_cents must be > 0');
      const note = typeof req.reason === 'string' ? req.reason.trim() : '';
      if (!note || note.length > ADJUSTMENT_NOTE_MAX) return err(400, 'invalid_payload', `a note (1–${ADJUSTMENT_NOTE_MAX} characters) is required`);
      if (findCardNumbers(note).length) return err(400, 'card_data_rejected', 'card-number-like text in the note');
      w.adjustments.push({ id: ctx.newAdjustmentId(), type: req.adjustment_type, amount_cents: req.amount_cents as number, note, status: 'pending', created_at: now, approved_at: null });
      return { kind: 'applied', readyEmail: false };
    }
    case 'ext_accept': {
      if (w.status !== 'new') return notAllowed(`accept from ${w.status}`);
      if (!intIn(req.prep_minutes, EXT_PREP_MINUTES)) return err(400, 'invalid_payload', 'prep_minutes must be 1–240');
      w.status = 'in_progress';
      w.channel_status = 'accepted';
      w.accepted_at ??= now;
      if (w.external) w.external.prep_time_minutes = req.prep_minutes;
      return { kind: 'applied', readyEmail: false };
    }
    case 'ext_ready': {
      if (w.status !== 'in_progress') return notAllowed(`ready from ${w.status}`);
      w.status = 'complete';
      w.channel_status = 'completed';
      if (w.external) w.external.completed_at = now;
      return { kind: 'applied', readyEmail: false };
    }
    case 'ext_cancel': {
      if (w.status !== 'new') return notAllowed('a marketplace order can only be cancelled while it is new');
      w.status = 'cancelled';
      w.channel_status = 'cancelled';
      w.cancelled_by = 'restaurant';
      if (w.external) w.external.cancelled_at = now;
      return { kind: 'applied', readyEmail: false };
    }
    case 'dispatch_delivery': {
      const d = w.delivery;
      if (!d || !isUber(w)) return notAllowed('not an Uber delivery');
      if (w.status !== 'new' || dispatched(w)) return notAllowed('already dispatched / not new');
      const scheduled = !!w.scheduled_for;
      if (!scheduled && !intIn(req.prep_minutes, PREP_MINUTES)) return err(400, 'invalid_payload', 'prep_minutes must be 5–120');
      const dc = ctx.delivery ?? {};
      if (dc.requote && req.accepted_quote_id !== dc.requote.new_quote_id) {
        return err(409, 'quote_price_changed', 'the delivery price changed', false, false, {
          quote: { original_fee_cents: dc.requote.original_fee_cents, new_fee_cents: dc.requote.new_fee_cents, delta_cents: Number(subtractCents(cents(dc.requote.new_fee_cents), cents(dc.requote.original_fee_cents))), new_quote_id: dc.requote.new_quote_id },
        });
      }
      if (dc.dispatch && dc.dispatch !== 'ok') return err(502, 'delivery_failed', 'Uber refused', false, false, { reason: dc.dispatch });
      w.accepted_at ??= now;
      d.dispatched_at = now; // uber_dispatched_at
      d.tracking_url = dc.trackingUrl ?? `https://delivery.example/track/${w.id}`; // uber_tracking_url
      d.provider_status = 'pending'; // uber_status (Uber's answer)
      // the normalized status is a READ of uber_status + the order status (scheduled + pending = scheduled)
      d.status = scheduled ? 'scheduled' : 'pending';
      d.cancelled_by = null;
      w.status = scheduled ? 'scheduled' : 'in_progress';
      d.pickup_ready_at = scheduled ? w.scheduled_for : new Date(nowMs + (req.prep_minutes as number) * 60_000).toISOString(); // uber_pickup_ready_dt
      return { kind: 'applied', readyEmail: false };
    }
    case 'self_deliver': {
      if (!isUber(w)) return notAllowed('not an Uber delivery');
      if (w.status === 'complete' || w.status === 'cancelled' || w.status === 'self_delivering') return notAllowed(`self-deliver from ${w.status}`);
      if (!cancelUber(w)) return err(502, 'delivery_failed', 'the driver already has the food', false, false, { reason: 'cannot_cancel' });
      w.status = 'self_delivering';
      w.cancelled_by = 'restaurant_self_deliver';
      w.delivery!.cancelled_by = 'restaurant_self_deliver';
      return { kind: 'applied', readyEmail: false };
    }
    case 'wake_scheduled': {
      const at = scheduledWakeAtMs(w, ctx.estimatedPickupMinutes);
      if (at === null) return notAllowed('not a booked scheduled Uber order');
      if (nowMs < at) return notAllowed('not due yet');
      w.status = 'in_progress';
      // the normalized delivery status reads the order status (scheduled + pending → pending): no write
      if (w.delivery && w.delivery.status === 'scheduled') w.delivery.status = 'pending';
      return { kind: 'applied', readyEmail: false };
    }
    default:
      return err(400, 'invalid_payload', `unknown action ${String(req.action)}`);
  }
}

/** admin-refund {type: 'full'} — unchanged logic (the server imports it; the glue is hash-pinned). */
function adminRefundFull(w: OnlineOrderWire, now: string, ctx: ServerCtx): RuleResult {
  if (!['new', 'scheduled', 'in_progress', 'self_delivering'].includes(w.status)) return err(400, 'action_not_allowed', `cancel from ${w.status}`);
  if (w.delivery?.status === 'delivered') return err(400, 'already_delivered', 'the order was already delivered — no refund');
  if (isUber(w) && !cancelUber(w)) return err(502, 'delivery_failed', 'Uber could not cancel the delivery — NOT refunded', false, false, { reason: 'cannot_cancel' });
  if ((ctx.refundOutcome ?? 'ok') === 'failed') {
    w.refund.status = 'failed';
    w.refund.reason = 'the card refund did not go through';
    return err(502, 'refund_failed', 'the card refund did not go through', true, true);
  }
  w.refund.status = 'completed';
  w.refund.amount_cents = w.money.total_cents;
  w.refund.refunded_at = now;
  w.status = 'cancelled';
  w.cancelled_by = 'restaurant_refund';
  return { kind: 'applied', readyEmail: false };
}
