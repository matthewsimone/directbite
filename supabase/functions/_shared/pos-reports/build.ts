/**
 * Owner Reports v1 — the report from the rows (pure). Every POS money sum is the VENDORED buildDayReport
 * (ordr-core-ext/eod.ts @ 6f38487) — the same code that printed each register's Z.
 *
 * Rules (Matt, Owner Reports v1 build; ordr-pos SYNC-31):
 *   amounts      the register's PROVISIONAL pricing (pos_orders.provisional_pricing — what the Z used), never the
 *                server's repricing
 *   dating       a row a Z covers is dated by that Z (covered.order_ids / voided_order_ids / payment_ids /
 *                payment_void_ids / refund_ids / shift_ids); an uncovered row: an order by sales_day, a payment by the
 *                business day of its server receive time (inserted_at; a void by voided_at), a refund / shift by its
 *                business_date
 *   closed day   per register: money = Σ its Z sequences (as the register sent them); scheduled = the LATEST Z's;
 *                deposits = a whole-day recompute (labelled deposits_source 'recomputed'); and the day is recomputed
 *                from the rows → z_matches ✓ / ⚠ (+ which fields differ)
 *   live day     recompute only (today, no Z yet)
 *   repins       null (shown "—": the server has no repin events); unsynced 0 (the server only has synced rows)
 *
 * Online: the POS's onlineDaySummary (ports.ts) over the feed's own wire mapping (pos-online/wire.ts servedOrders),
 * dated scheduled_for ?? created_at on the business day (feedQuery.ts historyOrFilter). Money is the wire's integer
 * cents (toCents — decimal-exact, never float × 100). Output is cents only, snake_case keys, no customer data.
 */
// deno-lint-ignore-file no-explicit-any
import { buildDayReport, type DayReport, type DayReportInput, type Method, type ReportOrder } from '../ordr-core-ext/eod.ts';
import { cents, subtractCents, sumCents, type Cents } from '../ordr-core/money.ts';
import { businessDate } from '../pos-eod/rules.ts';
import { EMPTY_KH_CONTEXT } from '../pos-online/khItems.ts';
import { servedOrders, type OnlineOrderWire } from '../pos-online/wire.ts';
import { camelKeys, deliveryNeedsReview, onlineDaySummary, snakeKeys, type OnlineDaySummary } from './ports.ts';
import type { ReportRange } from './range.ts';
import {
  COVER_KEYS, coveredIds, type CoverKey, type DayCloseRow, type MovementRow, type PaymentRow, type PosOrderRow, type RefundRow,
  type ReportRows, type ShiftRow, type VoidedLineRow,
} from './store.ts';

// ---- the server's DayReport -------------------------------------------------------------------------------------

/** DayReport with repins = null (the server can't know them) and unsynced = 0. */
export type ServerDayReport = Omit<DayReport, 'overrides'> & { overrides: Omit<DayReport['overrides'], 'repins'> & { repins: null } };

export function finalize(r: DayReport | ServerDayReport): ServerDayReport {
  return { ...r, overrides: { ...r.overrides, repins: null }, review: { ...r.review, unsynced: 0 } };
}

const EMPTY_INPUT: DayReportInput = {
  closedOrders: [], voidedOrders: [], payments: [], paymentVoids: [], refunds: [], shifts: [], scheduled: [],
  depositsOnScheduled: [], paidNotClosed: [], depositsApplied: [],
};
export const emptyReport = (): ServerDayReport => finalize(buildDayReport(EMPTY_INPUT));

type CA = { count: number; amount: Cents };
const sumCA = (xs: readonly CA[]): CA => ({ count: xs.reduce((n, x) => n + x.count, 0), amount: sumCents(xs.map((x) => x.amount)) });
const sumC = (xs: readonly Cents[]): Cents => sumCents(xs);
const METHODS: readonly Method[] = ['cash', 'external_card'];

/**
 * Σ of reports (registers of a day, or days of a range). Money / counts add; lists concatenate; byTypeChannel merges
 * and sorts like eod.ts :152-154. scheduled: 'concat' (registers of one day) or 'last' (Z sequences: the latest Z;
 * days of a range: the last day's).
 */
export function combine(rs: readonly ServerDayReport[], scheduled: 'concat' | 'last'): ServerDayReport {
  if (!rs.length) return emptyReport();
  const groups = new Map<string, { orderType: string; channel: string; orders: number; totals: Cents[] }>();
  for (const r of rs) {
    for (const g of r.byTypeChannel) {
      const k = `${g.orderType}|${g.channel}`;
      const e = groups.get(k) ?? { orderType: g.orderType, channel: g.channel, orders: 0, totals: [] };
      e.orders += g.orders;
      e.totals.push(g.total);
      groups.set(k, e);
    }
  }
  const tender = Object.fromEntries(METHODS.map((m) => {
    const ls = rs.map((r) => r.tender[m]);
    return [m, { payments: sumCA(ls.map((l) => l.payments)), voids: sumCA(ls.map((l) => l.voids)), refunds: sumCA(ls.map((l) => l.refunds)), net: sumC(ls.map((l) => l.net)) }];
  })) as DayReport['tender'];
  const s = (f: (r: ServerDayReport) => Cents) => sumC(rs.map(f));
  return {
    sales: {
      orders: rs.reduce((n, r) => n + r.sales.orders, 0),
      subtotal: s((r) => r.sales.subtotal), promo: s((r) => r.sales.promo), netSubtotal: s((r) => r.sales.netSubtotal),
      deliveryFees: s((r) => r.sales.deliveryFees), serviceFees: s((r) => r.sales.serviceFees), tax: s((r) => r.sales.tax),
      tips: s((r) => r.sales.tips), total: s((r) => r.sales.total),
    },
    netSalesAfterRefunds: s((r) => r.netSalesAfterRefunds),
    byTypeChannel: [...groups.values()]
      .map((g) => ({ orderType: g.orderType, channel: g.channel, orders: g.orders, total: sumC(g.totals) }))
      .sort((a, b) => (a.orderType + a.channel).localeCompare(b.orderType + b.channel)),
    tender,
    cardBatchNet: s((r) => r.cardBatchNet),
    tips: {
      total: s((r) => r.tips.total), cardOnly: s((r) => r.tips.cardOnly), cashOnly: s((r) => r.tips.cashOnly),
      mixed: s((r) => r.tips.mixed), unpaid: s((r) => r.tips.unpaid),
    },
    voids: { orders: sumCA(rs.map((r) => r.voids.orders)), lines: sumCA(rs.map((r) => r.voids.lines)) },
    refunds: { ...sumCA(rs.map((r) => r.refunds)), items: rs.flatMap((r) => r.refunds.items) },
    overrides: {
      radius: rs.reduce((n, r) => n + r.overrides.radius, 0), minimum: rs.reduce((n, r) => n + r.overrides.minimum, 0),
      repins: null, reasons: rs.flatMap((r) => r.overrides.reasons),
    },
    cash: {
      shifts: rs.flatMap((r) => r.cash.shifts),
      paidIns: sumCA(rs.map((r) => r.cash.paidIns)), paidOuts: sumCA(rs.map((r) => r.cash.paidOuts)),
      overShort: s((r) => r.cash.overShort),
    },
    review: {
      unsynced: 0, mismatch: rs.reduce((n, r) => n + r.review.mismatch, 0),
      deliveryUnverified: rs.reduce((n, r) => n + r.review.deliveryUnverified, 0), deliveryReview: rs.reduce((n, r) => n + r.review.deliveryReview, 0),
    },
    scheduled: scheduled === 'last' ? rs[rs.length - 1].scheduled : rs.flatMap((r) => r.scheduled),
    deposits: {
      paidNotClosed: sumCA(rs.map((r) => r.deposits.paidNotClosed)), onScheduled: sumCA(rs.map((r) => r.deposits.onScheduled)),
      applied: sumCA(rs.map((r) => r.deposits.applied)),
    },
  };
}

/** The money a Z and the recompute must agree on (z_matches). Not compared: overrides (the register's events), review
 * (register-local flags), scheduled (a snapshot at Z time), deposits (recomputed by rule), refund / shift details. */
export function moneyView(r: ServerDayReport): unknown {
  return {
    sales: r.sales, netSalesAfterRefunds: r.netSalesAfterRefunds, byTypeChannel: r.byTypeChannel, tender: r.tender,
    cardBatchNet: r.cardBatchNet, tips: r.tips, voids: r.voids, refunds: { count: r.refunds.count, amount: r.refunds.amount },
    cash: { paidIns: r.cash.paidIns, paidOuts: r.cash.paidOuts, overShort: r.cash.overShort, shifts: r.cash.shifts.length },
  };
}

/** Dotted paths where a and b differ (leaves; arrays by index + length). */
export function diffPaths(a: unknown, b: unknown, at = ''): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length !== b.length ? [`${at}.length`] : [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diffPaths(a[i], b[i], `${at}[${i}]`));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k));
  }
  return Object.is(a, b) ? [] : [at || '(root)'];
}

/** Every leaf number a safe integer, the DayReport keys present — else the stored Z is unreadable (null). */
export function parseZReport(raw: unknown): ServerDayReport | null {
  const intsOnly = (v: unknown): boolean =>
    typeof v === 'number' ? Number.isSafeInteger(v) : Array.isArray(v) ? v.every(intsOnly) : v && typeof v === 'object' ? Object.values(v).every(intsOnly) : true;
  if (!raw || typeof raw !== 'object' || !intsOnly(raw)) return null;
  const r = camelKeys(raw) as Record<string, any>;
  const isCA = (x: any) => x && typeof x.count === 'number' && typeof x.amount === 'number';
  const ok = r.sales && typeof r.sales.total === 'number' && typeof r.netSalesAfterRefunds === 'number' && Array.isArray(r.byTypeChannel) &&
    METHODS.every((m) => r.tender?.[m] && isCA(r.tender[m].payments) && isCA(r.tender[m].voids) && isCA(r.tender[m].refunds) && typeof r.tender[m].net === 'number') &&
    typeof r.cardBatchNet === 'number' && r.tips && isCA(r.voids?.orders) && isCA(r.voids?.lines) && isCA(r.refunds) && Array.isArray(r.refunds.items) &&
    r.overrides && Array.isArray(r.overrides.reasons) && r.cash && Array.isArray(r.cash.shifts) && isCA(r.cash.paidIns) && isCA(r.cash.paidOuts) &&
    r.review && Array.isArray(r.scheduled) && r.deposits && isCA(r.deposits.paidNotClosed) && isCA(r.deposits.onScheduled) && isCA(r.deposits.applied);
  return ok ? finalize(r as unknown as DayReport) : null;
}

// ---- dating ---------------------------------------------------------------------------------------------------

export interface Dating {
  order(o: PosOrderRow): string | null;
  payment(p: PaymentRow): string;
  paymentVoid(p: PaymentRow): string | null;
  refund(r: RefundRow): string;
  shift(s: ShiftRow): string | null;
}

/** Rule 3. The first Z (by business date, then sequence) that covers a row dates it. */
export function makeDating(zs: readonly DayCloseRow[], timeZone: string, cutoff: string, bdOf?: (iso: string) => string): Dating {
  const by = new Map<CoverKey, Map<string, string>>(COVER_KEYS.map((k) => [k, new Map<string, string>()]));
  const sorted = [...zs].sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : a.sequence - b.sequence));
  for (const z of sorted) {
    for (const k of COVER_KEYS) {
      const m = by.get(k)!;
      for (const id of coveredIds(z, k)) if (!m.has(id)) m.set(id, z.business_date);
    }
  }
  const z = (k: CoverKey, id: string) => by.get(k)!.get(id);
  const bd = bdOf ?? ((iso: string) => businessDate(Date.parse(iso), timeZone, cutoff));
  return {
    order: (o) => (o.status === 'closed' ? z('order_ids', o.order_id) ?? o.sales_day : o.status === 'voided' ? z('voided_order_ids', o.order_id) ?? o.sales_day : null),
    payment: (p) => z('payment_ids', p.id) ?? bd(p.inserted_at),
    paymentVoid: (p) => (p.status === 'voided' ? z('payment_void_ids', p.id) ?? (p.voided_at ? bd(p.voided_at) : null) : null),
    refund: (r) => z('refund_ids', r.refund_id) ?? r.business_date,
    shift: (s) => (s.status === 'closed' ? z('shift_ids', s.shift_id) ?? s.business_date : null),
  };
}

// ---- one register, one day: recompute -------------------------------------------------------------------------

const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const ticketOf = (o: Pick<PosOrderRow, 'ticket_prefix' | 'ticket_counter'>) => `${o.ticket_prefix}-${String(o.ticket_counter).padStart(3, '0')}`;
const asObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

export interface Ctx { timeZone: string; cutoff: string }

const key = (device: string, day: string) => `${device}|${day}`;
function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/**
 * Rows indexed ONCE: every row dated (rule 3) and bucketed by register + business day, so a 93-day range costs one
 * pass over the rows (each timestamp converted once), not one per register × day.
 */
export class Indexed {
  readonly orders = new Map<string, PosOrderRow>();
  readonly paymentsByOrder = new Map<string, PaymentRow[]>();
  readonly linesByOrder = new Map<string, VoidedLineRow[]>();
  readonly movementsByShift = new Map<string, MovementRow[]>();
  readonly dating: Dating;
  readonly bd: (iso: string) => string;
  private readonly finalizedBy = new Map<string, PosOrderRow[]>();
  private readonly createdBy = new Map<string, PaymentRow[]>();
  private readonly voidsBy = new Map<string, PaymentRow[]>();
  private readonly refundsBy = new Map<string, RefundRow[]>();
  private readonly shiftsBy = new Map<string, ShiftRow[]>();
  private readonly openBy = new Map<string, PosOrderRow[]>();
  private readonly readyDayOf = new Map<string, string>();
  private readonly activeKeys = new Set<string>();

  constructor(readonly rows: ReportRows, readonly ctx: Ctx) {
    const cache = new Map<string, string>();
    this.bd = (iso) => {
      let v = cache.get(iso);
      if (v === undefined) cache.set(iso, (v = businessDate(Date.parse(iso), ctx.timeZone, ctx.cutoff)));
      return v;
    };
    this.dating = makeDating(rows.zs, ctx.timeZone, ctx.cutoff, this.bd);
    for (const o of rows.orders) this.orders.set(o.order_id, o);
    for (const p of rows.payments) push(this.paymentsByOrder, p.order_id, p);
    for (const l of rows.voidedLines) push(this.linesByOrder, l.order_id, l);
    for (const m of rows.movements) push(this.movementsByShift, m.shift_id, m);

    for (const o of rows.orders) {
      const day = this.dating.order(o);
      if (day) this.mark(this.finalizedBy, o.writer_device_id, day, o);
      if (o.status === 'open') {
        push(this.openBy, o.writer_device_id, o);
        // ready day: the order's own business day unless it has a ready time (POS repo/eod.ts :390-392)
        this.readyDayOf.set(o.order_id, o.ready_at === null ? o.ticket_business_date : this.bd(o.ready_at));
        this.activeKeys.add(key(o.writer_device_id, o.ticket_business_date));
      }
    }
    for (const p of rows.payments) {
      const device = this.deviceOfPayment(p);
      if (device === null) continue; // its order was not read: no register to put it on
      this.mark(this.createdBy, device, this.dating.payment(p), p);
      const vd = this.dating.paymentVoid(p);
      if (vd) this.mark(this.voidsBy, device, vd, p);
    }
    for (const r of rows.refunds) this.mark(this.refundsBy, r.device_id, this.dating.refund(r), r);
    for (const s of rows.shifts) {
      const day = this.dating.shift(s);
      if (day) this.mark(this.shiftsBy, s.device_id, day, s);
      if (s.status === 'open') this.activeKeys.add(key(s.device_id, s.business_date));
    }
    for (const z of rows.zs) this.activeKeys.add(key(z.device_id, z.business_date));
  }

  private mark<T>(m: Map<string, T[]>, device: string, day: string, v: T): void {
    push(m, key(device, day), v);
    this.activeKeys.add(key(device, day));
  }

  deviceOfPayment(p: PaymentRow): string | null {
    return this.orders.get(p.order_id)?.writer_device_id ?? null;
  }

  readyDay(o: PosOrderRow): string {
    return this.readyDayOf.get(o.order_id) ?? (o.ready_at === null ? o.ticket_business_date : this.bd(o.ready_at));
  }

  reportOrder(o: PosOrderRow): ReportOrder {
    const pp = asObj(o.provisional_pricing);
    const flags = asObj(o.flags);
    const ov = asObj(o.delivery_overrides);
    const overrides = (['radius', 'minimum'] as const)
      .filter((k) => ov[k] && typeof ov[k] === 'object')
      .map((k) => ({ kind: k, reason: typeof ov[k].reason === 'string' ? ov[k].reason : '' }));
    return {
      id: o.order_id,
      ticket: ticketOf(o),
      orderType: o.order_type,
      channel: o.channel,
      subtotal: int(pp.subtotal_cents),
      promo: int(pp.promo_discount_cents),
      netSubtotal: int(pp.net_subtotal_cents),
      deliveryFee: int(pp.delivery_fee_cents),
      serviceFee: int(pp.service_fee_cents),
      tax: int(pp.tax_cents),
      tip: int(pp.tip_cents),
      total: int(pp.total_cents),
      methods: (this.paymentsByOrder.get(o.order_id) ?? []).filter((p) => p.status === 'captured').map((p) => p.method as Method),
      // POS voidedLineAmount (repo/pricing.ts :190-203): the frozen module's subtotal of that line alone =
      // (base + Σ modifier charges) × quantity (ordr-core order/price.ts :131-132)
      voidedLines: (this.linesByOrder.get(o.order_id) ?? []).map((l) => (int(l.base_price_cents) + l.modifier_charges_cents.reduce((s, c) => s + int(c), 0)) * int(l.quantity)),
      overrides,
      repins: 0,
      unsynced: false,
      mismatch: flags.mismatch === true,
      deliveryUnverified: o.delivery_unverified === true,
      deliveryReview: deliveryNeedsReview(asObj(flags.delivery)),
    };
  }

  /** POS repo/eod.ts dayWindow :424-495 for register `device`, day D — over the server's rows (no seq window: dated). */
  input(device: string, D: string): DayReportInput {
    const k = key(device, D);
    const finalized = this.finalizedBy.get(k) ?? [];
    const closed = finalized.filter((o) => o.status === 'closed');
    const voided = finalized.filter((o) => o.status === 'voided');
    const created = this.createdBy.get(k) ?? [];
    const voids = this.voidsBy.get(k) ?? [];
    const createdIds = new Set(created.map((p) => p.id));
    const open = this.openBy.get(device) ?? [];
    const openIds = new Set(open.map((o) => o.order_id));
    // F7 (:435-440): an open order is "scheduled" when its ready time falls on a later business day than D
    const scheduledLater = new Set(open.filter((o) => o.ready_at !== null && this.readyDay(o) > D).map((o) => o.order_id));
    const openPaid = created.filter((p) => p.status === 'captured' && openIds.has(p.order_id));
    // :441-443: captured payments on the orders sold today that were taken in an earlier window
    const depositsApplied = closed.flatMap((o) => (this.paymentsByOrder.get(o.order_id) ?? []).filter((p) => p.status === 'captured' && !createdIds.has(p.id)));
    const refunds = this.refundsBy.get(k) ?? [];
    const shifts = this.shiftsBy.get(k) ?? [];
    // carried (blockersAndCarried :399-415): open, dated ≤ D, ready on a later day
    const carried = open.filter((o) => o.ticket_business_date <= D && this.readyDay(o) > D);
    const money = (p: PaymentRow) => ({ id: p.id, method: p.method as Method, amount: int(p.amount_cents) });
    const ticketLong = (orderId: string) => {
      const o = this.orders.get(orderId);
      return o ? `${ticketOf(o)} of ${o.ticket_business_date}` : '?';
    };
    return {
      closedOrders: closed.map((o) => this.reportOrder(o)),
      voidedOrders: voided.map((o) => ({ id: o.order_id, ticket: ticketOf(o), total: int(asObj(o.provisional_pricing).total_cents) })),
      payments: created.map(money),
      paymentVoids: voids.map(money),
      refunds: refunds.map((r) => ({ id: r.refund_id, method: r.method as Method, amount: int(r.amount_cents), ticket: ticketLong(r.order_id), reason: r.reason })),
      shifts: shifts.map((s) => {
        const mv = this.movementsByShift.get(s.shift_id) ?? [];
        const pick = (kind: string) => mv.filter((m) => m.kind === kind).map((m) => ({ id: m.id, amount: int(m.amount_cents), reason: m.reason }));
        return { id: s.shift_id, starting: int(s.starting_cash_cents), expected: int(s.expected_cash_cents), counted: int(s.counted_cash_cents), overShort: int(s.over_short_cents), paidIns: pick('paid_in'), paidOuts: pick('paid_out') };
      }),
      scheduled: carried.map((o) => ({
        id: o.order_id, ticket: ticketOf(o), readyDay: this.readyDay(o), total: int(asObj(o.provisional_pricing).total_cents),
        // tenderState(...).paid (core/tender.ts :28-30): the captured payments
        paid: (this.paymentsByOrder.get(o.order_id) ?? []).filter((p) => p.status === 'captured').reduce((s, p) => s + int(p.amount_cents), 0),
      })),
      depositsOnScheduled: openPaid.filter((p) => scheduledLater.has(p.order_id)).map(money),
      paidNotClosed: openPaid.filter((p) => !scheduledLater.has(p.order_id)).map(money),
      depositsApplied: depositsApplied.map(money),
    };
  }

  /** Did register `device` touch day D (any dated row, an open order / open shift of D, or a Z of D)? */
  active(device: string, D: string): boolean {
    return this.activeKeys.has(key(device, D));
  }
}

// ---- register-day / day / range -------------------------------------------------------------------------------

export type RegisterDayState = 'closed' | 'live' | 'unclosed';

export interface RegisterDay {
  deviceId: string;
  state: RegisterDayState;
  /** What the owner sees: closed → Σ Z money + the latest Z's scheduled + recomputed deposits; else the recompute. */
  report: ServerDayReport;
  /** The day recomputed from the rows (always). */
  recomputed: ServerDayReport;
  z: { sequences: number[]; zNumbers: number[]; sum: ServerDayReport | null; unreadable: boolean } | null;
  zMatches: boolean | null;
  zDiff: string[];
  depositsSource: 'recomputed';
}

export function registerDay(ix: Indexed, device: string, D: string, today: string): RegisterDay {
  const recomputed = finalize(buildDayReport(ix.input(device, D)));
  const zs = ix.rows.zs.filter((z) => z.device_id === device && z.business_date === D).sort((a, b) => a.sequence - b.sequence);
  if (!zs.length) {
    return { deviceId: device, state: D === today ? 'live' : 'unclosed', report: recomputed, recomputed, z: null, zMatches: null, zDiff: [], depositsSource: 'recomputed' };
  }
  const parsed = zs.map((z) => parseZReport(z.report));
  const unreadable = parsed.some((p) => p === null);
  const sum = unreadable ? null : combine(parsed as ServerDayReport[], 'last'); // 'last' = the LATEST Z's scheduled (rule 4)
  const meta = { sequences: zs.map((z) => z.sequence), zNumbers: zs.map((z) => z.z_number), sum, unreadable };
  if (!sum) return { deviceId: device, state: 'closed', report: recomputed, recomputed, z: meta, zMatches: null, zDiff: [], depositsSource: 'recomputed' };
  const zDiff = diffPaths(moneyView(sum), moneyView(recomputed));
  return {
    deviceId: device, state: 'closed', report: { ...sum, deposits: recomputed.deposits }, recomputed, z: meta,
    zMatches: zDiff.length === 0, zDiff, depositsSource: 'recomputed',
  };
}

// ---- online -------------------------------------------------------------------------------------------------

export interface OnlineExtra {
  /** Refunds on online orders that are NOT cancelled (the part of online refunds that comes out of online sales). */
  refundsOnSales: CA;
}

export interface OnlineDay { summary: OnlineDaySummary; extra: OnlineExtra }

/** The feed's wires for the rows, each dated scheduled_for ?? created_at on the business day (historyOrFilter). */
export function onlineWires(rows: ReportRows, ctx: Ctx): { businessDate: string; wire: OnlineOrderWire }[] {
  const dayOf = new Map<string, string>();
  for (const r of [...rows.online.orders, ...rows.online.kitchenhub]) {
    const at = Date.parse(String(r.scheduled_for ?? r.created_at));
    if (Number.isFinite(at)) dayOf.set(String(r.id), businessDate(at, ctx.timeZone, ctx.cutoff));
  }
  const wires = servedOrders(rows.online, { claims: [], stations: [], log: [] }, EMPTY_KH_CONTEXT);
  return wires.flatMap((w) => (dayOf.has(w.id) ? [{ businessDate: dayOf.get(w.id)!, wire: w }] : []));
}

export function onlineDay(D: string, wires: readonly { businessDate: string; wire: OnlineOrderWire }[]): OnlineDay {
  const summary = onlineDaySummary(D, wires.map((x) => ({ businessDate: x.businessDate, wire: x.wire, readable: true })));
  const onSales = wires.filter((x) => x.businessDate === D && x.wire.channel === 'ordr' && x.wire.status !== 'cancelled' &&
    (x.wire.refund.status === 'completed' || x.wire.refund.status === 'partial'));
  return {
    summary,
    extra: { refundsOnSales: { count: onSales.length, amount: sumCents(onSales.map((x) => cents(x.wire.refund.amount_cents ?? 0))) } },
  };
}

export function combineOnline(label: string, ds: readonly OnlineDay[]): OnlineDay {
  const o = ds.map((d) => d.summary.ordr);
  const k = ds.map((d) => d.summary.kitchenhub);
  const providers = new Map<string, number>();
  for (const x of k) for (const m of x.byMarketplace) providers.set(m.provider, (providers.get(m.provider) ?? 0) + m.orders);
  return {
    summary: {
      businessDate: label,
      ordr: {
        orders: o.reduce((n, x) => n + x.orders, 0), total: sumC(o.map((x) => x.total)), tips: sumC(o.map((x) => x.tips)),
        cancelled: sumCA(o.map((x) => x.cancelled)), refunded: sumCA(o.map((x) => x.refunded)), chargesApproved: sumCA(o.map((x) => x.chargesApproved)),
        adjustmentsPending: o.reduce((n, x) => n + x.adjustmentsPending, 0),
      },
      kitchenhub: {
        orders: k.reduce((n, x) => n + x.orders, 0),
        byMarketplace: [...providers].map(([provider, orders]) => ({ provider, orders })).sort((a, b) => a.provider.localeCompare(b.provider)),
        knownTotal: sumC(k.map((x) => x.knownTotal)), unknownTotals: k.reduce((n, x) => n + x.unknownTotals, 0),
        collect: {
          count: k.reduce((n, x) => n + x.collect.count, 0), amount: sumC(k.map((x) => x.collect.amount)), unknown: k.reduce((n, x) => n + x.collect.unknown, 0),
        },
        cancelled: k.reduce((n, x) => n + x.cancelled, 0),
      },
    },
    extra: { refundsOnSales: sumCA(ds.map((d) => d.extra.refundsOnSales)) },
  };
}

// ---- combined (POS + online) --------------------------------------------------------------------------------

export interface Combined {
  /** POS sales total + Ordr (not cancelled) + approved extra charges + KitchenHub known totals. */
  salesTotal: Cents;
  /** POS net after refunds + Ordr (not cancelled) + extra charges − refunds on orders not cancelled + KitchenHub known. */
  netAfterRefunds: Cents;
  payments: {
    cash: Cents;
    cardRegister: Cents;
    /** Ordr: every order charged (cancelled too) + extra charges; refunds = every Ordr refund as recorded. */
    cardOnline: { payments: Cents; refunds: Cents; net: Cents };
    marketplace: { known: Cents; unknown: number };
    collectOnPickup: { count: number; amount: Cents; unknown: number };
  };
  refunds: { pos: CA; online: CA };
  /** card online net − online net sales = cancelled totals − their refunds: normally 0 (≠ 0: cancelled, not fully refunded). */
  onlineCancelledNotRefunded: Cents;
}

export function combined(pos: ServerDayReport, online: OnlineDay): Combined {
  const o = online.summary.ordr;
  const k = online.summary.kitchenhub;
  const onlineSales = sumC([o.total, o.chargesApproved.amount]);
  const cardOnlinePayments = sumC([o.total, o.cancelled.amount, o.chargesApproved.amount]);
  const refundsOnCancelled = subtractCents(o.refunded.amount, online.extra.refundsOnSales.amount);
  return {
    salesTotal: sumC([pos.sales.total, onlineSales, k.knownTotal]),
    netAfterRefunds: sumC([pos.netSalesAfterRefunds, subtractCents(onlineSales, online.extra.refundsOnSales.amount), k.knownTotal]),
    payments: {
      cash: pos.tender.cash.net,
      cardRegister: pos.cardBatchNet,
      cardOnline: { payments: cardOnlinePayments, refunds: o.refunded.amount, net: subtractCents(cardOnlinePayments, o.refunded.amount) },
      marketplace: { known: k.knownTotal, unknown: k.unknownTotals },
      collectOnPickup: k.collect,
    },
    refunds: { pos: { count: pos.refunds.count, amount: pos.refunds.amount }, online: o.refunded },
    onlineCancelledNotRefunded: subtractCents(o.cancelled.amount, refundsOnCancelled),
  };
}

// ---- the whole report -----------------------------------------------------------------------------------------

export type DayState = 'closed' | 'live' | 'unclosed' | 'partial' | 'none';

const nameOf = (staff: Map<string, string>) => (id: string | null) =>
  id === null ? null : id === 'register' ? 'Register' : staff.get(id) ?? null;

export function buildReport(rows: ReportRows, range: ReportRange, ctx: Ctx & { nowMs: number }): Record<string, unknown> {
  const ix = new Indexed(rows, ctx);
  const staff = new Map(rows.staff.map((s) => [s.id, s.name]));
  const name = nameOf(staff);
  const prefix = new Map(rows.devices.map((d) => [d.id, d.prefix]));
  const wires = onlineWires(rows, ctx);

  const days = range.days.map((D) => {
    const regs = rows.devices.filter((d) => ix.active(d.id, D)).map((d) => registerDay(ix, d.id, D, range.today));
    const pos = combine(regs.map((r) => r.report), 'concat');
    const online = onlineDay(D, wires);
    const state: DayState = !regs.length ? (D === range.today ? 'live' : 'none')
      : D === range.today && regs.some((r) => r.state === 'live') ? 'live'
      : regs.every((r) => r.state === 'closed') ? 'closed'
      : regs.every((r) => r.state !== 'closed') ? 'unclosed' : 'partial';
    return { D, state, regs, pos, online };
  });

  const totalPos = combine(days.map((d) => d.pos), 'last');
  const totalOnline = combineOnline(`${range.from}..${range.to}`, days.map((d) => d.online));
  const inRange = (d: string | null) => d !== null && d >= range.from && d <= range.to;

  const lastSync = new Map<string, string>();
  for (const o of rows.orders) if (!lastSync.has(o.writer_device_id) || o.updated_at > lastSync.get(o.writer_device_id)!) lastSync.set(o.writer_device_id, o.updated_at);

  const out = {
    range: { from: range.from, to: range.to, today: range.today, preset: range.preset, timeZone: ctx.timeZone, cutoff: ctx.cutoff, serverTime: new Date(ctx.nowMs).toISOString() },
    registers: rows.devices.map((d) => ({
      deviceId: d.id, prefix: d.prefix, label: d.label, status: d.status, lastOrderSyncAt: lastSync.get(d.id) ?? null,
      openShiftToday: rows.shifts.some((s) => s.device_id === d.id && s.status === 'open' && s.business_date === range.today),
      zToday: rows.zs.some((z) => z.device_id === d.id && z.business_date === range.today),
    })),
    days: days.map((d) => ({
      date: d.D,
      state: d.state,
      pos: d.pos,
      registers: d.regs.map((r) => ({
        deviceId: r.deviceId, prefix: prefix.get(r.deviceId) ?? null, state: r.state, report: r.report, recomputed: r.recomputed,
        z: r.z ? { sequences: r.z.sequences, zNumbers: r.z.zNumbers, unreadable: r.z.unreadable } : null,
        zMatches: r.zMatches, zDiff: r.zDiff.map((p) => p.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)), depositsSource: r.depositsSource,
      })),
      online: d.online.summary,
      onlineRefundsOnSales: d.online.extra.refundsOnSales,
      combined: combined(d.pos, d.online),
    })),
    total: { pos: totalPos, online: totalOnline.summary, onlineRefundsOnSales: totalOnline.extra.refundsOnSales, combined: combined(totalPos, totalOnline) },
    shifts: rows.shifts
      .map((s) => ({ s, day: ix.dating.shift(s) ?? (s.status === 'open' ? s.business_date : null) }))
      .filter((x) => inRange(x.day))
      .sort((a, b) => (a.s.opened_at < b.s.opened_at ? -1 : 1))
      .map(({ s, day }) => ({
        shiftId: s.shift_id, deviceId: s.device_id, prefix: prefix.get(s.device_id) ?? null, businessDate: day, status: s.status,
        openedAt: s.opened_at, openedBy: name(s.opened_by), closedAt: s.closed_at, closedBy: name(s.closed_by), closeApprovedBy: name(s.close_approved_by),
        startingCashCents: s.starting_cash_cents, expectedCashCents: s.expected_cash_cents, countedCashCents: s.counted_cash_cents, overShortCents: s.over_short_cents,
        drawerUnverified: asObj(s.flags).drawer_unverified === true, drawerMismatch: asObj(s.flags).drawer_mismatch === true,
        movements: (ix.movementsByShift.get(s.shift_id) ?? []).map((m) => ({
          kind: m.kind, amountCents: m.amount_cents, reason: m.reason, actor: name(m.actor), approvedBy: name(m.approved_by), createdAt: m.created_at,
        })),
      })),
    zHistory: rows.zs
      .filter((z) => inRange(z.business_date))
      .sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : (prefix.get(a.device_id) ?? '').localeCompare(prefix.get(b.device_id) ?? '') || a.sequence - b.sequence))
      .map((z) => {
        const r = parseZReport(z.report);
        return {
          dayCloseId: z.day_close_id, deviceId: z.device_id, prefix: prefix.get(z.device_id) ?? null, businessDate: z.business_date,
          zNumber: z.z_number, sequence: z.sequence, supplemental: z.supplemental, closedAt: z.closed_at, closedBy: name(z.closed_by),
          approvedBy: name(z.approved_by), receivedAt: z.received_at, unreadable: r === null,
          salesTotalCents: r ? r.sales.total : null, cashNetCents: r ? r.tender.cash.net : null, cardBatchNetCents: r ? r.cardBatchNet : null,
          refundsCents: r ? r.refunds.amount : null, overShortCents: r ? r.cash.overShort : null,
          flags: Object.keys(asObj(z.flags)).filter((k) => asObj(z.flags)[k] === true).sort(),
        };
      }),
  };
  return snakeKeys(out) as Record<string, unknown>;
}
