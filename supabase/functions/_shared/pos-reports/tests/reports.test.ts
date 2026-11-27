/**
 * Owner Reports v1 (pos-reports): golden (POS eod fixture rows → that fixture's DayReport), Z sum vs recompute,
 * covered-list dating, offline across the cutoff, online, combined, ranges, auth 401 / 403 / admin, no customer data.
 */
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { buildDayReport, type DayReportInput } from '../../ordr-core-ext/eod.ts';
import { buildReport, combine, finalize, Indexed, makeDating, onlineDay, onlineWires, parseZReport, registerDay, type ServerDayReport } from '../build.ts';
import { handleReports } from '../handler.ts';
import { camelKeys, snakeKeys } from '../ports.ts';
import { MAX_RANGE_DAYS, resolveRange } from '../range.ts';
import type { DayCloseRow, PaymentRow, PosOrderRow, RefundRow, ReportRows, ShiftRow } from '../store.ts';
import { FakeDb } from './fakeDb.ts';

const TZ = 'America/New_York';
const CTX = { timeZone: TZ, cutoff: '04:00' };
const RID = '00000000-0000-4000-8000-0000000000aa';
const F = '00000000-0000-4000-8000-0000000000f1';
const G = '00000000-0000-4000-8000-0000000000f2';
const D = '2026-11-19';
/** 2026-11-19 is EST (UTC−5): `et('2026-11-19', '12:00')` = 17:00Z. */
const et = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${day}T00:00:00Z`) + ((h + 5) * 60 + m) * 60_000).toISOString();
};

// ---- rows -----------------------------------------------------------------------------------------------------

const pp = (o: { subtotal?: number; promo?: number; net?: number; delivery?: number; service?: number; tax?: number; tip?: number; total: number }) => ({
  lines: [], subtotal_cents: o.subtotal ?? 0, discountable_subtotal_cents: o.subtotal ?? 0, promo_discount_cents: o.promo ?? 0,
  discounted_subtotal_cents: o.net ?? 0, loyalty_discount_face_cents: 0, loyalty_discount_applied_cents: 0, net_subtotal_cents: o.net ?? 0,
  delivery_fee_cents: o.delivery ?? 0, tip_cents: o.tip ?? 0, recoup_cents: 0, service_fee_cents: o.service ?? 0, taxable_cents: o.net ?? 0,
  tax_cents: o.tax ?? 0, total_cents: o.total, loyalty_earn: { basis_cents: 0, base_points: 0 }, rates: { promo_percent: null, recoup_rate: '0', tax_rate: '6.625' },
});

let counter = 0;
const order = (id: string, o: Partial<PosOrderRow> & { pricing: ReturnType<typeof pp> }): PosOrderRow => ({
  order_id: id, writer_device_id: F, order_type: 'pickup', channel: 'counter', status: 'closed', sales_day: D, ready_at: null,
  ticket_prefix: 'A', ticket_counter: ++counter, ticket_business_date: D, provisional_pricing: o.pricing, flags: {},
  delivery_overrides: null, delivery_unverified: null, updated_at: et(D, '12:00'), ...o,
});
const pay = (id: string, order_id: string, method: 'cash' | 'external_card', amount: number, o: Partial<PaymentRow> = {}): PaymentRow => ({
  id, order_id, method, amount_cents: amount, status: 'captured', inserted_at: et(D, '12:00'), voided_at: null, ...o,
});

function emptyRows(): ReportRows {
  return {
    devices: [{ id: F, prefix: 'F', label: 'Front', status: 'active' }, { id: G, prefix: 'G', label: 'Back', status: 'active' }],
    staff: [{ id: 's-mgr', name: 'Maria' }], zs: [], orders: [], payments: [], voidedLines: [], refunds: [], shifts: [], movements: [],
    online: { orders: [], kitchenhub: [] },
  };
}

/** ordr-pos test/db/endOfDay.test.ts :118-160 (@ 6f38487) — its DayReportInput, exactly. */
function posFixtureInput(): DayReportInput {
  const ord = (o: any) => ({
    id: 'o', ticket: 'A-001', orderType: 'pickup', channel: 'counter', subtotal: 1000, promo: 0, netSubtotal: 1000, deliveryFee: 0, serviceFee: 0, tax: 66, tip: 0, total: 1066,
    methods: ['cash'], voidedLines: [], overrides: [], repins: 0, unsynced: false, mismatch: false, deliveryUnverified: false, deliveryReview: false, ...o,
  });
  return {
    closedOrders: [
      ord({ id: 'a', total: 1066, tip: 0, methods: ['cash'] }),
      ord({ id: 'b', orderType: 'delivery', channel: 'phone', subtotal: 2000, netSubtotal: 2000, deliveryFee: 499, tax: 165, tip: 300, total: 2964, methods: ['external_card'], voidedLines: [350], overrides: [{ kind: 'minimum', reason: 'Regular' }] }),
      ord({ id: 'c', tip: 100, total: 1166, methods: ['cash', 'external_card'], repins: 1, unsynced: true }),
    ],
    voidedOrders: [{ id: 'v', ticket: 'A-009', total: 777 }],
    payments: [{ id: 'p1', method: 'cash', amount: 1066 }, { id: 'p2', method: 'external_card', amount: 2964 }, { id: 'p3', method: 'cash', amount: 600 }, { id: 'p4', method: 'external_card', amount: 566 }, { id: 'p5', method: 'cash', amount: 200 }],
    paymentVoids: [{ id: 'p5', method: 'cash', amount: 200 }],
    refunds: [{ id: 'r1', method: 'external_card', amount: 500, ticket: 'A-002', reason: 'Wrong item' }],
    shifts: [{ id: 's', starting: 15000, expected: 16466, counted: 16400, overShort: -66, paidIns: [], paidOuts: [{ id: 'm', amount: 2000, reason: 'Driver gas' }] }],
    scheduled: [{ id: 'x', ticket: 'A-010', readyDay: '2026-11-20', total: 5000, paid: 1000 }],
    depositsOnScheduled: [{ id: 'p6', method: 'cash', amount: 1000 }],
    paidNotClosed: [{ id: 'p7', method: 'external_card', amount: 250 }],
    depositsApplied: [{ id: 'p0', method: 'external_card', amount: 250 }, { id: 'p9', method: 'cash', amount: 100 }],
  } as DayReportInput;
}

/** The server rows that ARE that fixture on register F, business day 2026-11-19. */
function goldenRows(): ReportRows {
  counter = 0;
  const r = emptyRows();
  r.orders = [
    order('a', { ticket_counter: 1, pricing: pp({ subtotal: 1000, net: 1000, tax: 66, total: 1066 }) }),
    order('b', {
      ticket_counter: 2, order_type: 'delivery', channel: 'phone', pricing: pp({ subtotal: 2000, net: 2000, delivery: 499, tax: 165, tip: 300, total: 2964 }),
      delivery_overrides: { radius: null, minimum: { reason: 'Regular', actor: 's-mgr', approved_by: null } },
    }),
    order('c', { ticket_counter: 3, pricing: pp({ subtotal: 1000, net: 1000, tax: 66, tip: 100, total: 1166 }) }),
    order('v', { ticket_counter: 9, status: 'voided', pricing: pp({ total: 777 }) }),
    // open: x ready on the NEXT business day (12:00 ET 11-20) → scheduled + its deposit; y ready today → paid, not closed
    order('x', { ticket_counter: 10, status: 'open', sales_day: null, ready_at: et('2026-11-20', '12:00'), pricing: pp({ total: 5000 }) }),
    order('y', { ticket_counter: 11, status: 'open', sales_day: null, pricing: pp({ total: 900 }) }),
  ];
  r.payments = [
    pay('p1', 'a', 'cash', 1066),
    pay('p5', 'a', 'cash', 200, { status: 'voided', voided_at: et(D, '13:00') }),
    pay('p9', 'a', 'cash', 100, { inserted_at: et('2026-11-18', '12:00') }), // taken the day before → deposit applied
    pay('p2', 'b', 'external_card', 2964),
    pay('p0', 'b', 'external_card', 250, { inserted_at: et('2026-11-18', '12:00') }),
    pay('p3', 'c', 'cash', 600),
    pay('p4', 'c', 'external_card', 566),
    pay('p6', 'x', 'cash', 1000),
    pay('p7', 'y', 'external_card', 250),
  ];
  r.voidedLines = [{ id: 'l1', order_id: 'b', base_price_cents: 300, quantity: 1, modifier_charges_cents: [50] }];
  r.refunds = [{ refund_id: 'r1', device_id: F, order_id: 'b', payment_id: 'p2', method: 'external_card', amount_cents: 500, reason: 'Wrong item', actor: 's-mgr', approved_by: null, business_date: D, shift_id: 's', created_at: et(D, '14:00') }];
  r.shifts = [{
    shift_id: 's', device_id: F, business_date: D, status: 'closed', opened_at: et(D, '08:00'), opened_by: 's-mgr', starting_cash_cents: 15000,
    closed_at: et(D, '22:00'), closed_by: 's-mgr', close_approved_by: null, counted_cash_cents: 16400, expected_cash_cents: 16466, over_short_cents: -66, flags: {},
  }];
  r.movements = [{ id: 'm', shift_id: 's', kind: 'paid_out', amount_cents: 2000, reason: 'Driver gas', actor: 's-mgr', approved_by: null, created_at: et(D, '15:00') }];
  return r;
}

/**
 * The fixture's input as the POS's own repo/eod.ts would build it from these rows — the fixture VERBATIM except:
 *   1. the refund ticket in its real form "A-002 of <day>" (repo/eod.ts :473-476; the unit fixture uses a bare ticket);
 *   2. the two deposit payments p6 / p7 are in `payments` too: depositsOnScheduled / paidNotClosed are subsets of the
 *      payments taken that day (repo/eod.ts :430, :438-440), so no rows can produce the fixture's tender without them
 *      (the unit fixture lists them only under deposits — a state the POS repo can't produce either).
 */
function goldenInput(): DayReportInput {
  const input = posFixtureInput();
  return {
    ...input,
    payments: [...input.payments, { id: 'p6', method: 'cash', amount: 1000 }, { id: 'p7', method: 'external_card', amount: 250 }],
    refunds: input.refunds.map((x) => ({ ...x, ticket: `A-002 of ${D}` })),
  } as DayReportInput;
}

/** …and its report as the server must produce it: repins null, unsynced 0. */
function goldenExpected(): ServerDayReport {
  return finalize(buildDayReport(goldenInput()));
}

const zRow = (o: Partial<DayCloseRow> & { report: unknown; covered: unknown }): DayCloseRow => ({
  day_close_id: crypto.randomUUID(), device_id: F, business_date: D, z_number: 1, sequence: 1, supplemental: false, closed_at: et(D, '23:00'),
  closed_by: 's-mgr', approved_by: null, carried_over_order_ids: [], flags: {}, received_at: et(D, '23:01'), ...o,
});
const ALL_COVERED = { order_ids: ['a', 'b', 'c'], voided_order_ids: ['v'], payment_ids: ['p1', 'p5', 'p2', 'p3', 'p4', 'p6', 'p7'], payment_void_ids: ['p5'], refund_ids: ['r1'], shift_ids: ['s'] };

// ---- golden -----------------------------------------------------------------------------------------------------

Deno.test('golden: the POS eod fixture as server rows → exactly that fixture\'s DayReport (provisional amounts; repins null, unsynced 0)', () => {
  const ix = new Indexed(goldenRows(), CTX);
  const got = finalize(buildDayReport(ix.input(F, D)));
  assertEquals(got, goldenExpected());
  // the POS test's own assertions (endOfDay.test.ts :142-158), on the server's result
  assertEquals(got.sales.orders, 3);
  assertEquals(got.sales.total, 1066 + 2964 + 1166);
  assertEquals(got.sales.deliveryFees, 499);
  assertEquals(got.netSalesAfterRefunds, 1066 + 2964 + 1166 - 500);
  // tender: the POS test's numbers + the two deposit payments (goldenInput note 2): cash +1000 (p6), card +250 (p7)
  assertEquals(got.tender.cash, { payments: { count: 4, amount: 1866 + 1000 }, voids: { count: 1, amount: 200 }, refunds: { count: 0, amount: 0 }, net: 1666 + 1000 } as any);
  assertEquals(got.tender.external_card, { payments: { count: 3, amount: 3530 + 250 }, voids: { count: 0, amount: 0 }, refunds: { count: 1, amount: 500 }, net: 3030 + 250 } as any);
  assertEquals(got.cardBatchNet, 3030 + 250);
  assertEquals(got.tips, { total: 400, cardOnly: 300, cashOnly: 0, mixed: 100, unpaid: 0 } as any);
  assertEquals(got.voids, { orders: { count: 1, amount: 777 }, lines: { count: 1, amount: 350 } } as any);
  assertEquals(got.overrides, { radius: 0, minimum: 1, repins: null, reasons: ['minimum: Regular'] });
  assertEquals(got.cash.overShort, -66);
  assertEquals(got.cash.paidOuts, { count: 1, amount: 2000 } as any);
  assertEquals(got.review.unsynced, 0);
  assertEquals(got.byTypeChannel.map((g) => [g.orderType, g.channel, g.orders, g.total]), [['delivery', 'phone', 1, 2964], ['pickup', 'counter', 2, 2232]]);
  assertEquals(got.scheduled[0].paid, 1000);
  assertEquals(got.deposits, { paidNotClosed: { count: 1, amount: 250 }, onScheduled: { count: 1, amount: 1000 }, applied: { count: 2, amount: 350 } } as any);
});

Deno.test('golden: amounts are the register\'s provisional pricing (never the server repricing) and the other register is empty', () => {
  const rows = goldenRows();
  rows.orders = rows.orders.map((o) => ({ ...o, pricing: pp({ total: 99999 }) } as any)); // a server repricing that must be ignored
  const ix = new Indexed(rows, CTX);
  assertEquals(finalize(buildDayReport(ix.input(F, D))).sales.total, 5196);
  assertEquals(finalize(buildDayReport(ix.input(G, D))).sales.orders, 0);
});

// ---- Z sum vs recompute ------------------------------------------------------------------------------------------

Deno.test('closed day: Σ Z = the recompute → z_matches ✓; shown money = the Z (repins null, unsynced 0), deposits recomputed', () => {
  const rows = goldenRows();
  // the register's Z as it sends it: snake_case, its own repins (1) and unsynced (1)
  rows.zs = [zRow({ report: snakeKeys(buildDayReport(goldenInput())), covered: ALL_COVERED })];
  const r = registerDay(new Indexed(rows, CTX), F, D, '2026-11-20');
  assertEquals(r.state, 'closed');
  assertEquals(r.zMatches, true);
  assertEquals(r.zDiff, []);
  assertEquals(r.report.overrides.repins, null);
  assertEquals(r.report.review.unsynced, 0);
  assertEquals(r.report.deposits, r.recomputed.deposits);
  assertEquals(r.depositsSource, 'recomputed');
  assertEquals(r.report.sales, goldenExpected().sales);
});

Deno.test('closed day: a Z that disagrees with the rows → z_matches ⚠ + the differing fields; an unreadable Z → recompute shown, z_matches null', () => {
  const rows = goldenRows();
  const rep = snakeKeys(buildDayReport(posFixtureInput())) as any;
  rep.sales.total += 1;
  rep.tender.cash.net += 5;
  rows.zs = [zRow({ report: rep, covered: ALL_COVERED })];
  const r = registerDay(new Indexed(rows, CTX), F, D, '2026-11-20');
  assertEquals(r.zMatches, false);
  assert(r.zDiff.includes('sales.total'), r.zDiff.join());
  assert(r.zDiff.includes('tender.cash.net'), r.zDiff.join());
  assertEquals(r.report.sales.total, 5197); // the owner sees what the register printed …
  assertEquals(r.recomputed.sales.total, 5196); // … and what the rows say

  rows.zs = [zRow({ report: { sales: 'garbled' }, covered: ALL_COVERED })];
  const u = registerDay(new Indexed(rows, CTX), F, D, '2026-11-20');
  assertEquals([u.state, u.zMatches, u.z?.unreadable], ['closed', null, true]);
  assertEquals(u.report, u.recomputed);
  assertEquals(parseZReport({ ...rep, sales: { ...rep.sales, total: 1.5 } }), null); // a fractional amount is unreadable too
});

Deno.test('supplemental Z: money = Σ every sequence; scheduled = the LATEST Z only', () => {
  const rows = goldenRows();
  const full = goldenInput();
  const none: DayReportInput = { closedOrders: [], voidedOrders: [], payments: [], paymentVoids: [], refunds: [], shifts: [], scheduled: [], depositsOnScheduled: [], paidNotClosed: [], depositsApplied: [] };
  // Z #1 covered order a (+ its cash payment p1 and the void of p5) and carried a stale scheduled list; Z #2 the rest
  const z1Input: DayReportInput = { ...none, closedOrders: [full.closedOrders[0]], payments: [full.payments[0], full.payments[4]], paymentVoids: full.paymentVoids, scheduled: [{ id: 'old', ticket: 'A-099', readyDay: '2026-11-20', total: 1, paid: 0 }] };
  const z2Input: DayReportInput = {
    ...full, closedOrders: full.closedOrders.slice(1), payments: [...full.payments.slice(1, 4), ...full.payments.slice(5)], paymentVoids: [],
  };
  rows.zs = [
    zRow({ sequence: 2, z_number: 2, supplemental: true, report: snakeKeys(buildDayReport(z2Input)), covered: { ...ALL_COVERED, order_ids: ['b', 'c'], voided_order_ids: ['v'], payment_ids: ['p2', 'p3', 'p4', 'p6', 'p7'], payment_void_ids: [] } }),
    zRow({ sequence: 1, report: snakeKeys(buildDayReport(z1Input)), covered: { order_ids: ['a'], voided_order_ids: [], payment_ids: ['p1', 'p5'], payment_void_ids: ['p5'], refund_ids: [], shift_ids: [] } }),
  ];
  const r = registerDay(new Indexed(rows, CTX), F, D, '2026-11-20');
  assertEquals(r.z?.sequences, [1, 2]);
  assertEquals(r.zMatches, true, r.zDiff.join());
  assertEquals(r.report.sales.total, 5196);
  assertEquals(r.report.tender.cash.payments, { count: 4, amount: 2866 } as any);
  assertEquals(r.report.scheduled.map((s) => s.id), ['x']); // Z #2's, not Z #1's stale list
});

Deno.test('combine: registers of a day add up (byTypeChannel merged + sorted, lists concatenated); empty → the empty report', () => {
  const a = goldenExpected();
  const two = combine([a, a], 'concat');
  assertEquals(two.sales.total, 2 * a.sales.total);
  assertEquals(two.byTypeChannel, a.byTypeChannel.map((g) => ({ ...g, orders: 2 * g.orders, total: 2 * g.total })) as any);
  assertEquals(two.tender.cash.net, 2 * a.tender.cash.net);
  assertEquals(two.refunds.items.length, 2);
  assertEquals(two.scheduled.length, 2);
  assertEquals(combine([a, a], 'last').scheduled.length, 1);
  assertEquals(combine([], 'concat').sales.orders, 0);
  assertEquals(camelKeys(snakeKeys(a)), a); // the stored-Z round trip (tender's Method keys kept)
});

// ---- dating -----------------------------------------------------------------------------------------------------

Deno.test('dating: a row a Z covers is dated by that Z (orders / voids / payments / payment voids / refunds / shifts); else by its own rule', () => {
  const N = '2026-11-20';
  const o = order('late', { sales_day: N, pricing: pp({ total: 1 }) });
  const ov = order('lv', { sales_day: N, status: 'voided', pricing: pp({ total: 1 }) });
  const p = pay('lp', 'late', 'cash', 1, { inserted_at: et(N, '12:00') });
  const pv = pay('lpv', 'late', 'cash', 1, { status: 'voided', voided_at: et(N, '12:00') });
  const rf: RefundRow = { refund_id: 'lr', device_id: F, order_id: 'late', payment_id: 'lp', method: 'cash', amount_cents: 1, reason: 'x', actor: 'register', approved_by: null, business_date: N, shift_id: null, created_at: et(N, '12:00') };
  const sh: ShiftRow = { ...goldenRows().shifts[0], shift_id: 'ls', business_date: N };
  const z = zRow({ report: {}, covered: { order_ids: ['late'], voided_order_ids: ['lv'], payment_ids: ['lp'], payment_void_ids: ['lpv'], refund_ids: ['lr'], shift_ids: ['ls'] } });
  const covered = makeDating([z], TZ, '04:00');
  assertEquals([covered.order(o), covered.order(ov), covered.payment(p), covered.paymentVoid(pv), covered.refund(rf), covered.shift(sh)], [D, D, D, D, D, D]);
  const own = makeDating([], TZ, '04:00');
  assertEquals([own.order(o), own.order(ov), own.payment(p), own.paymentVoid(pv), own.refund(rf), own.shift(sh)], [N, N, N, N, N, N]);
  assertEquals(own.order(order('op', { status: 'open', sales_day: null, pricing: pp({ total: 1 }) })), null);
  assertEquals(own.paymentVoid(p), null); // captured → no void day
});

Deno.test('offline across the cutoff: taken 03:59 on day D, synced 04:10 → the live day D+1 until the Z of D covers it', () => {
  const N = '2026-11-20';
  const rows = emptyRows();
  rows.orders = [order('k', { pricing: pp({ subtotal: 1000, net: 1000, total: 1000 }), sales_day: D })];
  // the register took it at 03:59 ET on 11-20 (business day 11-19) but only reached the server at 04:10 ET
  rows.payments = [pay('kp', 'k', 'cash', 1000, { inserted_at: et(N, '04:10') })];
  assertEquals(makeDating([], TZ, '04:00').payment(pay('q', 'k', 'cash', 1, { inserted_at: et(N, '03:59') })), D); // the cutoff itself
  let ix = new Indexed(rows, CTX);
  assertEquals(finalize(buildDayReport(ix.input(F, N))).tender.cash.payments.amount, 1000); // the X of 11-20 (server receive time)
  assertEquals(finalize(buildDayReport(ix.input(F, D))).tender.cash.payments.amount, 0);
  rows.zs = [zRow({ report: snakeKeys(buildDayReport(ix.input(F, D))), covered: { order_ids: ['k'], voided_order_ids: [], payment_ids: ['kp'], payment_void_ids: [], refund_ids: [], shift_ids: [] } })];
  ix = new Indexed(rows, CTX);
  assertEquals(finalize(buildDayReport(ix.input(F, D))).tender.cash.payments.amount, 1000); // the Z of 11-19 dates it
  assertEquals(finalize(buildDayReport(ix.input(F, N))).tender.cash.payments.amount, 0);
});

// ---- online -----------------------------------------------------------------------------------------------------

const ordr = (o: Record<string, unknown> & { id: string }): any => ({
  restaurant_id: RID, order_type: 'pickup', status: 'complete', created_at: et(D, '18:00'), items_written_at: et(D, '18:00'), scheduled_for: null,
  subtotal: '1.72', tax_amount: '0', tip_amount: '0', total_amount: '1.72', refund_status: null, refund_amount: null, order_items: [], adjustment_requests: [],
  customer_name: 'Online PII Name', customer_email: 'pii@example.com', customer_phone: '+15555550100', ...o,
});

Deno.test('online: the POS onlineDaySummary over the feed wires — cancelled, refunds, extra charges, pending, dating, exact cents', () => {
  const rows = emptyRows();
  rows.online.orders = [
    ordr({ id: 'o1', order_number: 1020514, status: 'cancelled', refund_status: 'completed', refund_amount: '1.72', adjustment_requests: [{ id: 'j1', type: 'charge', amount: '1.00', status: 'approved', created_at: et(D, '18:10') }, { id: 'j2', type: 'refund', amount: '0.72', status: 'pending', created_at: et(D, '18:20') }] }),
    ordr({ id: 'o2', order_number: 1020515, total_amount: '0.30', tip_amount: '0.10' }), // decimal-exact: 30¢, never 0.1+0.2 float
    ordr({ id: 'o3', order_number: 1020516, total_amount: '10.00', refund_status: 'partial', refund_amount: '2.50' }),
    ordr({ id: 'o4', order_number: 1020517, created_at: et('2026-11-20', '03:30'), items_written_at: et('2026-11-20', '03:30') }), // 03:30 → the 11-19 business day
    ordr({ id: 'o5', order_number: 1020518, scheduled_for: et('2026-11-20', '12:00') }), // scheduled → the day it's for
    ordr({ id: 'o6', order_number: 1020519, items_written_at: null }), // never served (no items) → not counted, as on the POS
  ];
  rows.online.kitchenhub = [
    { id: 'k1', restaurant_id: RID, kh_order_id: 77, provider_id: 'doordash', status: 'completed', created_at: et(D, '19:00'), charges: { total: '12.34' }, paid: true, items: [] },
    { id: 'k2', restaurant_id: RID, kh_order_id: 78, provider_id: 'grubhub', status: 'completed', created_at: et(D, '19:30'), charges: {}, paid: false, payment_method: 'cash', items: [] },
  ];
  const wires = onlineWires(rows, CTX);
  const day = onlineDay(D, wires);
  const o = day.summary.ordr;
  assertEquals([o.orders, o.total, o.tips], [3, 30 + 1000 + 172, 10]);
  assertEquals(o.cancelled, { count: 1, amount: 172 } as any);
  assertEquals(o.refunded, { count: 2, amount: 172 + 250 } as any);
  assertEquals(o.chargesApproved, { count: 1, amount: 100 } as any);
  assertEquals(o.adjustmentsPending, 1);
  assertEquals(day.extra.refundsOnSales, { count: 1, amount: 250 } as any);
  const k = day.summary.kitchenhub;
  assertEquals([k.orders, k.knownTotal, k.unknownTotals], [2, 1234, 1]);
  assertEquals(k.collect, { count: 1, amount: 0, unknown: 1 } as any);
  assertEquals(k.byMarketplace, [{ provider: 'doordash', orders: 1 }, { provider: 'grubhub', orders: 1 }]);
  assertEquals(onlineDay('2026-11-20', wires).summary.ordr.orders, 1); // o5
});

Deno.test('combined: POS + online sales / net / payments by method; cancelled-not-refunded reconciliation', () => {
  const rows = goldenRows();
  rows.online.orders = [
    ordr({ id: 'o1', status: 'cancelled', refund_status: 'completed', refund_amount: '1.72', adjustment_requests: [{ id: 'j1', type: 'charge', amount: '1.00', status: 'approved', created_at: et(D, '18:10') }] }),
    ordr({ id: 'o3', total_amount: '10.00', refund_status: 'partial', refund_amount: '2.50' }),
    ordr({ id: 'o7', status: 'cancelled', total_amount: '5.00' }), // cancelled, never refunded
  ];
  const range = (resolveRange({ from: D, to: D }, Date.parse(et('2026-11-20', '10:00')), TZ) as any).range;
  const rep = buildReport(rows, range, { ...CTX, nowMs: Date.parse(et('2026-11-20', '10:00')) }) as any;
  const c = rep.days[0].combined;
  assertEquals(c.sales_total, 5196 + 1000 + 100);
  assertEquals(c.net_after_refunds, 4696 + 1000 + 100 - 250);
  assertEquals(c.payments.cash, 2666);
  assertEquals(c.payments.card_register, 3280);
  assertEquals(c.payments.card_online, { payments: 1000 + 172 + 500 + 100, refunds: 172 + 250, net: 1772 - 422 });
  assertEquals(c.online_cancelled_not_refunded, 500);
  assertEquals(rep.days[0].state, 'unclosed'); // a past day, no Z
});

// ---- the whole report + the handler ---------------------------------------------------------------------------

function seededDb(): FakeDb {
  const db = new FakeDb();
  db.users.set('tablet-token', { email: 'tablet@testpizza.example' });
  db.users.set('admin-token', { email: 'admin@ordr.example' });
  db.users.set('other-token', { email: 'someone@else.example' });
  db.add('restaurants', { id: RID, tablet_email: 'tablet@testpizza.example', timezone: TZ, dsp_orders_enabled: false });
  db.add('admin_users', { email: 'admin@ordr.example' });
  const g = goldenRows();
  db.add('pos_devices', ...g.devices.map((d) => ({ ...d, restaurant_id: RID, token_hash: 'secret-hash' })));
  db.add('pos_staff', { id: 's-mgr', name: 'Maria', restaurant_id: RID, pin_hash: 'secret' });
  for (const o of g.orders) {
    const { delivery_overrides, delivery_unverified: _unverified, ...rest } = o;
    db.add('pos_orders', {
      ...rest, restaurant_id: RID, customer_name: 'POS PII Name', customer_phone_e164: '+15555550199', note: 'PII note',
      pricing: pp({ total: 88888 }), // the server's repricing — must never be used
      delivery: o.order_id === 'b' ? { address: { street: '1 PII Street' }, overrides: delivery_overrides, delivery_unverified: false } : null,
      created_at: et(D, '11:00'),
    });
  }
  db.add('pos_payments', ...g.payments.map((p) => ({ ...p, restaurant_id: RID })));
  db.add('pos_order_lines', { id: 'l1', order_id: 'b', base_price_cents: 300, quantity: 1, status: 'voided', item_name: 'Soda' });
  db.add('pos_order_line_modifiers', { id: 'lm1', line_id: 'l1', order_id: 'b', charge_cents: 50 });
  db.add('pos_refunds', ...g.refunds.map((r) => ({ ...r, restaurant_id: RID })));
  db.add('pos_shifts', ...g.shifts.map((s) => ({ ...s, restaurant_id: RID })));
  db.add('pos_cash_movements', ...g.movements.map((m) => ({ ...m, restaurant_id: RID })));
  db.add('orders', ordr({ id: 'o1', order_number: 1020514 }));
  return db;
}

const NOW = Date.parse(et('2026-11-20', '10:00')); // 10:00 ET on 11-20 → today = 2026-11-20
const call = (db: FakeDb, body: unknown, token: string | null = 'tablet-token') =>
  handleReports(new Request('https://x/functions/v1/pos-reports', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), { db: db as any, now: () => NOW, log: () => {} });

Deno.test('auth: 401 without / with a bad token; 404 unknown restaurant; 403 another restaurant\'s tablet; tablet owner + admin → 200', async () => {
  const db = seededDb();
  assertEquals((await call(db, { restaurant_id: RID, preset: 'today' }, null)).status, 401);
  assertEquals((await call(db, { restaurant_id: RID, preset: 'today' }, 'nope')).status, 401);
  assertEquals((await call(db, { restaurant_id: 'missing', preset: 'today' })).status, 404);
  const forbidden = await call(db, { restaurant_id: RID, preset: 'today' }, 'other-token');
  assertEquals(forbidden.status, 403);
  assertEquals(await forbidden.json(), { error: 'not authorized for this restaurant' });
  assertEquals((await call(db, { restaurant_id: RID, preset: 'today' })).status, 200);
  assertEquals((await call(db, { restaurant_id: RID, preset: 'today' }, 'admin-token')).status, 200);
  const opt = await handleReports(new Request('https://x', { method: 'OPTIONS' }), { db: db as any, now: () => NOW, log: () => {} });
  assertEquals(opt.status, 200);
  assertEquals((await call(db, { restaurant_id: RID, preset: 'week' })).status, 400);
  assertEquals((await call(db, { preset: 'today' })).status, 400);
});

Deno.test('end to end (fake PostgREST): the golden day served; provisional amounts; no customer data read or returned; cents only', async () => {
  const db = seededDb();
  const res = await call(db, { restaurant_id: RID, from: D, to: D });
  assertEquals(res.status, 200);
  const text = await res.text();
  const rep = JSON.parse(text);
  assertEquals(rep.range, { from: D, to: D, today: '2026-11-20', preset: null, time_zone: TZ, cutoff: '04:00', server_time: new Date(NOW).toISOString() });
  const day = rep.days[0];
  assertEquals(day.state, 'unclosed');
  assertEquals(day.registers.map((r: any) => [r.prefix, r.state]), [['F', 'unclosed']]);
  assertEquals(camelKeys(day.pos), goldenExpected() as unknown);
  assertEquals(day.online.ordr.orders, 1);
  assertEquals(rep.shifts[0].opened_by, 'Maria');
  assertEquals(rep.shifts[0].movements[0], { kind: 'paid_out', amount_cents: 2000, reason: 'Driver gas', actor: 'Maria', approved_by: null, created_at: et(D, '15:00') });
  // no customer data out: no names, phones, emails, notes or addresses; no secrets
  for (const s of ['PII', 'pii@', '+1555', 'secret', 'Street']) assert(!text.includes(s), `response contains ${s}`);
  // …and none read from pos_*: only the two delivery keys, never customer columns
  for (const [t, cols] of db.selects) {
    if (t.startsWith('pos_')) for (const bad of ['customer', 'note', 'token_hash', 'pin_hash', '*']) assert(!cols.includes(bad), `${t} read ${bad}`);
  }
  assertStringIncludes(db.selects.find(([t]) => t === 'pos_orders')![1], 'delivery_overrides:delivery->overrides');
});

Deno.test('end to end: a closed day with a matching Z → ✓; today (no Z) → live; the Z history row; a read failure → 500', async () => {
  const db = seededDb();
  db.add('pos_day_closes', {
    ...zRow({ report: snakeKeys(buildDayReport(goldenInput())), covered: ALL_COVERED }),
    restaurant_id: RID, day_close_id: 'z1',
  });
  const rep = await (await call(db, { restaurant_id: RID, preset: 'last7' })).json();
  assertEquals(rep.range.from, '2026-11-14');
  const d19 = rep.days.find((d: any) => d.date === D);
  assertEquals([d19.state, d19.registers[0].z_matches, d19.registers[0].z.sequences], ['closed', true, [1]]);
  assertEquals(d19.pos.overrides.repins, null);
  assertEquals(rep.days.find((d: any) => d.date === '2026-11-20').state, 'live');
  assertEquals(rep.z_history.map((z: any) => [z.prefix, z.business_date, z.z_number, z.sales_total_cents, z.closed_by]), [['F', D, 1, 5196, 'Maria']]);
  assertEquals(rep.total.pos.sales.total, 5196);
  db.failTable = 'pos_refunds';
  assertEquals((await call(db, { restaurant_id: RID, preset: 'today' })).status, 500);
});

// ---- ranges -----------------------------------------------------------------------------------------------------

Deno.test('ranges: presets on the business day (02:00 is still yesterday), months, custom checks, the 93-day cap', () => {
  const at2am = Date.parse(et('2026-11-27', '02:00'));
  const r = (x: any, now = at2am) => resolveRange(x, now, TZ) as any;
  assertEquals(r({ preset: 'today' }).range.from, '2026-11-26');
  assertEquals([r({ preset: 'yesterday' }).range.from, r({ preset: 'yesterday' }).range.to], ['2026-11-25', '2026-11-25']);
  assertEquals(r({ preset: 'last7' }).range.days.length, 7);
  assertEquals(r({ preset: 'last30' }).range.from, '2026-10-28');
  assertEquals([r({ preset: 'thisMonth' }).range.from, r({ preset: 'thisMonth' }).range.to], ['2026-11-01', '2026-11-26']);
  assertEquals([r({ preset: 'lastMonth' }).range.from, r({ preset: 'lastMonth' }).range.to], ['2026-10-01', '2026-10-31']);
  assertEquals(r({ preset: 'today' }, Date.parse(et('2026-11-27', '04:00'))).range.from, '2026-11-27');
  assertEquals(r({ from: '2026-11-01', to: '2026-11-26' }).ok, true);
  assertEquals(r({ from: '2026-11-01', to: '2026-11-27' }).field, 'to'); // after today
  assertEquals(r({ from: '2026-11-10', to: '2026-11-01' }).field, 'from');
  assertEquals(r({ from: '2026-02-30', to: '2026-03-01' }).field, 'from');
  assertEquals(r({ from: '2026-08-01', to: '2026-11-26' }).message, `at most ${MAX_RANGE_DAYS} days`);
  assertEquals(r({ from: '2026-08-26', to: '2026-11-26' }).ok, true); // exactly 93
  assertEquals(r({ preset: 'today', from: '2026-11-01' }).field, 'preset');
});
