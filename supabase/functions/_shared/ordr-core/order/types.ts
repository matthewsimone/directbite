/**
 * Pricing module types. Spec: docs/PRICING-SPEC.md (approved 2026-11-19).
 * Pure TypeScript, relative `.ts` imports only (Deno-compatible).
 */
import type { Cents, Rate } from '../money.ts';

export type OrderType = 'pickup' | 'delivery' | 'dine_in';
export type Placement = 'whole' | 'left' | 'right';
export type RewardKind = 'item' | 'discount';

/** One `toppings.size_prices` entry, converted to cents at the API boundary. */
export interface SizePrice {
  price: Cents | null;
  half: Cents | null;
}

export interface ToppingPricing {
  /** `toppings.price` (whole). */
  price: Cents;
  /** `toppings.price_half`; null = derive from price. 0 = free half. */
  priceHalf: Cents | null;
  /** `toppings.size_prices`, keyed by normalized size name. */
  sizePrices: Readonly<Record<string, SizePrice>> | null;
}

export type Modifier =
  | { kind: 'pizza'; placement: Placement; topping: ToppingPricing }
  | { kind: 'addon'; price: Cents };

export interface Line {
  /** Positive integer. */
  quantity: number;
  /** Selected size price (or item price). */
  basePrice: Cents;
  sizeName: string | null;
  /** `menu_items.discount_exempt`: excluded from the promo. */
  discountExempt: boolean;
  modifiers: readonly Modifier[];
  /** Loyalty reward line: 'item' = free item, 'discount' = $0 marker. */
  reward: RewardKind | null;
}

export type TipInput =
  | { mode: 'none' }
  /** Percentage of the post-promo, pre-reward subtotal (18 = 18%). */
  | { mode: 'percent'; percent: Rate }
  /** Custom tip or the tip returned by the card terminal. */
  | { mode: 'amount'; amount: Cents };

export interface DeliveryTiers {
  maxRadiusMiles: number | null;
  tier1MaxMiles: number | null;
  tier1Fee: Cents | null;
  tier2Fee: Cents | null;
}

export type DeliveryInput =
  | { mode: 'in_house'; distanceMiles: number; tiers: DeliveryTiers }
  /** Uber passthrough is applied server-side at quote time. */
  | { mode: 'uber_direct'; customerFee: Cents };

/** Read from loyalty_redemptions / loyalty_rewards rows, never the cart. */
export interface Redemption {
  kind: RewardKind;
  /** Discount rewards only (> 0). */
  discountCents: Cents | null;
  /** `loyalty_rewards.min_subtotal_cents`, measured after promo. */
  minSubtotal: Cents;
}

export interface OrderInput {
  orderType: OrderType;
  lines: readonly Line[];
  tip: TipInput;
  /** Required iff orderType === 'delivery'. */
  delivery: DeliveryInput | null;
  /** At most one per order; online-only at launch. */
  loyaltyRedemption: Redemption | null;
}

export type LoyaltyEarnBasis = 'subtotal' | 'subtotal_less_discount' | 'total';

export interface RestaurantPricingConfig {
  /** Fraction, 0 <= r < 1 (e.g. 0.08875). */
  taxRate: Rate;
  /** Resolved active promotion, as a percentage 0..100; null = none. */
  promoPercent: Rate | null;
  /** Per channel: online 150; in-person (counter / dine-in / phone) 0. */
  baseServiceFee: Cents;
  /** Fraction; <= 0 = off, capped at 0.10. In-person: 0. */
  recoupRate: Rate;
  /** For the resolved delivery mode; 0 = none. */
  deliveryMinimum: Cents;
  loyalty: {
    enabled: boolean;
    /** Unknown / null falls back to 'subtotal' (as the SQL CASE does). */
    earnBasis: string | null;
    pointsPerDollar: Rate;
  };
}

export interface PricedModifier {
  charge: Cents;
}

export interface PricedLine {
  unit: Cents;
  quantity: number;
  lineTotal: Cents;
  modifiers: PricedModifier[];
}

export interface PricingBreakdown {
  lines: PricedLine[];
  subtotal: Cents;
  discountableSubtotal: Cents;
  promoDiscount: Cents;
  discountedSubtotal: Cents;
  /** Stored as orders.loyalty_discount_amount; deducted from earn basis. */
  loyaltyDiscountFace: Cents;
  /** What the receipt shows: the part of the face value actually used. */
  loyaltyDiscountApplied: Cents;
  netSubtotal: Cents;
  deliveryFee: Cents;
  tip: Cents;
  recoup: Cents;
  serviceFee: Cents;
  taxable: Cents;
  tax: Cents;
  total: Cents;
  loyaltyEarn: { basisCents: Cents; basePoints: number };
  rates: { promoPercent: string | null; recoupRate: string; taxRate: string };
}
