/**
 * Rows → the §3c wire (ordr-pos @ 7798d52 docs/SYNC-CONTRACT.md :525-591; types src/sync/onlineContract.ts
 * :96-310). Pure. Every key present, null when absent; money integer cents.
 *
 * Ordr rows (orders + order_items + order_item_toppings + adjustment_requests, feedQuery.ts FEED_SELECT):
 *   items[].menu_item_id = order_items.menu_item_id (001:142, nullable since 082:20 — a loyalty discount line);
 *   items[].category_id  = menu_items.category_id read NOW (embedded): the item's CURRENT category, not the one
 *                          it had when ordered (order_items stores no category; no column may be added). null when
 *                          the line has no menu item or the item no longer exists.
 *   line_total_cents = (base_price + Σ topping price_charged) × quantity — the tablet's ticket (epsonPrint.js:352-354).
 * KitchenHub rows (external_orders, 090 + 092): §3c:569-577 — status new → new, accepted → in_progress, completed →
 *   complete, cancelled → cancelled; items from the marketplace JSON (name, quantity, options[{name, quantity,
 *   modifier_name, options}], instructions — the tablet's reader, epsonPrint.js addExternalTicket / addOptionLines);
 *   menu_item_id / category_id null, mapped false (§3c:573-574), prices null; charges → cents or null (+ problems).
 * Print block (both): pos_online_print_* rows (store.ts printState) + the row's own print_status / print_attempts;
 *   a legacy print_status 'printed' with no POS claim → result 'printed' (§3c:567-568, fakeOnline.ts:543).
 */
import { orderPrintResult, type OnlinePrintWire, type PrintResult } from './printRules.ts';
import type { FeedRow } from './feedQuery.ts';
import type { ClaimRow, LogRow, OrderChannel, PrintState, StationRow } from './store.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type OnlineStatus = 'new' | 'scheduled' | 'in_progress' | 'self_delivering' | 'complete' | 'cancelled';
const ORDR_STATUSES: readonly OnlineStatus[] = ['new', 'scheduled', 'in_progress', 'self_delivering', 'complete', 'cancelled'];
const DELIVERY_STATUSES = ['not_dispatched', 'scheduled', 'pending', 'pickup', 'pickup_complete', 'dropoff', 'delivered', 'cancelled', 'returned', 'failed'] as const;
type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface OnlineToppingWire { name: string; placement: string | null; placement_type: 'pizza' | 'addon' | null; price_cents: number | null; qty: number; group: string | null; depth: number }
export interface OnlineItemWire {
  menu_item_id: string | null; category_id: string | null; quantity: number; item_name: string; size_name: string | null;
  line_total_cents: number | null; special_instructions: string | null; discount_exempt: boolean; loyalty_reward: boolean; mapped: boolean;
  toppings: OnlineToppingWire[];
}
export interface OnlineMoneyWire {
  subtotal_cents: number | null; discount_cents: number | null; discount_percentage: string | null; loyalty_discount_cents: number | null;
  delivery_fee_cents: number | null; tax_cents: number | null; service_fee_cents: number | null; tip_cents: number | null; total_cents: number | null;
  problems: string[];
}
export interface OnlineDeliveryWire {
  provider: string; address: string | null; apt: string | null; status: DeliveryStatus; provider_status: string | null;
  pickup_ready_at: string | null; pickup_eta: string | null; dropoff_eta: string | null; dispatched_at: string | null;
  tracking_url: string | null; courier: { name: string | null; phone: string | null } | null; cancelled_by: string | null;
}
export interface OnlineExternalWire {
  provider: string; provider_order_code: string | null; asap: boolean; pickup_at: string | null; placed_at: string | null;
  completed_at: string | null; cancelled_at: string | null; prep_time_minutes: number | null; paid: boolean | null;
  payment_method: string | null; delivery_type: 'provider' | 'restaurant' | null;
  courier: { name: string | null; phone: string | null; status: string | null } | null;
}
export interface OnlineAdjustmentWire { id: string; type: 'charge' | 'refund'; amount_cents: number; note: string; status: 'pending' | 'approved' | 'denied'; created_at: string; approved_at: string | null }
export interface OnlineOrderWire {
  id: string; channel: OrderChannel; channel_status: string; restaurant_id: string; order_number: number; status: OnlineStatus;
  order_type: 'pickup' | 'delivery'; created_at: string; scheduled_for: string | null; accepted_at: string | null;
  acknowledged_at: string | null; stuck_acknowledged_at: string | null; items_written_at: string; quoted_for: string | null;
  customer: { name: string | null; phone: string | null }; special_instructions: string | null; include_utensils: boolean | null;
  items: OnlineItemWire[]; money: OnlineMoneyWire;
  refund: { status: 'none' | 'pending' | 'partial' | 'completed' | 'failed'; amount_cents: number | null; refunded_at: string | null; reason: string | null };
  delivery: OnlineDeliveryWire | null; external: OnlineExternalWire | null; adjustments: OnlineAdjustmentWire[];
  print: OnlinePrintWire; cancelled_by: string | null;
}

// ---- scalars -----------------------------------------------------------------------------------------

/** Timestamps → ISO (ms, Z). Postgres' `…+00:00` / microseconds normalized; anything unparsable → null. */
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const strAny = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const posInt = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 ? n : dflt;
};

/**
 * Dollars (numeric column / JSON number / numeric string) → integer cents, half away from zero; null when absent
 * or not a finite number. Exact for ≤ 2 decimals (the decimal string is scaled, not the float).
 */
export function toCents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const text = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) {
    // exponent notation etc.: fall back to the float, rounded
    const n = typeof v === 'number' ? v : Number(text);
    return Number.isFinite(n) && text !== '' ? Math.sign(n) * Math.round(Math.abs(n) * 100) : null;
  }
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] === '-' && cents !== 0 ? -cents : cents;
}
const centsOr0 = (v: unknown): number => toCents(v) ?? 0;

/** "10", "12.5"; 0 / absent → null. */
function percentString(v: unknown): string | null {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n) || n === 0) return null;
  return String(n);
}

// ---- print -------------------------------------------------------------------------------------------

export interface PrintIndex {
  claims: Map<string, ClaimRow>;
  stations: Map<string, StationRow[]>;
  log: Map<string, LogRow[]>;
}
const pkey = (channel: string, id: string) => `${channel}:${id}`;

export function indexPrintState(s: PrintState): PrintIndex {
  const claims = new Map<string, ClaimRow>();
  const stations = new Map<string, StationRow[]>();
  const log = new Map<string, LogRow[]>();
  for (const c of s.claims) claims.set(pkey(c.order_channel, c.order_id), c);
  for (const st of s.stations) {
    const k = pkey(st.order_channel, st.order_id);
    if (!stations.has(k)) stations.set(k, []);
    stations.get(k)!.push(st);
  }
  for (const l of s.log) {
    const k = pkey(l.order_channel, l.order_id);
    if (!log.has(k)) log.set(k, []);
    log.get(k)!.push(l);
  }
  for (const v of stations.values()) v.sort((a, b) => a.position - b.position || (a.station < b.station ? -1 : 1));
  return { claims, stations, log };
}

const PRINT_STATUSES = ['pending', 'printed', 'failed'] as const;

/**
 * The wire's print block. With a claim: its result / printed_at (kept in step by 110). Without one: the result
 * over stations recorded with no claim (a reprint / Print before any claim) — printed_at = the latest station's.
 * Legacy: print_status 'printed', no claim, no result → 'printed' (the tablet printed it; never again).
 */
export function printWire(channel: OrderChannel, row: Row, idx: PrintIndex, itemCount: number): OnlinePrintWire {
  const k = pkey(channel, row.id);
  const claim = idx.claims.get(k) ?? null;
  const stations = (idx.stations.get(k) ?? []).map((s) => ({
    station: s.station,
    name: s.name,
    // the device refuses a row whose station lines point past its items (onlineContract.ts:439): keep in range
    lines: s.lines.filter((n) => Number.isSafeInteger(n) && n >= 0 && n < itemCount),
    result: s.result,
    printed_at: isoOrNull(s.printed_at),
  }));
  let result: PrintResult | null = claim ? claim.result : orderPrintResult(stations);
  let printedAt: string | null = claim
    ? isoOrNull(claim.printed_at)
    : result === 'printed' ? stations.map((s) => s.printed_at).filter((x): x is string => !!x).sort().at(-1) ?? null : null;
  const printStatus = (PRINT_STATUSES as readonly string[]).includes(row.print_status) ? row.print_status : null;
  if (result === null && claim === null && printStatus === 'printed') {
    result = 'printed';
    printedAt = channel === 'kitchenhub' ? isoOrNull(row.printed_at) : null;
  }
  return {
    stations,
    claimed_by_device_id: claim ? claim.device_id : null,
    claimed_at: claim ? isoOrNull(claim.claimed_at) : null,
    result,
    printed_at: printedAt,
    attempts: (idx.log.get(k) ?? []).map((l) => ({ at: isoOrNull(l.at)!, device_id: l.device_id, variant: l.variant, result: l.result, error: l.error, station: l.station })),
    print_status: printStatus,
    print_attempts: Number.isSafeInteger(row.print_attempts) ? row.print_attempts : 0,
  };
}

// ---- Ordr rows ---------------------------------------------------------------------------------------

/** §3c:556-562. uber_direct: unbooked → not_dispatched; a booked scheduled order whose uber_status is pending reads
 * `scheduled` until woken; canceled → cancelled. in_house: delivered once complete, cancelled once cancelled. */
export function deliveryStatus(row: Row): DeliveryStatus {
  if (row.delivery_fulfillment_method === 'uber_direct') {
    if (!row.uber_delivery_id) return 'not_dispatched';
    const u = String(row.uber_status ?? '').toLowerCase();
    if (u === 'pending' || u === '') return row.status === 'scheduled' ? 'scheduled' : 'pending';
    if (u === 'canceled' || u === 'cancelled') return 'cancelled';
    if ((DELIVERY_STATUSES as readonly string[]).includes(u)) return u as DeliveryStatus;
    return 'pending';
  }
  if (row.status === 'complete') return 'delivered';
  if (row.status === 'cancelled') return 'cancelled';
  return 'not_dispatched';
}

function ordrDelivery(row: Row): OnlineDeliveryWire | null {
  if (row.order_type !== 'delivery') return null;
  const provider = row.delivery_fulfillment_method === 'uber_direct' ? 'uber_direct' : 'in_house';
  const booked = provider === 'uber_direct' && !!row.uber_delivery_id;
  const status = deliveryStatus(row);
  const ci = row.uber_courier_info && typeof row.uber_courier_info === 'object' ? row.uber_courier_info : null;
  return {
    provider,
    address: str(row.delivery_address),
    apt: null, // orders has no apt column (076 added delivery_apt to customer_identities only); the address text carries it
    status,
    provider_status: str(row.uber_status),
    pickup_ready_at: isoOrNull(row.uber_pickup_ready_dt),
    pickup_eta: isoOrNull(row.uber_pickup_eta),
    dropoff_eta: isoOrNull(row.uber_dropoff_eta),
    dispatched_at: booked ? (isoOrNull(row.uber_dispatched_at) ?? isoOrNull(row.uber_status_updated_at) ?? isoOrNull(row.created_at)) : null,
    tracking_url: str(row.uber_tracking_url),
    courier: ci ? { name: str(ci.name), phone: str(ci.phone_number) ?? str(ci.phone) } : null,
    cancelled_by: status === 'cancelled' && provider === 'uber_direct'
      ? (String(row.cancelled_by ?? '').startsWith('restaurant') ? 'restaurant' : 'provider')
      : null,
  };
}

const REFUND_STATUSES = ['pending', 'partial', 'completed', 'failed'] as const;

export function ordrOrderWire(row: FeedRow, idx: PrintIndex): OnlineOrderWire {
  const items: OnlineItemWire[] = (Array.isArray(row.order_items) ? row.order_items : []).map((it: Row) => {
    const tops: Row[] = Array.isArray(it.order_item_toppings) ? it.order_item_toppings : [];
    const qty = posInt(it.quantity, 1);
    const unit = centsOr0(it.base_price) + tops.reduce((s, t) => s + centsOr0(t.price_charged), 0);
    const mi = it.menu_items && typeof it.menu_items === 'object' ? it.menu_items : null;
    return {
      menu_item_id: str(it.menu_item_id),
      category_id: mi ? str(mi.category_id) : null,
      quantity: qty,
      item_name: typeof it.item_name === 'string' ? it.item_name : '',
      size_name: str(it.size_name),
      line_total_cents: unit * qty,
      special_instructions: str(it.special_instructions),
      discount_exempt: it.discount_exempt === true,
      loyalty_reward: it.loyalty_redemption_id != null,
      mapped: true,
      toppings: tops.map((t) => ({
        name: typeof t.topping_name === 'string' ? t.topping_name : '',
        placement: str(t.placement),
        placement_type: t.placement_type === 'addon' ? 'addon' : t.placement_type === 'pizza' ? 'pizza' : null,
        price_cents: centsOr0(t.price_charged),
        qty: 1,
        group: null,
        depth: 0,
      })),
    };
  });
  const adjustments: OnlineAdjustmentWire[] = (Array.isArray(row.adjustment_requests) ? row.adjustment_requests : [])
    .map((a: Row) => ({
      id: String(a.id),
      type: a.type === 'refund' ? 'refund' : 'charge',
      amount_cents: centsOr0(a.amount),
      note: typeof a.note === 'string' ? a.note : '',
      status: a.status === 'approved' ? 'approved' : a.status === 'denied' ? 'denied' : 'pending',
      created_at: isoOrNull(a.created_at)!,
      approved_at: isoOrNull(a.approved_at),
    } as OnlineAdjustmentWire))
    // the device refuses amount_cents ≤ 0 (onlineContract.ts:433): such a row could never come from the tablet's ADJUST
    .filter((a: OnlineAdjustmentWire) => a.amount_cents > 0 && a.created_at !== null);
  const status = (ORDR_STATUSES as readonly string[]).includes(row.status) ? (row.status as OnlineStatus) : 'new';
  return {
    id: row.id,
    channel: 'ordr',
    channel_status: String(row.status),
    restaurant_id: row.restaurant_id,
    order_number: Number(row.order_number),
    status,
    order_type: row.order_type === 'delivery' ? 'delivery' : 'pickup',
    created_at: isoOrNull(row.created_at)!,
    scheduled_for: isoOrNull(row.scheduled_for),
    accepted_at: isoOrNull(row.accepted_at),
    acknowledged_at: isoOrNull(row.acknowledged_at),
    stuck_acknowledged_at: isoOrNull(row.stuck_acknowledged_at),
    items_written_at: isoOrNull(row.items_written_at)!,
    quoted_for: isoOrNull(row.quoted_for),
    customer: { name: str(row.customer_name), phone: str(row.phone_e164) ?? str(row.customer_phone) },
    special_instructions: str(row.special_instructions),
    include_utensils: bool(row.include_utensils),
    items,
    money: {
      subtotal_cents: centsOr0(row.subtotal),
      discount_cents: centsOr0(row.discount_amount),
      discount_percentage: percentString(row.discount_percentage),
      loyalty_discount_cents: centsOr0(row.loyalty_discount_amount),
      delivery_fee_cents: centsOr0(row.delivery_fee),
      tax_cents: centsOr0(row.tax_amount),
      service_fee_cents: centsOr0(row.service_fee),
      tip_cents: centsOr0(row.tip_amount),
      total_cents: centsOr0(row.total_amount),
      problems: [],
    },
    refund: {
      status: (REFUND_STATUSES as readonly string[]).includes(row.refund_status) ? row.refund_status : 'none',
      amount_cents: toCents(row.refund_amount),
      refunded_at: isoOrNull(row.refunded_at),
      reason: str(row.refund_reason),
    },
    delivery: ordrDelivery(row),
    external: null,
    adjustments,
    print: printWire('ordr', row, idx, items.length),
    cancelled_by: str(row.cancelled_by),
  };
}

// ---- KitchenHub rows ---------------------------------------------------------------------------------

const KH_STATUS: Record<string, OnlineStatus> = { new: 'new', accepted: 'in_progress', completed: 'complete', cancelled: 'cancelled' };

/** Marketplace id from provider_id / provider_name (dspProvider.js providerKey, loosely). */
export function marketplaceId(row: Row): string {
  const k = String(row.provider_id || row.provider_name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (k.includes('doordash')) return 'doordash';
  if (k.includes('grubhub')) return 'grubhub';
  if (k.includes('uber')) return 'uber';
  return k || 'unknown';
}

function khOptions(options: unknown, depth: number, out: OnlineToppingWire[]): void {
  if (!Array.isArray(options) || depth > 10) return;
  for (const op of options) {
    if (!op || typeof op !== 'object') continue;
    const o = op as Row;
    const name = strAny(o.name);
    if (name) out.push({ name, placement: null, placement_type: null, price_cents: null, qty: posInt(o.quantity, 1), group: str(o.modifier_name), depth });
    khOptions(o.options, depth + 1, out);
  }
}

/** charges.* → cents or null; a present value that isn't a number → null + its wire name in problems. */
function khMoney(row: Row): OnlineMoneyWire {
  const charges: Row = row.charges && typeof row.charges === 'object' && !Array.isArray(row.charges) ? row.charges : {};
  const problems: string[] = [];
  const conv = (wireName: string, v: unknown, abs = false): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const c = typeof v === 'number' || (typeof v === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) ? toCents(v) : null;
    if (c === null) {
      problems.push(wireName);
      return null;
    }
    return abs ? Math.abs(c) : c;
  };
  const m: OnlineMoneyWire = {
    subtotal_cents: conv('subtotal', charges.subtotal),
    discount_cents: conv('discount', charges.discount, true),
    discount_percentage: null,
    loyalty_discount_cents: null,
    delivery_fee_cents: conv('delivery_fee', charges.delivery_fee),
    tax_cents: conv('tax', charges.tax),
    service_fee_cents: conv('service_fee', charges.service_fee),
    tip_cents: conv('tip', charges.tips),
    total_cents: conv('total', charges.total ?? row.total),
    problems,
  };
  return m;
}

export function khOrderWire(row: FeedRow, idx: PrintIndex): OnlineOrderWire {
  const items: OnlineItemWire[] = (Array.isArray(row.items) ? row.items : []).filter((it: unknown) => it && typeof it === 'object').map((it: Row) => {
    const toppings: OnlineToppingWire[] = [];
    khOptions(it.options, 0, toppings);
    return {
      menu_item_id: null,
      category_id: null,
      quantity: posInt(it.quantity, 1),
      item_name: strAny(it.name) ?? '',
      size_name: null,
      line_total_cents: null,
      special_instructions: str(it.instructions),
      discount_exempt: false,
      loyalty_reward: false,
      mapped: false,
      toppings,
    };
  });
  const asap = row.asap === false ? false : true;
  const placedAt = isoOrNull(row.placed_at);
  const createdAt = placedAt ?? isoOrNull(row.created_at)!;
  const isDelivery = String(row.order_type ?? '').toLowerCase().includes('delivery');
  const dType = row.delivery_type === 'provider' || row.delivery_type === 'restaurant' ? row.delivery_type : null;
  const d: Row = row.delivery && typeof row.delivery === 'object' ? row.delivery : {};
  const courier: Row | null = d.courier && typeof d.courier === 'object' ? d.courier : null;
  const addr: Row = d.address && typeof d.address === 'object' ? d.address : {};
  const status = KH_STATUS[row.status] ?? 'new';
  const code = row.order_number != null && row.order_number !== '' ? String(row.order_number) : row.daily_number != null ? String(row.daily_number) : null;
  return {
    id: row.id,
    channel: 'kitchenhub',
    channel_status: String(row.status),
    restaurant_id: row.restaurant_id,
    // external_orders.order_number is the marketplace's TEXT code; the wire needs an integer key → kh_order_id
    order_number: Number(row.kh_order_id),
    status,
    order_type: isDelivery ? 'delivery' : 'pickup',
    created_at: createdAt,
    scheduled_for: asap ? null : (isoOrNull(row.scheduled_for) ?? isoOrNull(row.pickup_at)),
    accepted_at: isoOrNull(row.accepted_at),
    acknowledged_at: isoOrNull(row.acknowledged_at),
    stuck_acknowledged_at: null,
    items_written_at: isoOrNull(row.created_at)!,
    quoted_for: null,
    customer: { name: str(row.customer_name), phone: str(row.customer_phone) },
    special_instructions: str(row.notes),
    include_utensils: null,
    items,
    money: khMoney(row),
    refund: { status: 'none', amount_cents: null, refunded_at: null, reason: null },
    // restaurant-delivered marketplace orders carry the drop-off address (the tablet prints it, epsonPrint.js:697-700)
    delivery: isDelivery && dType === 'restaurant'
      ? {
        provider: 'in_house',
        address: [str(addr.street) ?? str(addr.address_line_1) ?? str(addr.full_address), [str(addr.city), [str(addr.state), str(addr.zipcode)].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null,
        apt: strAny(addr.unit_number),
        status: status === 'complete' ? 'delivered' : status === 'cancelled' ? 'cancelled' : 'not_dispatched',
        provider_status: null, pickup_ready_at: null, pickup_eta: null, dropoff_eta: null, dispatched_at: null, tracking_url: null,
        courier: null, cancelled_by: null,
      }
      : null,
    external: {
      provider: marketplaceId(row),
      provider_order_code: code,
      asap,
      pickup_at: isoOrNull(row.pickup_at),
      placed_at: placedAt,
      completed_at: isoOrNull(row.completed_at),
      cancelled_at: isoOrNull(row.cancelled_at),
      prep_time_minutes: Number.isSafeInteger(row.prep_time_minutes) ? row.prep_time_minutes : null,
      paid: bool(row.paid),
      payment_method: str(row.payment_method),
      delivery_type: dType,
      courier: courier ? { name: str(courier.name), phone: str(courier.phone_number) ?? str(courier.phone), status: str(courier.status) } : null,
    },
    adjustments: [],
    print: printWire('kitchenhub', row, idx, items.length),
    cancelled_by: str(row.cancelled_by),
  };
}

/** Both channels → the served list: written Ordr rows only (D6), newest first, ties by id. */
export function servedOrders(rows: { orders: FeedRow[]; kitchenhub: FeedRow[] }, state: PrintState): OnlineOrderWire[] {
  const idx = indexPrintState(state);
  const out = [
    ...rows.orders.filter((r) => isoOrNull(r.items_written_at) !== null && isoOrNull(r.created_at) !== null).map((r) => ordrOrderWire(r, idx)),
    ...rows.kitchenhub.filter((r) => isoOrNull(r.created_at) !== null && Number.isSafeInteger(Number(r.kh_order_id))).map((r) => khOrderWire(r, idx)),
  ];
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- settings ----------------------------------------------------------------------------------------

export interface OnlineSettingsWire {
  hash: string; timezone: string; business_day_cutoff: string;
  service_windows: { pickup: Record<string, { start: string; end: string }[]> | null; delivery: Record<string, { start: string; end: string }[]> | null };
  estimated_pickup_minutes: number; estimated_delivery_minutes: number; ready_time_confirmation_enabled: boolean; delivery_available: boolean;
  print_trigger: 'received' | 'in_progress'; auto_print_copies: number; receipt_font: 'normal' | 'large';
  online_print_device_id: string | null; online_auto_print_enabled: boolean; kitchenhub_auto_print_enabled: boolean;
  pos_online_orders_enabled: boolean; dsp_orders_enabled: boolean;
  /** CP23 (additive): provider delivery dispatch for POS orders is on for this restaurant. */
  pos_delivery_dispatch_enabled: boolean;
  delivery_providers: { id: string; label: string; active: boolean }[];
  capabilities: { kitchenhub_menu_sync: boolean };
  kitchenhub_providers: { id: string; label: string; paused_until: string | null }[];
}

export const MARKETPLACE_LABELS: Record<string, string> = { doordash: 'DoorDash', grubhub: 'Grubhub', uber: 'Uber Eats' };

export function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= lo && n <= hi ? n : dflt;
}
