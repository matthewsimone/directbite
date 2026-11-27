/**
 * Owner Reports v1 — small PORTS from ordr-pos @ 6f38487 (not vendored files: the logic is copied with its source
 * lines cited, the types pointed at the server's own; the POS sends an FYI before changing any of them — ordr-pos
 * docs/STATUS.md "STANDING RULE — DayReport shape (SYNC-31)").
 *
 *   snakeKeys            ← src/db/repo/eod.ts :62-69   (the Z report's wire form, pos_day_closes.report)
 *   camelKeys            the inverse, for reading a stored Z back (Method keys under `tender` kept as sent)
 *   deliveryNeedsReview  ← src/sync/delivery.ts :81-95 (ReportOrder.deliveryReview, repo/sync.ts :178)
 *   mustCollect          ← src/sync/onlineContract.ts :74-77
 *   onlineDaySummary     ← src/core/onlineDay.ts :18-77 (types + sum + the summary)
 */
import { cents, sumCents, type Cents } from '../ordr-core/money.ts';
import type { OnlineExternalWire, OnlineOrderWire } from '../pos-online/wire.ts';

// ---- src/db/repo/eod.ts :62-69 -------------------------------------------------------------------------------

/** Wire form of the report: canonical JSON keys are snake_case (SYNC-CONTRACT §7). Keys only; values untouched. */
export function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(x)]));
  }
  return v;
}

/**
 * The inverse of snakeKeys for a stored DayReport. `tender`'s keys are Method VALUES ('cash' | 'external_card'), which
 * snakeKeys leaves as they are — so they are kept, not camel-cased. camelKeys(snakeKeys(r)) deep-equals r (tests).
 */
export function camelKeys(v: unknown, keepKeys = false): unknown {
  if (Array.isArray(v)) return v.map((x) => camelKeys(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const key = keepKeys ? k : k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      return [key, camelKeys(x, key === 'tender')];
    }));
  }
  return v;
}

// ---- src/sync/delivery.ts :81-95 -----------------------------------------------------------------------------

type DeliveryFlagsLike = Partial<Record<
  | 'delivery_fee_review' | 'delivery_out_of_radius' | 'delivery_override' | 'delivery_fee_mismatch' | 'delivery_quote_unknown'
  | 'delivery_quote_expired' | 'delivery_fee_missing' | 'delivery_below_minimum' | 'delivery_unverified', unknown>>;

/** Any server delivery flag that a person should look at (badge / review list). */
export function deliveryNeedsReview(f: DeliveryFlagsLike | undefined | null): boolean {
  if (!f) return false;
  return !!(
    f.delivery_fee_review ||
    f.delivery_out_of_radius ||
    f.delivery_override ||
    f.delivery_fee_mismatch ||
    f.delivery_quote_unknown ||
    f.delivery_quote_expired ||
    f.delivery_fee_missing ||
    f.delivery_below_minimum ||
    f.delivery_unverified
  );
}

// ---- src/sync/onlineContract.ts :74-77 -----------------------------------------------------------------------

/** COLLECT when unpaid: paid === false, or the payment method is cash (Matt, 2026-11-23). */
export function mustCollect(e: Pick<OnlineExternalWire, 'paid' | 'payment_method'>): boolean {
  return e.paid === false || (e.payment_method ?? '').toLowerCase() === 'cash';
}

// ---- src/core/onlineDay.ts :18-77 ----------------------------------------------------------------------------

export interface OnlineDaySummary {
  businessDate: string;
  ordr: {
    orders: number;
    total: Cents;
    tips: Cents;
    cancelled: { count: number; amount: Cents };
    refunded: { count: number; amount: Cents };
    chargesApproved: { count: number; amount: Cents };
    adjustmentsPending: number;
  };
  kitchenhub: {
    orders: number;
    byMarketplace: { provider: string; orders: number }[];
    knownTotal: Cents;
    unknownTotals: number;
    collect: { count: number; amount: Cents; unknown: number };
    cancelled: number;
  };
}

const sum = (xs: readonly (number | null)[]): Cents => sumCents(xs.filter((x): x is number => x !== null).map(cents));

export function onlineDaySummary(businessDate: string, rows: readonly { businessDate: string | null; wire: OnlineOrderWire | null; readable: boolean }[]): OnlineDaySummary {
  const day = rows.filter((r) => r.businessDate === businessDate);
  const ws = day.map((r) => r.wire).filter((w): w is OnlineOrderWire => w !== null);
  const ordr = ws.filter((w) => w.channel === 'ordr');
  const live = ordr.filter((w) => w.status !== 'cancelled');
  const cancelled = ordr.filter((w) => w.status === 'cancelled');
  const refunded = ordr.filter((w) => w.refund.status === 'completed' || w.refund.status === 'partial');
  const charges = ordr.flatMap((w) => w.adjustments.filter((a) => a.type === 'charge' && a.status === 'approved'));
  const kh = ws.filter((w) => w.channel === 'kitchenhub');
  const khLive = kh.filter((w) => w.status !== 'cancelled');
  const collect = khLive.filter((w) => w.external && mustCollect(w.external));
  const providers = new Map<string, number>();
  for (const w of khLive) {
    const p = w.external?.provider ?? 'other';
    providers.set(p, (providers.get(p) ?? 0) + 1);
  }
  return {
    businessDate,
    ordr: {
      orders: live.length,
      total: sum(live.map((w) => w.money.total_cents)),
      tips: sum(live.map((w) => w.money.tip_cents)),
      cancelled: { count: cancelled.length, amount: sum(cancelled.map((w) => w.money.total_cents)) },
      refunded: { count: refunded.length, amount: sum(refunded.map((w) => w.refund.amount_cents)) },
      chargesApproved: { count: charges.length, amount: sum(charges.map((a) => a.amount_cents)) },
      adjustmentsPending: ordr.reduce((n, w) => n + w.adjustments.filter((a) => a.status === 'pending').length, 0),
    },
    kitchenhub: {
      orders: khLive.length,
      byMarketplace: [...providers].map(([provider, orders]) => ({ provider, orders })).sort((a, b) => a.provider.localeCompare(b.provider)),
      knownTotal: sum(khLive.map((w) => w.money.total_cents)),
      unknownTotals: khLive.filter((w) => w.money.total_cents === null).length,
      collect: { count: collect.length, amount: sum(collect.map((w) => w.money.total_cents)), unknown: collect.filter((w) => w.money.total_cents === null).length },
      cancelled: kh.length - khLive.length,
    },
  };
}
