/**
 * Server pricing for pos-v1-submit-order (SYNC-CONTRACT §3.4 steps 1–8): the total of record.
 *
 * Ports (behavior-identical; these files are NOT vendored — they import device-only types):
 *  - buildServerInput      ← ordr-pos test/support/fakeServer.ts:1091-1138
 *  - priceAgainstSnapshot  ← fakeServer.ts price() :1044-1073 (in-person config from the principal)
 *  - deliveryPricing       ← fakeServer.ts :813-897, minus what needs item 5 (quotes table, geocoder)
 *  - availabilityViolation ← fakeServer.ts :1024-1042
 *  - breakdownToWire       ← src/sync/wire.ts
 *  - diffBreakdowns        ← src/sync/diff.ts
 *  - deliveryInputFor / deliveryFeeOf / effectiveDeliveryMinimum / tiersFromWire ← src/sync/delivery.ts
 * Money math happens only inside the vendored priceOrder.
 */
import { cents, parseRate, subtractCents, ZERO, ZERO_RATE, type Cents } from '../ordr-core/money.ts';
import { priceOrder, PricingError, type DeliveryInput, type DeliveryTiers, type Line, type Modifier, type OrderInput, type PricingBreakdown, type TipInput } from '../ordr-core/order/index.ts';
import { isCategoryAvailableAt } from '../ordr-core-ext/availability.ts';
import type { MenuSnapshot } from './menuSnapshot.ts';
import type { DeliveryFeeSource, OrderPayload, WireBreakdown } from './orderPayload.ts';
import { sizePricesToMap } from './sizePrices.ts';

/** A 400 with a contract code (unknown_menu_item / unknown_topping / invalid_payload). */
export class ServerValidation extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = 'ServerValidation';
  }
}

// ---- wire mapping + diff (src/sync/wire.ts, src/sync/diff.ts) ---------------------------------

export function breakdownToWire(b: PricingBreakdown): WireBreakdown {
  return {
    lines: b.lines.map((l) => ({
      unit_cents: l.unit,
      quantity: l.quantity,
      line_total_cents: l.lineTotal,
      modifiers: l.modifiers.map((m) => ({ charge_cents: m.charge })),
    })),
    subtotal_cents: b.subtotal,
    discountable_subtotal_cents: b.discountableSubtotal,
    promo_discount_cents: b.promoDiscount,
    discounted_subtotal_cents: b.discountedSubtotal,
    loyalty_discount_face_cents: b.loyaltyDiscountFace,
    loyalty_discount_applied_cents: b.loyaltyDiscountApplied,
    net_subtotal_cents: b.netSubtotal,
    delivery_fee_cents: b.deliveryFee,
    tip_cents: b.tip,
    recoup_cents: b.recoup,
    service_fee_cents: b.serviceFee,
    taxable_cents: b.taxable,
    tax_cents: b.tax,
    total_cents: b.total,
    loyalty_earn: { basis_cents: b.loyaltyEarn.basisCents, base_points: b.loyaltyEarn.basePoints },
    rates: { promo_percent: b.rates.promoPercent, recoup_rate: b.rates.recoupRate, tax_rate: b.rates.taxRate },
  };
}

export type BreakdownDiff = Record<string, { provisional: number; server: number; delta: number }>;

const TOP: (keyof WireBreakdown)[] = [
  'subtotal_cents', 'discountable_subtotal_cents', 'promo_discount_cents', 'discounted_subtotal_cents',
  'loyalty_discount_face_cents', 'loyalty_discount_applied_cents', 'net_subtotal_cents', 'delivery_fee_cents',
  'tip_cents', 'recoup_cents', 'service_fee_cents', 'taxable_cents', 'tax_cents', 'total_cents',
];

/** Every money field incl. per line / modifier; only differing ones are listed (delta = server − provisional). */
export function diffBreakdowns(provisional: WireBreakdown, server: WireBreakdown): BreakdownDiff {
  const out: BreakdownDiff = {};
  const cmp = (path: string, a: number | undefined, b: number | undefined) => {
    const p = a ?? 0;
    const s = b ?? 0;
    if (a === undefined || b === undefined || p !== s) {
      out[path] = { provisional: p, server: s, delta: subtractCents(cents(s), cents(p)) };
    }
  };
  for (const k of TOP) cmp(k, provisional[k] as number, server[k] as number);
  const n = Math.max(provisional.lines.length, server.lines.length);
  for (let i = 0; i < n; i++) {
    const a = provisional.lines[i];
    const b = server.lines[i];
    cmp(`lines[${i}].unit_cents`, a?.unit_cents, b?.unit_cents);
    cmp(`lines[${i}].line_total_cents`, a?.line_total_cents, b?.line_total_cents);
    const m = Math.max(a?.modifiers.length ?? 0, b?.modifiers.length ?? 0);
    for (let j = 0; j < m; j++) cmp(`lines[${i}].modifiers[${j}].charge_cents`, a?.modifiers[j]?.charge_cents, b?.modifiers[j]?.charge_cents);
  }
  return out;
}

// ---- order input from ids + the snapshot (never request prices) --------------------------------

export function buildServerInput(p: OrderPayload, snap: MenuSnapshot): OrderInput {
  const items = new Map(snap.items.map((i) => [i.id, i]));
  const categories = new Map(snap.categories.map((c) => [c.id, c]));
  const sizes = new Map(snap.item_sizes.map((s) => [s.id, s]));
  const toppings = new Map(snap.toppings.map((t) => [t.id, t]));
  const groups = new Map(snap.topping_groups.map((g) => [g.id, g]));
  const lines: Line[] = p.lines
    .filter((l) => l.status === 'active')
    .map((l) => {
      const item = items.get(l.menu_item_id);
      const size = l.item_size_id ? sizes.get(l.item_size_id) : undefined;
      if (!item || !size || size.item_id !== item.id) throw new ServerValidation('unknown_menu_item', `item ${l.menu_item_id}/${l.item_size_id}`);
      const modifiers: Modifier[] = l.modifiers.map((m) => {
        const t = toppings.get(m.topping_id);
        const g = t ? groups.get(t.group_id) : undefined;
        if (!t || !g) throw new ServerValidation('unknown_topping', `topping ${m.topping_id}`);
        if (g.placement_type === 'addon') return { kind: 'addon', price: cents(t.price_cents) };
        if (!m.placement) throw new ServerValidation('invalid_payload', `pizza topping ${t.id} without placement`);
        return {
          kind: 'pizza',
          placement: m.placement,
          topping: {
            price: cents(t.price_cents),
            priceHalf: t.price_half_cents === null ? null : cents(t.price_half_cents),
            // CP9b: the snapshot carries [{size_key, price_cents, half_cents}] → the module's map
            sizePrices: sizePricesToMap(t.size_prices),
          },
        };
      });
      const category = categories.get(item.category_id);
      if (!category) throw new ServerValidation('unknown_menu_item', `category ${item.category_id}`);
      // Promo exemption is per category, never from the request.
      return { quantity: l.quantity, basePrice: cents(size.price_cents), sizeName: size.name, discountExempt: category.discount_exempt, modifiers, reward: null };
    });
  const tip: TipInput =
    p.tip.mode === 'percent'
      ? { mode: 'percent', percent: parseRate(p.tip.percent ?? '') }
      : p.tip.mode === 'amount'
        ? { mode: 'amount', amount: cents(p.tip.amount_cents ?? Number.NaN) as Cents }
        : { mode: 'none' };
  return { orderType: p.order_type, lines, tip, delivery: null, loyaltyRedemption: null };
}

// ---- delivery (src/sync/delivery.ts + fakeServer deliveryPricing) --------------------------------

export interface DeliveryFlags {
  delivery_unverified: boolean;
  delivery_fee_review: boolean;
  delivery_out_of_radius: boolean;
  delivery_override: boolean;
  delivery_fee_mismatch: boolean;
  delivery_quote_unknown: boolean;
  delivery_quote_expired: boolean;
  delivery_fee_missing: boolean;
  delivery_below_minimum: boolean;
  server_fee_cents: number | null;
}

export function tiersFromWire(d: MenuSnapshot['restaurant']['delivery']): DeliveryTiers {
  return {
    maxRadiusMiles: d.max_radius_miles === null ? null : Number(d.max_radius_miles),
    tier1MaxMiles: d.tier1_max_miles === null ? null : Number(d.tier1_max_miles),
    tier1Fee: d.tier1_fee_cents === null ? null : cents(d.tier1_fee_cents),
    tier2Fee: d.tier2_fee_cents === null ? null : cents(d.tier2_fee_cents),
  };
}

export function deliveryInputFor(source: DeliveryFeeSource, data: { distanceMiles: string | null; tiers: DeliveryTiers; offlineFee: Cents }): DeliveryInput {
  switch (source) {
    case 'quoted':
      if (data.distanceMiles === null) throw new Error('quoted delivery needs a distance');
      return { mode: 'in_house', distanceMiles: Number(data.distanceMiles), tiers: data.tiers };
    case 'offline':
    case 'override':
      return { mode: 'uber_direct', customerFee: data.offlineFee };
    case 'pending':
      return { mode: 'uber_direct', customerFee: ZERO };
  }
}

/** The fee as the frozen module prices it (no local tier math). */
export function deliveryFeeOf(input: DeliveryInput): Cents {
  return priceOrder(
    { orderType: 'delivery', lines: [], tip: { mode: 'none' }, delivery: input, loyaltyRedemption: null },
    { taxRate: ZERO_RATE, promoPercent: null, baseServiceFee: ZERO, recoupRate: ZERO_RATE, deliveryMinimum: ZERO, loyalty: { enabled: false, earnBasis: null, pointsPerDollar: ZERO_RATE } },
  ).deliveryFee;
}

/** D3: the minimum applies only to a closed order without a minimum override. */
export function effectiveDeliveryMinimum(status: string, hasMinimumOverride: boolean, minimum: Cents): Cents {
  return status === 'closed' && !hasMinimumOverride ? minimum : ZERO;
}

/**
 * Fee from SERVER data per source; review flags; never a 400 for a delivery reason (cash was taken).
 * Until item 5 (pos-v1-quote-delivery + pos_delivery_quotes + server geocoding) exists:
 *  - quoted   → no quote can be found: delivery_quote_unknown, priced at the snapshot's offline fee
 *               (the reference falls back to its own geocode first — no geocoder here yet);
 *  - offline  → snapshot offline fee; the reference's geocode review (delivery_fee_review /
 *               delivery_out_of_radius / server_fee_cents / unverified-by-geocode) waits for item 5;
 *  - override → snapshot offline fee; delivery_fee_mismatch when there is no radius override;
 *  - pending  → 0; delivery_fee_missing when closed.
 * delivery_unverified echoes the device's value (the reference's starting point).
 */
export function deliveryPricing(p: OrderPayload, snap: MenuSnapshot): { input: DeliveryInput; minimum: Cents; flags: DeliveryFlags } {
  const d = p.delivery;
  if (!d) throw new ServerValidation('invalid_payload', 'delivery order without delivery data', 'delivery');
  const tiers = tiersFromWire(snap.restaurant.delivery);
  const offlineFee = cents(snap.restaurant.delivery.offline_fee_cents);
  const flags: DeliveryFlags = {
    delivery_unverified: d.delivery_unverified,
    delivery_fee_review: false,
    delivery_out_of_radius: false,
    delivery_override: d.overrides.radius !== null || d.overrides.minimum !== null,
    delivery_fee_mismatch: false,
    delivery_quote_unknown: false,
    delivery_quote_expired: false,
    delivery_fee_missing: false,
    delivery_below_minimum: false,
    server_fee_cents: null,
  };
  let input: DeliveryInput;
  switch (d.fee_source) {
    case 'quoted':
      flags.delivery_quote_unknown = true; // no pos_delivery_quotes yet (item 5)
      input = deliveryInputFor('offline', { distanceMiles: null, tiers, offlineFee });
      break;
    case 'offline':
      input = deliveryInputFor('offline', { distanceMiles: null, tiers, offlineFee });
      break;
    case 'override':
      input = deliveryInputFor('override', { distanceMiles: null, tiers, offlineFee });
      if (d.overrides.radius === null) flags.delivery_fee_mismatch = true; // flat fee without its source
      break;
    case 'pending':
      input = deliveryInputFor('pending', { distanceMiles: null, tiers, offlineFee });
      if (p.status === 'closed') flags.delivery_fee_missing = true;
      break;
    default:
      throw new ServerValidation('invalid_payload', 'unknown fee_source', 'delivery.fee_source');
  }
  if (deliveryFeeOf(input) !== d.fee_cents) flags.delivery_fee_mismatch = true;
  const minimum = effectiveDeliveryMinimum(p.status, d.overrides.minimum !== null, cents(snap.restaurant.delivery.minimum_in_house_cents));
  return { input, minimum, flags };
}

// ---- the recompute -------------------------------------------------------------------------------

/**
 * §3.4: price with the vendored priceOrder against `snap`, IN-PERSON config (DEVICE-AUTH §4.3: a
 * register is always in-person — service fee 0, recoup 0; the request's pricing_config / channel are
 * stored for reporting only). Throws PricingError (→ 400 pricing_error:<code>) or ServerValidation.
 */
export function priceAgainstSnapshot(p: OrderPayload, snap: MenuSnapshot): { pricing: WireBreakdown; delivery: DeliveryFlags | null } {
  const input = buildServerInput(p, snap);
  const r = snap.restaurant;
  const delivery = p.order_type === 'delivery' ? deliveryPricing(p, snap) : null;
  const breakdown = priceOrder(
    { ...input, delivery: delivery ? delivery.input : null },
    {
      taxRate: parseRate(r.tax_rate),
      promoPercent: snap.promotion ? parseRate(snap.promotion.discount_percent) : null,
      baseServiceFee: ZERO,
      recoupRate: ZERO_RATE,
      // Delivery: never reject for the minimum (cash taken) — price with 0, flag below.
      deliveryMinimum: delivery ? ZERO : cents(r.delivery.minimum_in_house_cents),
      loyalty: { enabled: r.loyalty.enabled, earnBasis: r.loyalty.earn_basis, pointsPerDollar: parseRate(r.loyalty.points_per_dollar) },
    },
  );
  if (delivery && delivery.minimum > 0 && breakdown.netSubtotal < delivery.minimum) delivery.flags.delivery_below_minimum = true;
  return { pricing: breakdownToWire(breakdown), delivery: delivery?.flags ?? null };
}

/**
 * §3.4 step 7 (item 3): judged against the snapshot the order was priced with, at device_time, in the
 * restaurant's timezone. Active lines only; a violation flags, never 400s.
 */
export function availabilityViolation(p: OrderPayload, snap: MenuSnapshot): boolean {
  const items = new Map(snap.items.map((i) => [i.id, i]));
  const categories = new Map(snap.categories.map((c) => [c.id, c]));
  const toppings = new Map(snap.toppings.map((t) => [t.id, t]));
  const when = Date.parse(p.device_time);
  for (const l of p.lines) {
    if (l.status !== 'active') continue;
    const item = items.get(l.menu_item_id);
    if (!item) continue;
    if (!item.is_available) return true;
    const cat = categories.get(item.category_id);
    if (cat && !isCategoryAvailableAt(cat.availability, when, snap.restaurant.timezone)) return true;
    for (const m of l.modifiers) if (toppings.get(m.topping_id)?.is_available === false) return true;
  }
  return false;
}

export { PricingError };
