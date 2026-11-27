/**
 * Day report aggregation (END-OF-DAY §4) — X report (day so far) and Z /
 * supplemental Z. Takes plain rows the repo queried, returns cents. Every sum
 * here; the repo and UI do no money math. Pure, no RN / Expo imports (the
 * restaurant-wide server report will vendor it). A money home for the
 * invariant script.
 */
import { cents, subtractCents, sumCents, ZERO, type Cents } from './money.ts';

export type Method = 'cash' | 'external_card';

export interface ReportOrder {
  id: string;
  ticket: string;
  orderType: string;
  channel: string;
  subtotal: number;
  promo: number;
  netSubtotal: number;
  deliveryFee: number;
  serviceFee: number;
  tax: number;
  tip: number;
  total: number;
  /** Methods of the order's captured payments (tips attribution, E8). */
  methods: readonly Method[];
  /** Priced amounts of the order's voided lines (frozen module). */
  voidedLines: readonly number[];
  overrides: readonly { kind: string; reason: string }[];
  repins: number;
  unsynced: boolean;
  mismatch: boolean;
  deliveryUnverified: boolean;
  deliveryReview: boolean;
}

export interface ReportMoneyRow {
  id: string;
  method: Method;
  amount: number;
}

export interface ReportRefund extends ReportMoneyRow {
  ticket: string;
  reason: string;
}

export interface ReportShift {
  id: string;
  starting: number;
  expected: number;
  counted: number;
  overShort: number;
  paidIns: readonly { id: string; amount: number; reason: string }[];
  paidOuts: readonly { id: string; amount: number; reason: string }[];
}

export interface ReportScheduled {
  id: string;
  ticket: string;
  readyDay: string;
  total: number;
  paid: number;
}

export interface DayReportInput {
  closedOrders: readonly ReportOrder[];
  voidedOrders: readonly { id: string; ticket: string; total: number }[];
  /** Payments taken in the window (captured or later voided). */
  payments: readonly ReportMoneyRow[];
  /** Open-order payment voids in the window. */
  paymentVoids: readonly ReportMoneyRow[];
  refunds: readonly ReportRefund[];
  shifts: readonly ReportShift[];
  scheduled: readonly ReportScheduled[];
  /** Payments taken in this window on orders still open and scheduled for a LATER business day: in tender, not yet in sales. */
  depositsOnScheduled: readonly ReportMoneyRow[];
  /** PRINTING F7: payments taken in this window on orders still open but NOT scheduled later (paid, not closed yet). */
  paidNotClosed: readonly ReportMoneyRow[];
  /** Payments taken in an EARLIER window on orders sold in this one: in sales, already in an earlier tender. */
  depositsApplied: readonly ReportMoneyRow[];
}

interface CountAmount {
  count: number;
  amount: Cents;
}

export interface TenderLine {
  payments: CountAmount;
  voids: CountAmount;
  refunds: CountAmount;
  /** payments − voids − refunds */
  net: Cents;
}

export interface DayReport {
  sales: { orders: number; subtotal: Cents; promo: Cents; netSubtotal: Cents; deliveryFees: Cents; serviceFees: Cents; tax: Cents; tips: Cents; total: Cents };
  /** Sales total − refunds (E7). */
  netSalesAfterRefunds: Cents;
  byTypeChannel: { orderType: string; channel: string; orders: number; total: Cents }[];
  tender: Record<Method, TenderLine>;
  /** External card net — compare with the terminal's batch. */
  cardBatchNet: Cents;
  tips: { total: Cents; cardOnly: Cents; cashOnly: Cents; mixed: Cents; unpaid: Cents };
  voids: { orders: CountAmount; lines: CountAmount };
  refunds: CountAmount & { items: { id: string; ticket: string; method: Method; amount: Cents; reason: string }[] };
  overrides: { radius: number; minimum: number; repins: number; reasons: string[] };
  cash: {
    shifts: { id: string; starting: Cents; expected: Cents; counted: Cents; overShort: Cents; paidIns: Cents; paidOuts: Cents }[];
    paidIns: CountAmount;
    paidOuts: CountAmount;
    overShort: Cents;
  };
  review: { unsynced: number; mismatch: number; deliveryUnverified: number; deliveryReview: number };
  scheduled: { id: string; ticket: string; readyDay: string; total: Cents; paid: Cents }[];
  /** Reconcile tender with sales (Matt 2026-11-20 #3). */
  /** F7: open-order payments split into paid-not-closed (today) and deposits on orders scheduled for a later day. */
  deposits: { paidNotClosed: CountAmount; onScheduled: CountAmount; applied: CountAmount };
}

const sum = (xs: readonly number[]): Cents => sumCents(xs.map(cents));
const ca = (xs: readonly number[]): CountAmount => ({ count: xs.length, amount: sum(xs) });

function tenderLine(input: DayReportInput, m: Method): TenderLine {
  const payments = ca(input.payments.filter((p) => p.method === m).map((p) => p.amount));
  const voids = ca(input.paymentVoids.filter((p) => p.method === m).map((p) => p.amount));
  const refunds = ca(input.refunds.filter((p) => p.method === m).map((p) => p.amount));
  return { payments, voids, refunds, net: subtractCents(payments.amount, sumCents([voids.amount, refunds.amount])) };
}

export function buildDayReport(input: DayReportInput): DayReport {
  const o = input.closedOrders;
  const sales = {
    orders: o.length,
    subtotal: sum(o.map((x) => x.subtotal)),
    promo: sum(o.map((x) => x.promo)),
    netSubtotal: sum(o.map((x) => x.netSubtotal)),
    deliveryFees: sum(o.map((x) => x.deliveryFee)),
    serviceFees: sum(o.map((x) => x.serviceFee)),
    tax: sum(o.map((x) => x.tax)),
    tips: sum(o.map((x) => x.tip)),
    total: sum(o.map((x) => x.total)),
  };
  const groups = new Map<string, { orderType: string; channel: string; totals: number[] }>();
  for (const x of o) {
    const k = `${x.orderType}|${x.channel}`;
    const g = groups.get(k) ?? { orderType: x.orderType, channel: x.channel, totals: [] };
    g.totals.push(x.total);
    groups.set(k, g);
  }
  const byTypeChannel = [...groups.values()]
    .map((g) => ({ orderType: g.orderType, channel: g.channel, orders: g.totals.length, total: sum(g.totals) }))
    .sort((a, b) => (a.orderType + a.channel).localeCompare(b.orderType + b.channel));
  const tender = { cash: tenderLine(input, 'cash'), external_card: tenderLine(input, 'external_card') };
  const bucket = (pred: (ms: readonly Method[]) => boolean) => sum(o.filter((x) => pred(x.methods)).map((x) => x.tip));
  const tips = {
    total: sales.tips,
    cardOnly: bucket((ms) => ms.length > 0 && ms.every((m) => m === 'external_card')),
    cashOnly: bucket((ms) => ms.length > 0 && ms.every((m) => m === 'cash')),
    mixed: bucket((ms) => ms.includes('cash') && ms.includes('external_card')),
    unpaid: bucket((ms) => ms.length === 0),
  };
  const refunds = {
    ...ca(input.refunds.map((r) => r.amount)),
    items: input.refunds.map((r) => ({ id: r.id, ticket: r.ticket, method: r.method, amount: cents(r.amount), reason: r.reason })),
  };
  const overrides = o.flatMap((x) => x.overrides);
  const shifts = input.shifts.map((s) => ({
    id: s.id,
    starting: cents(s.starting),
    expected: cents(s.expected),
    counted: cents(s.counted),
    overShort: cents(s.overShort),
    paidIns: sum(s.paidIns.map((m) => m.amount)),
    paidOuts: sum(s.paidOuts.map((m) => m.amount)),
  }));
  return {
    sales,
    netSalesAfterRefunds: subtractCents(sales.total, refunds.amount),
    byTypeChannel,
    tender,
    cardBatchNet: tender.external_card.net,
    tips,
    voids: { orders: ca(input.voidedOrders.map((v) => v.total)), lines: ca(o.flatMap((x) => x.voidedLines)) },
    refunds,
    overrides: {
      radius: overrides.filter((x) => x.kind === 'radius').length,
      minimum: overrides.filter((x) => x.kind === 'minimum').length,
      repins: o.reduce((n, x) => n + x.repins, 0),
      reasons: overrides.map((x) => `${x.kind}: ${x.reason}`),
    },
    cash: {
      shifts,
      paidIns: ca(input.shifts.flatMap((s) => s.paidIns.map((m) => m.amount))),
      paidOuts: ca(input.shifts.flatMap((s) => s.paidOuts.map((m) => m.amount))),
      overShort: input.shifts.length ? sum(input.shifts.map((s) => s.overShort)) : ZERO,
    },
    review: {
      unsynced: o.filter((x) => x.unsynced).length,
      mismatch: o.filter((x) => x.mismatch).length,
      deliveryUnverified: o.filter((x) => x.deliveryUnverified).length,
      deliveryReview: o.filter((x) => x.deliveryReview).length,
    },
    scheduled: input.scheduled.map((x) => ({ id: x.id, ticket: x.ticket, readyDay: x.readyDay, total: cents(x.total), paid: cents(x.paid) })),
    deposits: {
      paidNotClosed: ca(input.paidNotClosed.map((p) => p.amount)),
      onScheduled: ca(input.depositsOnScheduled.map((p) => p.amount)),
      applied: ca(input.depositsApplied.map((p) => p.amount)),
    },
  };
}
