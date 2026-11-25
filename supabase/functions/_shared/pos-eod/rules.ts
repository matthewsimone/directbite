/**
 * End-of-day rules (ordr-pos END-OF-DAY.md §7, SYNC-CONTRACT §3a; DIRECTBITE-HANDOFF item 7 FINAL CP3).
 *
 *  - businessDate        ← ordr-pos src/db/repo/businessDate.ts (ported verbatim; not a vendored file —
 *                          it lives in the device repo layer). The order's sales day uses it.
 *  - verifyDrawer        ← test/support/fakeServer.ts verifyDrawer :651-676, with the vendored drawer.ts
 *  - post_z              ← fakeServer.ts coveredBy :723-726, isPostZ :728-731, isPostZOrder :745-750
 */
import { expectedCash } from '../ordr-core-ext/drawer.ts';

// ---- business day ----------------------------------------------------------------------------------

const CUTOFF = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Restaurant-local business date: local calendar date in `timeZone`, minus one day before the cutoff (HH:MM). DST-safe. */
export function businessDate(epochMs: number, timeZone: string, cutoff: string): string {
  const m = CUTOFF.exec(cutoff);
  if (!m) throw new RangeError(`business_day_cutoff must be HH:MM, got "${cutoff}"`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  let y = get('year');
  let mo = get('month');
  let d = get('day');
  const minutesNow = get('hour') * 60 + get('minute');
  const minutesCutoff = Number(m[1]) * 60 + Number(m[2]);
  if (minutesNow < minutesCutoff) {
    const prev = new Date(Date.UTC(y, mo - 1, d - 1));
    y = prev.getUTCFullYear();
    mo = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
  }
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---- post_z ----------------------------------------------------------------------------------------

export interface DayCloseCovered {
  order_ids: string[];
  voided_order_ids: string[];
  payment_ids: string[];
  payment_void_ids: string[];
  refund_ids: string[];
  shift_ids: string[];
}

/** The Zs (any sequence) one register made for one business day. */
export type ZsOfDay = readonly { covered: DayCloseCovered }[];

export function coveredBy(zs: ZsOfDay, key: keyof DayCloseCovered, id: string): { anyZ: boolean; covered: boolean } {
  return { anyZ: zs.length > 0, covered: zs.some((z) => z.covered[key].includes(id)) };
}

/** A row dated a day that already has a Z from its register, and no Z of that day covers it. */
export function isPostZ(zs: ZsOfDay, key: keyof DayCloseCovered, id: string): boolean {
  const c = coveredBy(zs, key, id);
  return c.anyZ && !c.covered;
}

/**
 * An order: only once finalized (sales day = the business day of the device_time of the version that
 * first closed / voided it — open / carried orders have none → never post-Z); not covered as a sale or
 * as a void by any Z of that day.
 */
export function isPostZOrder(salesDay: string | null, zs: ZsOfDay, orderId: string): boolean {
  if (!salesDay) return false;
  const a = coveredBy(zs, 'order_ids', orderId);
  if (!a.anyZ || a.covered) return false;
  return !coveredBy(zs, 'voided_order_ids', orderId).covered;
}

// ---- drawer ------------------------------------------------------------------------------------------

export interface ShiftAttribution {
  cash_payments: { payment_id: string; order_id: string; amount_cents: number }[];
  cash_payment_voids: { payment_id: string; order_id: string; amount_cents: number }[];
  cash_refunds: { refund_id: string; payment_id: string; amount_cents: number }[];
}

export interface DrawerShift {
  starting_cash_cents: number;
  expected_cash_cents: number | null;
  attribution: ShiftAttribution | null;
  movements: { kind: string; amount_cents: number }[];
}

/** What the server has for a listed id (null = not synced yet). */
export interface DrawerLookups {
  payments: ReadonlyMap<string, { method: string; amount_cents: number; order_id: string; status: string } | null>;
  refunds: ReadonlyMap<string, { method: string; amount_cents: number } | null>;
}

/** The ids a closed shift's attribution names (for one batched lookup). */
export function attributionIds(a: ShiftAttribution): { paymentIds: string[]; refundIds: string[] } {
  return {
    paymentIds: [...new Set([...a.cash_payments, ...a.cash_payment_voids].map((x) => x.payment_id))],
    refundIds: [...new Set(a.cash_refunds.map((x) => x.refund_id))],
  };
}

/**
 * Closed shift: recompute expected cash from the listed amounts with the vendored drawer.ts (≠ the device's
 * → drawer_mismatch); each listed id against what the server has: missing (or a void whose payment is
 * still captured) → drawer_unverified; different method / amount / order → drawer_mismatch. Never a 400.
 */
export function verifyDrawer(p: DrawerShift, look: DrawerLookups): { drawer_mismatch: boolean; drawer_unverified: boolean } {
  const a = p.attribution!;
  const expected = expectedCash({
    starting: p.starting_cash_cents,
    cashPayments: a.cash_payments.map((x) => x.amount_cents),
    cashPaymentVoids: a.cash_payment_voids.map((x) => x.amount_cents),
    cashRefunds: a.cash_refunds.map((x) => x.amount_cents),
    paidIns: p.movements.filter((m) => m.kind === 'paid_in').map((m) => m.amount_cents),
    paidOuts: p.movements.filter((m) => m.kind === 'paid_out').map((m) => m.amount_cents),
  });
  let mismatch = expected !== p.expected_cash_cents;
  let unverified = false;
  for (const x of [...a.cash_payments, ...a.cash_payment_voids]) {
    const sp = look.payments.get(x.payment_id) ?? null;
    if (!sp) unverified = true;
    else if (sp.method !== 'cash' || sp.amount_cents !== x.amount_cents || sp.order_id !== x.order_id) mismatch = true;
  }
  for (const x of a.cash_payment_voids) if (look.payments.get(x.payment_id)?.status === 'captured') unverified = true;
  for (const x of a.cash_refunds) {
    const sr = look.refunds.get(x.refund_id) ?? null;
    if (!sr) unverified = true;
    else if (sr.method !== 'cash' || sr.amount_cents !== x.amount_cents) mismatch = true;
  }
  return { drawer_mismatch: mismatch, drawer_unverified: unverified };
}
