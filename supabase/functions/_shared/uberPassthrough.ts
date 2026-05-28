// ============================================================================
// Uber Direct passthrough policy — pure calculation library
// ============================================================================
//
// Extracted from the original M5a uber-quote handler so the same math can
// run in:
//   - uber-quote/index.ts (compute customer fee at quote time)
//   - create-payment-intent/index.ts (M6: recompute + validate at lock time)
//   - future uber-create-delivery (M9)
//
// All values in integer cents to avoid float drift. Caller converts cents
// to dollars as needed for downstream storage / display.
//
// Defensive: unknown mode value falls back to customer_full (customer pays
// all). Negative passthrough_value clamped to 0.
// ============================================================================

export type PassthroughMode =
  | "customer_full"
  | "split"
  | "restaurant_cap"
  | "customer_cap"
  | "restaurant_full";

export interface PassthroughResult {
  customer_cents: number;
  restaurant_cents: number;
}

export function applyPassthrough(
  uberFeeCents: number,
  mode: string,
  value: number
): PassthroughResult {
  const v = Math.max(0, Number(value) || 0);

  switch (mode) {
    case "customer_full":
      return { customer_cents: uberFeeCents, restaurant_cents: 0 };

    case "split": {
      // value is percentage 0-100 representing customer's share
      const customerPct = Math.min(100, v) / 100;
      const customer = Math.round(uberFeeCents * customerPct);
      return { customer_cents: customer, restaurant_cents: uberFeeCents - customer };
    }

    case "restaurant_cap": {
      // value is dollars cap on what restaurant absorbs
      const capCents = Math.round(v * 100);
      const restaurant = Math.min(uberFeeCents, capCents);
      return { customer_cents: uberFeeCents - restaurant, restaurant_cents: restaurant };
    }

    case "customer_cap": {
      // value is dollars cap on what customer pays
      const capCents = Math.round(v * 100);
      const customer = Math.min(uberFeeCents, capCents);
      return { customer_cents: customer, restaurant_cents: uberFeeCents - customer };
    }

    case "restaurant_full":
      return { customer_cents: 0, restaurant_cents: uberFeeCents };

    default:
      console.warn(`[uberPassthrough] unknown mode: ${mode}; defaulting to customer_full`);
      return { customer_cents: uberFeeCents, restaurant_cents: 0 };
  }
}
