/**
 * TEST ORACLE — verbatim port of the POS's own parser: ordr-pos @ 7798d52 src/sync/onlineContract.ts :35-41
 * (status / delivery sets), :363-460 (ParsedOnlineOrder, problemOf, parseOnlineOrder), :466-480 (settingsProblem).
 * A row this returns `unreadable` / `unkeyable` for is one the register would show as "couldn't be read" or refuse
 * the whole poll over — the server must never serve one. Only the imports / exports were adapted; types loosened
 * to unknown (the original casts to its own wire types).
 */
// deno-lint-ignore-file
export const ONLINE_STATUSES = ['new', 'scheduled', 'in_progress', 'self_delivering', 'complete', 'cancelled'] as const;
type OnlineStatus = (typeof ONLINE_STATUSES)[number];
export const DELIVERY_STATUSES = ['not_dispatched', 'scheduled', 'pending', 'pickup', 'pickup_complete', 'dropoff', 'delivered', 'cancelled', 'returned', 'failed'] as const;
type OnlineDeliveryStatus = (typeof DELIVERY_STATUSES)[number];
type OnlineOrderWire = Record<string, unknown>;

export type ParsedOnlineOrder =
  | { kind: 'ok'; order: OnlineOrderWire }
  /** Keyable but malformed: cached with readable = false and shown (never dropped). */
  | { kind: 'unreadable'; id: string; order_number: number; status: string | null; problem: string }
  /** Not even keyable: a server bug — refuse the page. */
  | { kind: 'unkeyable'; problem: string };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function problemOf(o: Record<string, unknown>): string | null {
  if (o.channel !== 'ordr' && o.channel !== 'kitchenhub') return `channel ${String(o.channel)}`;
  if (!isStr(o.channel_status)) return 'channel_status';
  if (!ONLINE_STATUSES.includes(o.status as OnlineStatus)) return `status ${String(o.status)}`;
  if (o.order_type !== 'pickup' && o.order_type !== 'delivery') return `order_type ${String(o.order_type)}`;
  if (!isStr(o.restaurant_id)) return 'restaurant_id';
  if (!isStr(o.created_at)) return 'created_at';
  if (!isStr(o.items_written_at)) return 'items_written_at (an unwritten order was served)';
  for (const k of ['scheduled_for', 'accepted_at', 'acknowledged_at', 'stuck_acknowledged_at', 'quoted_for', 'special_instructions', 'cancelled_by']) {
    if (!isStrOrNull(o[k])) return k;
  }
  if (!(o.include_utensils === null || isBool(o.include_utensils))) return 'include_utensils';
  if (!obj(o.customer) || !isStrOrNull(o.customer.name) || !isStrOrNull(o.customer.phone)) return 'customer';
  if (!Array.isArray(o.items)) return 'items';
  for (const [i, it] of o.items.entries()) {
    if (!obj(it)) return `items[${i}]`;
    if (!isInt(it.quantity) || it.quantity < 1) return `items[${i}].quantity`;
    if (!isStr(it.item_name)) return `items[${i}].item_name`;
    if (!isStrOrNull(it.menu_item_id) || !isStrOrNull(it.category_id)) return `items[${i}].menu_item_id / category_id`;
    if (!isStrOrNull(it.size_name) || !isStrOrNull(it.special_instructions)) return `items[${i}]`;
    const kh = o.channel === 'kitchenhub';
    if (!(isInt(it.line_total_cents) || (kh && it.line_total_cents === null))) return `items[${i}].line_total_cents`;
    if (!isBool(it.discount_exempt) || !isBool(it.loyalty_reward) || !isBool(it.mapped)) return `items[${i}] flags`;
    if (!Array.isArray(it.toppings)) return `items[${i}].toppings`;
    for (const t of it.toppings) {
      if (!obj(t) || !isStr(t.name) || !isStrOrNull(t.placement) || !(isInt(t.price_cents) || (kh && t.price_cents === null))) return `items[${i}].toppings`;
      if (!isInt(t.qty) || t.qty < 1 || !isStrOrNull(t.group) || !isInt(t.depth) || t.depth < 0) return `items[${i}].toppings qty / group / depth`;
      if (!(t.placement_type === null || t.placement_type === 'pizza' || t.placement_type === 'addon')) return `items[${i}].toppings.placement_type`;
    }
  }
  if (!obj(o.money)) return 'money';
  for (const k of ['subtotal_cents', 'discount_cents', 'loyalty_discount_cents', 'delivery_fee_cents', 'tax_cents', 'service_fee_cents', 'tip_cents', 'total_cents']) {
    if (!(isInt(o.money[k]) || (o.channel === 'kitchenhub' && o.money[k] === null))) return `money.${k}`;
  }
  if (!Array.isArray(o.money.problems) || !o.money.problems.every(isStr)) return 'money.problems';
  if (!isStrOrNull(o.money.discount_percentage)) return 'money.discount_percentage';
  if (!obj(o.refund) || !['none', 'pending', 'partial', 'completed', 'failed'].includes(o.refund.status as string)) return 'refund';
  if (!(o.refund.amount_cents === null || isInt(o.refund.amount_cents)) || !isStrOrNull(o.refund.refunded_at) || !isStrOrNull(o.refund.reason)) return 'refund';
  if (o.delivery !== null) {
    const d = o.delivery;
    if (!obj(d) || !isStr(d.provider) || !DELIVERY_STATUSES.includes(d.status as OnlineDeliveryStatus)) return 'delivery';
    for (const k of ['address', 'apt', 'provider_status', 'pickup_ready_at', 'pickup_eta', 'dropoff_eta', 'dispatched_at', 'tracking_url', 'cancelled_by']) {
      if (!isStrOrNull(d[k])) return `delivery.${k}`;
    }
    if (!(d.courier === null || (obj(d.courier) && isStrOrNull(d.courier.name) && isStrOrNull(d.courier.phone)))) return 'delivery.courier';
  }
  if (o.channel === 'kitchenhub') {
    const e = o.external;
    if (!obj(e) || !isStr(e.provider) || !isStrOrNull(e.provider_order_code) || !isBool(e.asap)) return 'external';
    for (const k of ['pickup_at', 'placed_at', 'completed_at', 'cancelled_at', 'payment_method']) if (!isStrOrNull(e[k])) return `external.${k}`;
    if (!(e.paid === null || isBool(e.paid))) return 'external.paid';
    if (!(e.prep_time_minutes === null || isInt(e.prep_time_minutes))) return 'external.prep_time_minutes';
    if (!(e.delivery_type === null || e.delivery_type === 'provider' || e.delivery_type === 'restaurant')) return 'external.delivery_type';
    if (!(e.courier === null || (obj(e.courier) && isStrOrNull(e.courier.name) && isStrOrNull(e.courier.phone) && isStrOrNull(e.courier.status)))) return 'external.courier';
  } else if (o.external !== null) return 'external (on an Ordr row)';
  if (!Array.isArray(o.adjustments)) return 'adjustments';
  for (const [i, a] of o.adjustments.entries()) {
    if (!obj(a) || !isStr(a.id) || (a.type !== 'refund' && a.type !== 'charge') || !isInt(a.amount_cents) || a.amount_cents <= 0) return `adjustments[${i}]`;
    if (!isStr(a.note) || !isStr(a.created_at) || !isStrOrNull(a.approved_at)) return `adjustments[${i}]`;
    if (!['pending', 'approved', 'denied'].includes(a.status as string)) return `adjustments[${i}].status`;
  }
  if (!obj(o.print) || !Array.isArray(o.print.stations)) return 'print.stations';
  for (const st of o.print.stations) {
    if (!obj(st) || !isStr(st.station) || !isStr(st.name) || !Array.isArray(st.lines) || !st.lines.every((n) => isInt(n) && (n as number) >= 0 && (n as number) < (o.items as unknown[]).length) || !isStrOrNull(st.printed_at) || !(st.result === null || ['printed', 'printed_unconfirmed', 'failed'].includes(st.result as string))) return 'print.stations';
  }
  if (!isStrOrNull(o.print.claimed_by_device_id) || !isStrOrNull(o.print.claimed_at) || !isStrOrNull(o.print.printed_at)) return 'print';
  if (!(o.print.print_status === null || ['pending', 'printed', 'failed'].includes(o.print.print_status as string)) || !isInt(o.print.print_attempts)) return 'print.print_status';
  if (!(o.print.result === null || ['printed', 'printed_unconfirmed', 'failed'].includes(o.print.result as string))) return 'print.result';
  if (!Array.isArray(o.print.attempts)) return 'print.attempts';
  for (const a of o.print.attempts) {
    if (!obj(a) || !isStr(a.at) || !isStrOrNull(a.device_id) || !isStrOrNull(a.error) || !(a.station === undefined || isStrOrNull(a.station))) return 'print.attempts';
    if (!['auto', 'manual', 'reprint'].includes(a.variant as string) || !['printed', 'printed_unconfirmed', 'failed'].includes(a.result as string)) return 'print.attempts';
  }
  return null;
}

export function parseOnlineOrder(raw: unknown): ParsedOnlineOrder {
  if (!obj(raw)) return { kind: 'unkeyable', problem: 'not an object' };
  const { id, order_number } = raw;
  if (!isStr(id) || id.length === 0) return { kind: 'unkeyable', problem: 'id' };
  if (!isInt(order_number)) return { kind: 'unkeyable', problem: `order ${id}: order_number` };
  const problem = problemOf(raw);
  if (problem) return { kind: 'unreadable', id, order_number, status: isStr(raw.status) ? raw.status : null, problem };
  return { kind: 'ok', order: raw as unknown as OnlineOrderWire };
}

/** Minimal shape check on settings; a bad blob is ignored (the previous settings stay). */
export function settingsProblem(s: unknown): string | null {
  if (!obj(s)) return 'not an object';
  if (!isStr(s.hash)) return 'hash';
  if (!isStr(s.timezone) || !isStr(s.business_day_cutoff)) return 'timezone';
  if (!obj(s.service_windows)) return 'service_windows';
  if (s.print_trigger !== 'received' && s.print_trigger !== 'in_progress') return 'print_trigger';
  if (!isInt(s.auto_print_copies) || s.auto_print_copies < 1 || s.auto_print_copies > 5) return 'auto_print_copies';
  if (!isBool(s.pos_online_orders_enabled)) return 'pos_online_orders_enabled';
  if (!isBool(s.online_auto_print_enabled) || !isBool(s.kitchenhub_auto_print_enabled)) return 'auto_print flags';
  if (!Array.isArray(s.delivery_providers)) return 'delivery_providers';
  if (!obj(s.capabilities) || !isBool(s.capabilities.kitchenhub_menu_sync)) return 'capabilities';
  if (!Array.isArray(s.kitchenhub_providers)) return 'kitchenhub_providers';
  return null;
}
