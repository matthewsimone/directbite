/**
 * pos-v1-submit-order request (ordr-pos SYNC-CONTRACT §3.2; src/sync/contract.ts OrderPayload) —
 * wire types, the pre-pricing guards the reference runs (redemption keys, card data, payment shape),
 * and the structural validation a real server needs on top (the FakeServer trusts TS types).
 *
 * Reference: ordr-pos test/support/fakeServer.ts — paymentShapeError (:85-92), hasRedemptionKey
 * (:93-97), findCardNumbers over the payload minus provisional_pricing (:906-910).
 */
import { parseRate } from '../ordr-core/money.ts';
import { findCardNumbers } from '../ordr-core-ext/cardData.ts';
import { sizePricesArrayProblem, type SizePriceEntry } from './sizePrices.ts';

// ---- wire types -------------------------------------------------------------------------------

export interface WireBreakdown {
  lines: { unit_cents: number; quantity: number; line_total_cents: number; modifiers: { charge_cents: number }[] }[];
  subtotal_cents: number;
  discountable_subtotal_cents: number;
  promo_discount_cents: number;
  discounted_subtotal_cents: number;
  loyalty_discount_face_cents: number;
  loyalty_discount_applied_cents: number;
  net_subtotal_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  recoup_cents: number;
  service_fee_cents: number;
  taxable_cents: number;
  tax_cents: number;
  total_cents: number;
  loyalty_earn: { basis_cents: number; base_points: number };
  rates: { promo_percent: string | null; recoup_rate: string; tax_rate: string };
}

export interface WireModifier {
  id: string;
  position: number;
  kind: 'pizza' | 'addon';
  topping_id: string;
  name: string;
  placement: 'whole' | 'left' | 'right' | null;
  price_cents: number;
  price_half_cents: number | null;
  /** CP9b contract change (POS-confirmed): sorted array, normalized keys. */
  size_prices: SizePriceEntry[] | null;
  charge_cents: number;
}

export interface WireLine {
  id: string;
  position: number;
  menu_item_id: string;
  item_size_id: string | null;
  item_name: string;
  size_name: string | null;
  quantity: number;
  base_price_cents: number;
  discount_exempt: boolean;
  status: 'active' | 'voided';
  void_reason: string | null;
  voided_by?: string | null;
  void_approved_by?: string | null;
  seat?: number | null;
  course?: number | null;
  check_no?: number | null;
  fired_seq?: number | null;
  special_instructions: string | null;
  modifiers: WireModifier[];
}

export interface WirePayment {
  id: string;
  method: 'cash' | 'external_card';
  amount_cents: number;
  tendered_cents: number;
  change_cents: number;
  status: 'captured' | 'voided';
  check_no?: number | null;
  last4: string | null;
  external_ref: string | null;
  taken_by?: string | null;
  voided_by?: string | null;
  void_approved_by?: string | null;
  /** §3.2 prose ("arrives voided with a void_reason") — not in the device's WirePayment type today. Stored if sent. */
  void_reason?: string | null;
}

export type DeliveryFeeSource = 'pending' | 'quoted' | 'offline' | 'override';

export interface WireDeliveryOverride { reason: string; actor: string; approved_by?: string | null }

export interface WireDelivery {
  address: { street: string; unit: string | null; city: string; state: string; zip: string; instructions: string | null } | null;
  fee_source: DeliveryFeeSource;
  fee_cents: number;
  fee_attached_at: string | null;
  quote_id: string | null;
  quote_expires_at: string | null;
  normalized_address: string | null;
  lat: string | null;
  lng: string | null;
  distance_miles: string | null;
  tier: number | null;
  delivery_unverified: boolean;
  driver_type: string;
  overrides: { radius: WireDeliveryOverride | null; minimum: WireDeliveryOverride | null };
  uber: unknown;
}

export interface OrderPayload {
  order_id: string;
  version: number;
  base_server_version: number;
  content_hash: string;
  restaurant_id: string;
  device_id: string;
  ticket: { prefix: string; business_date: string; counter: number };
  order_type: 'pickup' | 'delivery' | 'dine_in';
  channel: 'counter' | 'phone' | 'dine_in';
  status: 'open' | 'closed' | 'voided';
  customer: { name: string | null; phone_e164: string | null };
  note: string | null;
  ready_at: string | null;
  void_reason: string | null;
  created_by?: string | null;
  closed_by?: string | null;
  voided_by?: string | null;
  void_approved_by?: string | null;
  delivery: WireDelivery | null;
  table?: { label: string | null; guest_count: number | null };
  menu_snapshot_hash: string;
  lines: WireLine[];
  tip: { mode: 'none' | 'percent' | 'amount'; percent: string | null; amount_cents: number | null };
  payments: WirePayment[];
  provisional_pricing: WireBreakdown;
  pricing_config: Record<string, unknown>;
  device_time: string;
}

// ---- guards the reference runs, in its order ---------------------------------------------------

export interface Problem { field: string; message: string }

/** §3.2: any object key containing "redemption" / "reward" (case-insensitive), at ANY depth. */
const REDEMPTION_KEY = /redemption|reward/i;

/** Path of the first redemption / reward key, or null. Iterative (no recursion limit, no stack risk). */
export function findRedemptionKey(value: unknown): string | null {
  const stack: [unknown, string][] = [[value, '']];
  while (stack.length) {
    const [v, path] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      v.forEach((x, i) => stack.push([x, `${path}[${i}]`]));
      continue;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const at = path ? `${path}.${k}` : k;
      if (REDEMPTION_KEY.test(k)) return at;
      stack.push([x, at]);
    }
  }
  return null;
}

/** The part of the request the redemption + card scans cover (provisional_pricing is pricing output). */
export function scannedPart(body: Record<string, unknown>): Record<string, unknown> {
  const { provisional_pricing: _pp, ...rest } = body;
  return rest;
}

/** Card-number-like free text (vendored cardData.ts) → paths. */
export function cardDataPaths(body: Record<string, unknown>): string[] {
  return findCardNumbers(scannedPart(body));
}

/** SYNC §3.2 payment rules — fakeServer.ts paymentShapeError (:85-92), plus "is an object". */
export function paymentShapeError(pay: unknown): string | null {
  if (!pay || typeof pay !== 'object' || Array.isArray(pay)) return 'not an object';
  const p = pay as Record<string, unknown>;
  if (p.method === 'cash') return p.last4 === null && p.external_ref === null ? null : 'cash carries no card fields';
  if (p.method !== 'external_card') return `unknown method ${String(p.method)}`;
  if (p.tendered_cents !== p.amount_cents || p.change_cents !== 0) return 'external_card has no change';
  if (p.last4 !== null && !(typeof p.last4 === 'string' && /^\d{4}$/.test(p.last4))) return 'last4 must be 4 digits';
  if (p.external_ref !== null && (typeof p.external_ref !== 'string' || p.external_ref.length > 40)) return 'external_ref too long';
  return null;
}

/** First payment-shape problem, or null (payments must be an array for this check to run). */
export function paymentsShapeProblem(body: Record<string, unknown>): Problem | null {
  if (!Array.isArray(body.payments)) return { field: 'payments', message: 'payments must be an array' };
  for (const [i, pay] of body.payments.entries()) {
    const why = paymentShapeError(pay);
    if (why) return { field: `payments[${i}]`, message: `payment ${String((pay as { id?: unknown })?.id)}: ${why}` };
  }
  return null;
}

// ---- structural validation (server-side addition; 400 invalid_payload) ---------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Nesting deeper than this is refused before any recursive walk (content hash, card scan). */
export const MAX_DEPTH = 32;

export function jsonDepth(value: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > max) max = d;
    if (d > MAX_DEPTH) return d;
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push([x, d + 1]);
  }
  return max;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isIso = (v: unknown) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isDate = (v: unknown) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

class Fail extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

function need(cond: boolean, field: string, message: string): void {
  if (!cond) throw new Fail(field, `${field}: ${message}`);
}
const strOrNull = (v: unknown, f: string) => need(v === null || typeof v === 'string', f, 'must be a string or null');
const intOrNull = (v: unknown, f: string) => need(v === null || isInt(v), f, 'must be an integer or null');
/** Reserved / staff fields: not required by v1 validation (§3.2), but typed when present. */
const optStr = (o: Record<string, unknown>, k: string, f: string) => { if (k in o) strOrNull(o[k], `${f}.${k}`); };
const optInt = (o: Record<string, unknown>, k: string, f: string) => { if (k in o) intOrNull(o[k], `${f}.${k}`); };

const BREAKDOWN_MONEY = [
  'subtotal_cents', 'discountable_subtotal_cents', 'promo_discount_cents', 'discounted_subtotal_cents',
  'loyalty_discount_face_cents', 'loyalty_discount_applied_cents', 'net_subtotal_cents', 'delivery_fee_cents',
  'tip_cents', 'recoup_cents', 'service_fee_cents', 'taxable_cents', 'tax_cents', 'total_cents',
] as const;

function validateBreakdown(b: unknown, f: string): void {
  need(isObj(b), f, 'must be an object');
  const o = b as Record<string, unknown>;
  for (const k of BREAKDOWN_MONEY) need(isInt(o[k]), `${f}.${k}`, 'must be integer cents');
  need(Array.isArray(o.lines), `${f}.lines`, 'must be an array');
  (o.lines as unknown[]).forEach((l, i) => {
    const lf = `${f}.lines[${i}]`;
    need(isObj(l), lf, 'must be an object');
    const x = l as Record<string, unknown>;
    need(isInt(x.unit_cents) && isInt(x.line_total_cents), lf, 'unit_cents / line_total_cents must be integer cents');
    need(Array.isArray(x.modifiers) && (x.modifiers as unknown[]).every((m) => isObj(m) && isInt(m.charge_cents)), `${lf}.modifiers`, 'must be [{ charge_cents }]');
  });
}

function validateOverride(v: unknown, f: string): void {
  if (v === null) return;
  need(isObj(v), f, 'must be an object or null');
  const o = v as Record<string, unknown>;
  need(typeof o.reason === 'string' && typeof o.actor === 'string', f, 'reason and actor must be strings');
  optStr(o, 'approved_by', f);
}

function validateDelivery(v: unknown): void {
  const f = 'delivery';
  need(isObj(v), f, 'must be an object');
  const d = v as Record<string, unknown>;
  need(typeof d.fee_source === 'string', `${f}.fee_source`, 'must be a string');
  need(isInt(d.fee_cents), `${f}.fee_cents`, 'must be integer cents');
  need(d.fee_attached_at === null || isIso(d.fee_attached_at), `${f}.fee_attached_at`, 'must be ISO-8601 or null');
  strOrNull(d.quote_id, `${f}.quote_id`);
  need(typeof d.delivery_unverified === 'boolean', `${f}.delivery_unverified`, 'must be a boolean');
  need(isObj(d.overrides), `${f}.overrides`, 'must be an object');
  const ov = d.overrides as Record<string, unknown>;
  validateOverride(ov.radius ?? null, `${f}.overrides.radius`);
  validateOverride(ov.minimum ?? null, `${f}.overrides.minimum`);
  if (d.address !== null) {
    need(isObj(d.address), `${f}.address`, 'must be an object or null');
    const a = d.address as Record<string, unknown>;
    for (const k of ['street', 'city', 'state', 'zip']) need(typeof a[k] === 'string', `${f}.address.${k}`, 'must be a string');
    strOrNull(a.unit ?? null, `${f}.address.unit`);
    strOrNull(a.instructions ?? null, `${f}.address.instructions`);
  }
}

/**
 * Everything after the reference's own checks: types / enums / ids the store and the pricing builder
 * rely on. Semantic money rules stay with the pricing module so its codes match the reference
 * (quantity 0 → pricing_error:invalid_quantity, tip 150 % → pricing_error:invalid_tip).
 */
export function validateOrderPayload(body: Record<string, unknown>): Problem | null {
  try {
    const p = body;
    need(isInt(p.version) && (p.version as number) >= 1, 'version', 'must be an integer ≥ 1');
    need(isInt(p.base_server_version) && (p.base_server_version as number) >= 0, 'base_server_version', 'must be an integer ≥ 0');
    need(isObj(p.ticket), 'ticket', 'must be an object');
    const t = p.ticket as Record<string, unknown>;
    need(isDate(t.business_date), 'ticket.business_date', 'must be YYYY-MM-DD');
    need(isInt(t.counter) && (t.counter as number) >= 0, 'ticket.counter', 'must be an integer ≥ 0');
    need(['pickup', 'delivery', 'dine_in'].includes(p.order_type as string), 'order_type', 'must be pickup | delivery | dine_in');
    need(['open', 'closed', 'voided'].includes(p.status as string), 'status', 'must be open | closed | voided');
    need(isObj(p.customer), 'customer', 'must be an object');
    strOrNull((p.customer as Record<string, unknown>).name, 'customer.name');
    strOrNull((p.customer as Record<string, unknown>).phone_e164, 'customer.phone_e164');
    strOrNull(p.note, 'note');
    need(typeof p.note !== 'string' || p.note.length <= 500, 'note', 'must be ≤ 500 characters');
    need(p.ready_at === null || isIso(p.ready_at), 'ready_at', 'must be ISO-8601 or null');
    strOrNull(p.void_reason, 'void_reason');
    for (const k of ['created_by', 'closed_by', 'voided_by', 'void_approved_by']) optStr(p, k, '');
    if (p.order_type === 'delivery') {
      need(p.delivery !== null && p.delivery !== undefined, 'delivery', 'delivery order without delivery data');
    }
    need('delivery' in p, 'delivery', 'must be present (null for non-delivery orders)');
    if (p.delivery !== null) validateDelivery(p.delivery);
    if ('table' in p && p.table !== null) {
      need(isObj(p.table), 'table', 'must be an object');
      optStr(p.table as Record<string, unknown>, 'label', 'table');
      optInt(p.table as Record<string, unknown>, 'guest_count', 'table');
    }
    need(typeof p.menu_snapshot_hash === 'string', 'menu_snapshot_hash', 'must be a string');

    const ids = new Set<string>();
    const uniqueId = (v: unknown, f: string) => {
      need(typeof v === 'string' && UUID_RE.test(v), f, 'must be a UUID');
      const k = (v as string).toLowerCase();
      need(!ids.has(k), f, 'duplicate id in the request');
      ids.add(k);
    };

    need(Array.isArray(p.lines), 'lines', 'must be an array');
    (p.lines as unknown[]).forEach((l, i) => {
      const f = `lines[${i}]`;
      need(isObj(l), f, 'must be an object');
      const x = l as Record<string, unknown>;
      uniqueId(x.id, `${f}.id`);
      need(isInt(x.position), `${f}.position`, 'must be an integer');
      need(typeof x.menu_item_id === 'string', `${f}.menu_item_id`, 'must be a string');
      strOrNull(x.item_size_id, `${f}.item_size_id`);
      need(typeof x.item_name === 'string', `${f}.item_name`, 'must be a string');
      strOrNull(x.size_name, `${f}.size_name`);
      need(isInt(x.quantity), `${f}.quantity`, 'must be an integer');
      need(isInt(x.base_price_cents), `${f}.base_price_cents`, 'must be integer cents');
      need(typeof x.discount_exempt === 'boolean', `${f}.discount_exempt`, 'must be a boolean');
      need(x.status === 'active' || x.status === 'voided', `${f}.status`, 'must be active | voided');
      strOrNull(x.void_reason, `${f}.void_reason`);
      strOrNull(x.special_instructions, `${f}.special_instructions`);
      for (const k of ['voided_by', 'void_approved_by']) optStr(x, k, f);
      for (const k of ['seat', 'course', 'check_no', 'fired_seq']) optInt(x, k, f);
      need(Array.isArray(x.modifiers), `${f}.modifiers`, 'must be an array');
      (x.modifiers as unknown[]).forEach((m, j) => {
        const mf = `${f}.modifiers[${j}]`;
        need(isObj(m), mf, 'must be an object');
        const y = m as Record<string, unknown>;
        uniqueId(y.id, `${mf}.id`);
        need(isInt(y.position), `${mf}.position`, 'must be an integer');
        need(y.kind === 'pizza' || y.kind === 'addon', `${mf}.kind`, 'must be pizza | addon');
        need(typeof y.topping_id === 'string', `${mf}.topping_id`, 'must be a string');
        need(typeof y.name === 'string', `${mf}.name`, 'must be a string');
        need(y.placement === null || ['whole', 'left', 'right'].includes(y.placement as string), `${mf}.placement`, 'must be whole | left | right | null');
        need(isInt(y.price_cents), `${mf}.price_cents`, 'must be integer cents');
        intOrNull(y.price_half_cents, `${mf}.price_half_cents`);
        const sp = sizePricesArrayProblem(y.size_prices);
        need(sp === null, `${mf}.size_prices`, sp ?? '');
        need(isInt(y.charge_cents), `${mf}.charge_cents`, 'must be integer cents');
      });
    });

    need(isObj(p.tip), 'tip', 'must be an object');
    const tip = p.tip as Record<string, unknown>;
    need(['none', 'percent', 'amount'].includes(tip.mode as string), 'tip.mode', 'must be none | percent | amount');
    if (tip.mode === 'percent') {
      let okRate = typeof tip.percent === 'string';
      if (okRate) try { parseRate(tip.percent as string); } catch { okRate = false; }
      need(okRate, 'tip.percent', 'must be a decimal string');
    } else strOrNull(tip.percent, 'tip.percent');
    if (tip.mode === 'amount') need(isInt(tip.amount_cents), 'tip.amount_cents', 'must be integer cents');
    else intOrNull(tip.amount_cents, 'tip.amount_cents');

    (p.payments as unknown[]).forEach((x, i) => {
      const f = `payments[${i}]`;
      const y = x as Record<string, unknown>;
      uniqueId(y.id, `${f}.id`);
      for (const k of ['amount_cents', 'tendered_cents', 'change_cents']) need(isInt(y[k]) && (y[k] as number) >= 0, `${f}.${k}`, 'must be integer cents ≥ 0');
      need(y.status === 'captured' || y.status === 'voided', `${f}.status`, 'must be captured | voided');
      for (const k of ['taken_by', 'voided_by', 'void_approved_by', 'void_reason']) optStr(y, k, f);
      optInt(y, 'check_no', f);
    });

    validateBreakdown(p.provisional_pricing, 'provisional_pricing');
    need(isObj(p.pricing_config), 'pricing_config', 'must be an object');
    need(isIso(p.device_time), 'device_time', 'must be ISO-8601');
    return null;
  } catch (e) {
    if (e instanceof Fail) return { field: e.field, message: e.message };
    throw e;
  }
}
