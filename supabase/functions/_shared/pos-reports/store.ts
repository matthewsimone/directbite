/**
 * Owner Reports v1 — the reads (service role; pos_* stays service_role only, no RLS). Read-only.
 *
 * NO customer data is read from pos_orders (no customer_name / phone / note / address): `delivery` is read ONLY as
 * its `overrides` and `delivery_unverified` keys. Online orders are read with the feed's own select + history filter
 * (pos-online/feedQuery.ts) so their money maps exactly as the POS sees it; their customer fields never leave this
 * process (build.ts keeps only the summary).
 *
 * Which rows (the build dates them, build.ts):
 *   Zs          business_date in [from − 7, to + 7]  — a row a Z covers is dated by that Z, and a row synced after
 *               the cutoff (offline) can be covered by a Z of an earlier day
 *   orders      sales_day in [from, to] (index 120) + open orders (scheduled / deposits) + every order a Z in the
 *               window covers + the orders of every payment / refund read
 *   payments    server receive time in the range + voided in the range + covered by a Z in the window + on the
 *               orders read (tips by method, deposits applied, scheduled paid)
 *   refunds     business_date in [from, to] + covered by a Z in the window
 *   shifts      business_date in [from, to] + covered by a Z in the window (+ their paid-in / paid-out)
 *   lines       the VOIDED lines of the orders read (+ their modifier charges)
 */
// deno-lint-ignore-file no-explicit-any
import { FEED_SELECT, historyOrFilter, historyRange, KH_FEED_SELECT, normalizeFeedRows, addDays, type FeedClient, type FeedRow } from '../pos-online/feedQuery.ts';
import type { ReportRange } from './range.ts';

export interface DeviceRow { id: string; prefix: string; label: string; status: string }
export interface StaffRow { id: string; name: string }
export interface DayCloseRow {
  day_close_id: string; device_id: string; business_date: string; z_number: number; sequence: number; supplemental: boolean;
  closed_at: string; closed_by: string; approved_by: string | null; report: unknown; covered: unknown;
  carried_over_order_ids: unknown; flags: unknown; received_at: string;
}
export interface PosOrderRow {
  order_id: string; writer_device_id: string; order_type: string; channel: string; status: string; sales_day: string | null;
  ready_at: string | null; ticket_prefix: string; ticket_counter: number; ticket_business_date: string;
  provisional_pricing: unknown; flags: unknown; delivery_overrides: unknown; delivery_unverified: unknown; updated_at: string;
}
export interface PaymentRow { id: string; order_id: string; method: string; amount_cents: number; status: string; inserted_at: string; voided_at: string | null }
export interface VoidedLineRow { id: string; order_id: string; base_price_cents: number; quantity: number; modifier_charges_cents: number[] }
export interface RefundRow {
  refund_id: string; device_id: string; order_id: string; payment_id: string; method: string; amount_cents: number; reason: string;
  actor: string; approved_by: string | null; business_date: string; shift_id: string | null; created_at: string;
}
export interface MovementRow { id: string; shift_id: string; kind: string; amount_cents: number; reason: string; actor: string; approved_by: string | null; created_at: string }
export interface ShiftRow {
  shift_id: string; device_id: string; business_date: string; status: string; opened_at: string; opened_by: string;
  starting_cash_cents: number; closed_at: string | null; closed_by: string | null; close_approved_by: string | null;
  counted_cash_cents: number | null; expected_cash_cents: number | null; over_short_cents: number | null; flags: unknown;
}

export interface ReportRows {
  devices: DeviceRow[];
  staff: StaffRow[];
  zs: DayCloseRow[];
  orders: PosOrderRow[];
  payments: PaymentRow[];
  voidedLines: VoidedLineRow[];
  refunds: RefundRow[];
  shifts: ShiftRow[];
  movements: MovementRow[];
  /** Ordr orders rows (FEED_SELECT, normalized) and KitchenHub rows (KH_FEED_SELECT) for the range's business days. */
  online: { orders: FeedRow[]; kitchenhub: FeedRow[] };
}

export const PAGE = 1000;
const ID_CHUNK = 150;
/** The Z window around the range (offline rows synced after the cutoff; build.ts dates by the covering Z). */
export const Z_WINDOW_DAYS = 7;

export const ORDER_COLUMNS =
  'order_id,writer_device_id,order_type,channel,status,sales_day,ready_at,ticket_prefix,ticket_counter,ticket_business_date,' +
  'provisional_pricing,flags,delivery_overrides:delivery->overrides,delivery_unverified:delivery->delivery_unverified,updated_at';
const PAYMENT_COLUMNS = 'id,order_id,method,amount_cents,status,inserted_at,voided_at';
const Z_COLUMNS =
  'day_close_id,device_id,business_date,z_number,sequence,supplemental,closed_at,closed_by,approved_by,report,covered,carried_over_order_ids,flags,received_at';
const REFUND_COLUMNS = 'refund_id,device_id,order_id,payment_id,method,amount_cents,reason,actor,approved_by,business_date,shift_id,created_at';
const SHIFT_COLUMNS =
  'shift_id,device_id,business_date,status,opened_at,opened_by,starting_cash_cents,closed_at,closed_by,close_approved_by,' +
  'counted_cash_cents,expected_cash_cents,over_short_cents,flags';
const MOVEMENT_COLUMNS = 'id,shift_id,kind,amount_cents,reason,actor,approved_by,created_at';

export class ReportReadError extends Error {}

type Build = (q: any) => any;

/** Every row of `table` matching `filter`, PAGE rows at a time (ordered by `key` so pages are stable). */
async function readAll<T>(db: FeedClient, table: string, columns: string, key: string, filter: Build): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(db.from(table).select(columns)).order(key, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new ReportReadError(`${table} read failed: ${error.message}`);
    const rows = Array.isArray(data) ? (data as T[]) : [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Rows whose `col` is in `ids` (chunked so the URL stays short). */
async function readIn<T>(db: FeedClient, table: string, columns: string, key: string, col: string, ids: Iterable<string>, extra: Build = (q) => q): Promise<T[]> {
  const list = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < list.length; i += ID_CHUNK) {
    const chunk = list.slice(i, i + ID_CHUNK);
    out.push(...(await readAll<T>(db, table, columns, key, (q) => extra(q.in(col, chunk)))));
  }
  return out;
}

function mergeBy<T>(key: (r: T) => string, ...lists: T[][]): T[] {
  const m = new Map<string, T>();
  for (const l of lists) for (const r of l) m.set(key(r), r);
  return [...m.values()];
}

export const COVER_KEYS = ['order_ids', 'voided_order_ids', 'payment_ids', 'payment_void_ids', 'refund_ids', 'shift_ids'] as const;
export type CoverKey = typeof COVER_KEYS[number];

/** covered[key] as a string list ([] when absent / malformed — the Z is then simply not a dating source for it). */
export function coveredIds(z: { covered: unknown }, key: CoverKey): string[] {
  const c = z.covered as Record<string, unknown> | null;
  const v = c && typeof c === 'object' ? c[key] : null;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export async function loadReportRows(
  db: FeedClient, restaurantId: string, range: ReportRange, timeZone: string, opts: { kitchenHub: boolean },
): Promise<ReportRows> {
  const rid = (q: any) => q.eq('restaurant_id', restaurantId);
  const S = historyRange(range.from, timeZone).start;
  const E = historyRange(range.to, timeZone).end;

  const [devices, staff, zs] = await Promise.all([
    readAll<DeviceRow>(db, 'pos_devices', 'id,prefix,label,status', 'id', rid),
    readAll<StaffRow>(db, 'pos_staff', 'id,name', 'id', rid),
    readAll<DayCloseRow>(db, 'pos_day_closes', Z_COLUMNS, 'day_close_id',
      (q) => rid(q).gte('business_date', addDays(range.from, -Z_WINDOW_DAYS)).lte('business_date', addDays(range.to, Z_WINDOW_DAYS))),
  ]);
  const cov = (k: CoverKey) => zs.flatMap((z) => coveredIds(z, k));

  const [ordersByDay, openOrders, coveredOrders, paymentsTaken, paymentsVoided, coveredPayments, refundsByDay, coveredRefunds, shiftsByDay, coveredShifts] =
    await Promise.all([
      readAll<PosOrderRow>(db, 'pos_orders', ORDER_COLUMNS, 'order_id', (q) => rid(q).gte('sales_day', range.from).lte('sales_day', range.to)),
      readAll<PosOrderRow>(db, 'pos_orders', ORDER_COLUMNS, 'order_id', (q) => rid(q).eq('status', 'open')),
      readIn<PosOrderRow>(db, 'pos_orders', ORDER_COLUMNS, 'order_id', 'order_id', [...cov('order_ids'), ...cov('voided_order_ids')], rid),
      readAll<PaymentRow>(db, 'pos_payments', PAYMENT_COLUMNS, 'id', (q) => rid(q).gte('inserted_at', S).lt('inserted_at', E)),
      readAll<PaymentRow>(db, 'pos_payments', PAYMENT_COLUMNS, 'id', (q) => rid(q).gte('voided_at', S).lt('voided_at', E)),
      readIn<PaymentRow>(db, 'pos_payments', PAYMENT_COLUMNS, 'id', 'id', [...cov('payment_ids'), ...cov('payment_void_ids')], rid),
      readAll<RefundRow>(db, 'pos_refunds', REFUND_COLUMNS, 'refund_id', (q) => rid(q).gte('business_date', range.from).lte('business_date', range.to)),
      readIn<RefundRow>(db, 'pos_refunds', REFUND_COLUMNS, 'refund_id', 'refund_id', cov('refund_ids'), rid),
      readAll<ShiftRow>(db, 'pos_shifts', SHIFT_COLUMNS, 'shift_id', (q) => rid(q).gte('business_date', range.from).lte('business_date', range.to)),
      readIn<ShiftRow>(db, 'pos_shifts', SHIFT_COLUMNS, 'shift_id', 'shift_id', cov('shift_ids'), rid),
    ]);

  let orders = mergeBy((o: PosOrderRow) => o.order_id, ordersByDay, openOrders, coveredOrders);
  const refunds = mergeBy((r: RefundRow) => r.refund_id, refundsByDay, coveredRefunds);
  const shifts = mergeBy((s: ShiftRow) => s.shift_id, shiftsByDay, coveredShifts);

  // payments on the orders read (methods / deposits applied / scheduled paid)
  const onOrders = await readIn<PaymentRow>(db, 'pos_payments', PAYMENT_COLUMNS, 'id', 'order_id', orders.map((o) => o.order_id), rid);
  const payments = mergeBy((p: PaymentRow) => p.id, paymentsTaken, paymentsVoided, coveredPayments, onOrders);

  // the orders of payments / refunds not read yet (writer register, status, ticket)
  const have = new Set(orders.map((o) => o.order_id));
  const missing = [...payments.map((p) => p.order_id), ...refunds.map((r) => r.order_id)].filter((id) => !have.has(id));
  if (missing.length) orders = mergeBy((o: PosOrderRow) => o.order_id, orders, await readIn<PosOrderRow>(db, 'pos_orders', ORDER_COLUMNS, 'order_id', 'order_id', missing, rid));

  const [lines, movements] = await Promise.all([
    readIn<{ id: string; order_id: string; base_price_cents: number; quantity: number }>(
      db, 'pos_order_lines', 'id,order_id,base_price_cents,quantity', 'id', 'order_id', orders.map((o) => o.order_id), (q) => q.eq('status', 'voided')),
    readIn<MovementRow>(db, 'pos_cash_movements', MOVEMENT_COLUMNS, 'id', 'shift_id', shifts.map((s) => s.shift_id)),
  ]);
  const mods = await readIn<{ line_id: string; charge_cents: number }>(db, 'pos_order_line_modifiers', 'id,line_id,charge_cents', 'id', 'line_id', lines.map((l) => l.id));
  const byLine = new Map<string, number[]>();
  for (const m of mods) byLine.set(m.line_id, [...(byLine.get(m.line_id) ?? []), Number(m.charge_cents)]);
  const voidedLines = lines.map((l) => ({ ...l, modifier_charges_cents: byLine.get(l.id) ?? [] }));

  // online: the feed's select + history membership (scheduled_for ?? created_at in [S, E))
  const hist = historyOrFilter({ business_date: range.from, start: S, end: E });
  const [ordr, kh] = await Promise.all([
    readAll<FeedRow>(db, 'orders', FEED_SELECT, 'id', (q) => rid(q).or(hist)),
    opts.kitchenHub ? readAll<FeedRow>(db, 'external_orders', KH_FEED_SELECT, 'id', (q) => rid(q).or(hist)) : Promise.resolve([] as FeedRow[]),
  ]);

  return { devices, staff, zs, orders, payments, voidedLines, refunds, shifts, movements, online: { orders: normalizeFeedRows(ordr), kitchenhub: kh } };
}
