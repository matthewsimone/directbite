/**
 * pos-v1-online-order-action — the Ordr rules of CP18, on an `orders` ROW (ordr-pos @ 86c558d
 * src/dev/onlineActionRules.ts :117-158, :228-236 — which works on the wire; this works on the columns the web tablet
 * writes). 111's pos_online_order_action is the same rule in SQL; MemoryOnlineStore runs this one, and
 * tests/actions.test.ts checks it against the ported reference rule (differential).
 *
 * The write of each action is EXACTLY the web tablet's:
 *   ack              acknowledged_at = now, only while null (else noop)        OrdersTab.jsx :1728-1734
 *   stuck_ack        stuck_acknowledged_at = now                                OrdersTab.jsx :1741-1747
 *   accept           status in_progress + accepted_at; quoted_for = now + N     OrdersTab.jsx :563-573, :702-707
 *   schedule         status scheduled + accepted_at                             OrdersTab.jsx :563-573
 *   complete         status complete                                            OrdersTab.jsx :566-573
 *   wake_scheduled   status in_progress (accepted_at untouched)                 useOrderPolling.js :526-544
 * accepted_at = existing ?? now (the contract's "if null"; leaving `new` it is always null).
 * complete_all_in_progress is a set operation (SettingsTab.jsx :490-494) — the store runs it, not this rule.
 */

/** Every action name the contract knows (onlineContract.ts ORDR_ACTIONS + KITCHENHUB_ACTIONS). */
export const ONLINE_ACTIONS = [
  'ack', 'stuck_ack', 'accept', 'schedule', 'complete', 'complete_all_in_progress', 'cancel_refund', 'adjustment_request',
  'dispatch_delivery', 'self_deliver', 'wake_scheduled', 'ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel',
] as const;
export type OnlineActionName = (typeof ONLINE_ACTIONS)[number];

/** Built in CP18. The rest answer 501 not_implemented (money CP19, Uber CP20, KitchenHub CP21). */
export const CP18_ACTIONS = ['ack', 'stuck_ack', 'accept', 'schedule', 'complete', 'complete_all_in_progress', 'wake_scheduled'] as const;
export type Cp18Action = (typeof CP18_ACTIONS)[number];

/** No compare-and-set (contract §3c:611-612). */
export const ACK_ACTIONS: readonly string[] = ['ack', 'stuck_ack', 'ext_ack'];

/** accept's quoted ready time (onlineContract.ts QUOTED_READY_MINUTES). */
export const QUOTED_READY_MINUTES = { min: 1, max: 240 } as const;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type OrderRuleResult =
  /** `set` = the columns written, exactly; readyEmail = the tablet would call send-ready-email after this write. */
  | { kind: 'applied'; set: Record<string, unknown>; readyEmail: boolean }
  | { kind: 'noop' }
  | { kind: 'status_conflict'; status: string }
  | { kind: 'not_allowed'; message: string }
  | { kind: 'invalid'; message: string };

export interface OrderRuleInput {
  action: Exclude<Cp18Action, 'complete_all_in_progress'>;
  expected_status: string | null;
  /** Integer or null (the handler maps a non-integer to 0 → `invalid` at the reference's point). */
  quoted_ready_minutes: number | null;
}

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const isUberDelivery = (r: Row) => r.order_type === 'delivery' && r.delivery_fulfillment_method === 'uber_direct';

/** The tablet's wake-up lead: `(Number(restaurant.estimated_pickup_minutes) || 30)` minutes (useOrderPolling.js :526). */
export function wakeLeadMinutes(estimatedPickupMinutes: unknown): number {
  return Number(estimatedPickupMinutes) || 30;
}

/**
 * When the tablet's wake-up fires for this row (ms), or null when it never does — useOrderPolling.js :528-533:
 * status scheduled, delivery_fulfillment_method uber_direct, uber_delivery_id set, scheduled_for set; at
 * (uber_pickup_ready_dt ?? scheduled_for) − lead.
 */
export function wakeAtMs(r: Row, estimatedPickupMinutes: unknown): number | null {
  if (r.status !== 'scheduled' || r.delivery_fulfillment_method !== 'uber_direct' || r.uber_delivery_id == null || r.scheduled_for == null) return null;
  const target = ms(r.uber_pickup_ready_dt ?? r.scheduled_for);
  if (target === null) return null;
  return target - wakeLeadMinutes(estimatedPickupMinutes) * 60_000;
}

export function ordrActionRule(r: Row, req: OrderRuleInput, nowMs: number, estimatedPickupMinutes: unknown): OrderRuleResult {
  const now = new Date(nowMs).toISOString();
  if (req.action === 'ack') {
    if (r.acknowledged_at != null) return { kind: 'noop' };
    return { kind: 'applied', set: { acknowledged_at: now }, readyEmail: false };
  }
  if (req.action === 'stuck_ack') return { kind: 'applied', set: { stuck_acknowledged_at: now }, readyEmail: false };
  if (r.status !== req.expected_status) return { kind: 'status_conflict', status: String(r.status) };
  const accepted = r.accepted_at ?? now;
  switch (req.action) {
    case 'accept': {
      if (r.status !== 'new') return { kind: 'not_allowed', message: `accept from ${r.status}` };
      if (r.scheduled_for != null) return { kind: 'not_allowed', message: 'a scheduled order is accepted with schedule' };
      if (isUberDelivery(r)) return { kind: 'not_allowed', message: 'an Uber delivery is accepted by dispatching it' };
      const q = req.quoted_ready_minutes;
      if (q !== null && !(Number.isInteger(q) && q >= QUOTED_READY_MINUTES.min && q <= QUOTED_READY_MINUTES.max)) {
        return { kind: 'invalid', message: 'quoted_ready_minutes must be 1–240 or null' };
      }
      if (q === null) return { kind: 'applied', set: { status: 'in_progress', accepted_at: accepted }, readyEmail: false };
      return { kind: 'applied', set: { status: 'in_progress', accepted_at: accepted, quoted_for: new Date(nowMs + q * 60_000).toISOString() }, readyEmail: true };
    }
    case 'schedule': {
      if (r.status !== 'new') return { kind: 'not_allowed', message: `schedule from ${r.status}` };
      if (r.scheduled_for == null) return { kind: 'not_allowed', message: 'not a scheduled order' };
      if (isUberDelivery(r) && r.uber_delivery_id == null) return { kind: 'not_allowed', message: 'an Uber delivery is scheduled by booking it' };
      return { kind: 'applied', set: { status: 'scheduled', accepted_at: accepted }, readyEmail: false };
    }
    case 'complete': {
      if (r.status !== 'in_progress' && r.status !== 'scheduled' && r.status !== 'self_delivering') return { kind: 'not_allowed', message: `complete from ${r.status}` };
      return { kind: 'applied', set: { status: 'complete' }, readyEmail: false };
    }
    case 'wake_scheduled': {
      const at = wakeAtMs(r, estimatedPickupMinutes);
      if (at === null) return { kind: 'not_allowed', message: 'not a booked scheduled Uber order' };
      if (nowMs < at) return { kind: 'not_allowed', message: 'not due yet' };
      return { kind: 'applied', set: { status: 'in_progress' }, readyEmail: false };
    }
  }
}
