/**
 * Drawer math (END-OF-DAY §1–§3) — the ONE place for "how much cash should be
 * in the drawer", over/short, and how much of a payment can still be refunded.
 * Pure, integer cents, no RN / Expo imports (vendored by directbite to verify
 * `drawer_mismatch` from a shift's attribution lists). A money home for the
 * invariant script, like tender.ts.
 */
import { cents, formatCents, subtractCents, sumCents, ZERO, type Cents } from './money.ts';

/** Largest single cash amount accepted (counts, paid-in/out, refunds): $100,000.00 — a typo guard, not a business rule. */
export const MAX_CASH_CENTS = 10_000_000;
export const DRAWER_REASON_MAX = 200;

export interface DrawerInput {
  starting: number;
  cashPayments: readonly number[];
  /** Open-order voids of cash payments ("refund cash" before Close). */
  cashPaymentVoids: readonly number[];
  /** Refunds after Close, paid in cash. */
  cashRefunds: readonly number[];
  paidIns: readonly number[];
  paidOuts: readonly number[];
}

/** expected = starting + cash payments − cash refunds (voids + after-Close) − paid-outs + paid-ins (Matt, E1–E10). */
export function expectedCash(i: DrawerInput): Cents {
  const into = sumCents([cents(i.starting), ...i.cashPayments.map(cents), ...i.paidIns.map(cents)]);
  const out = sumCents([...i.cashPaymentVoids.map(cents), ...i.cashRefunds.map(cents), ...i.paidOuts.map(cents)]);
  return subtractCents(into, out);
}

/** counted − expected: negative = short, positive = over. */
export function overShort(counted: Cents, expected: Cents): Cents {
  return subtractCents(counted, expected);
}

/** What is left to refund on a payment after earlier refunds (never negative). */
export function refundableRemaining(paymentAmount: number, priorRefunds: readonly number[]): Cents {
  const left = subtractCents(cents(paymentAmount), sumCents(priorRefunds.map(cents)));
  return left > 0 ? left : ZERO;
}

export type DrawerCheck = { ok: true; amount: Cents } | { ok: false; code: 'invalid_input' | 'refund_exceeds_payment'; message: string };

/** A counted drawer amount: whole cents, 0 … MAX. */
export function checkCount(amountCents: number): DrawerCheck {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > MAX_CASH_CENTS) return { ok: false, code: 'invalid_input', message: 'Enter the counted cash (0 or more).' };
  return { ok: true, amount: cents(amountCents) };
}

/** A paid-in / paid-out / refund amount: whole cents, > 0 … MAX. */
export function checkCashAmount(amountCents: number): DrawerCheck {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_CASH_CENTS) return { ok: false, code: 'invalid_input', message: 'Amount must be more than $0.00.' };
  return { ok: true, amount: cents(amountCents) };
}

/** Refund after Close: 0 < amount <= what is left on that payment (END-OF-DAY §3). */
export function checkRefund(remaining: Cents, amountCents: number): DrawerCheck {
  const a = checkCashAmount(amountCents);
  if (!a.ok) return a;
  if (a.amount > remaining) return { ok: false, code: 'refund_exceeds_payment', message: `Only ${formatCents(remaining)} left to refund on this payment.` };
  return a;
}

/** STAFF S3: does |over/short| exceed the restaurant's approval threshold? */
export function overShortExceeds(overShortCents: number, thresholdCents: number): boolean {
  const os = cents(overShortCents);
  const limit = cents(thresholdCents);
  return os > limit || os < subtractCents(ZERO, limit);
}
