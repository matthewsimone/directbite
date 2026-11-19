/**
 * Order pricing. Implements docs/PRICING-SPEC.md (approved 2026-11-19) step by
 * step. Pure TypeScript, relative `.ts` imports only, no I/O or clock, so the
 * Deno `pos-v1` pricing function imports this file unchanged.
 *
 * All money math goes through src/core/money (integer cents; rates applied
 * exactly, half away from zero). The POS is the correct reference; the web's
 * floating-point behavior is deliberately not replicated.
 */
import {
  addCents,
  applyRate,
  compareRate,
  floorDollarsTimesRate,
  fromPercent,
  maxCents,
  minRate,
  multiplyCents,
  parseRate,
  rateToString,
  subtractCents,
  sumCents,
  ZERO,
  ZERO_RATE,
  type Cents,
  type Rate,
} from '../money.ts';
import { PricingError } from './errors.ts';
import { toppingCharge } from './toppings.ts';
import type {
  DeliveryInput,
  Line,
  OrderInput,
  PricedLine,
  PricingBreakdown,
  Redemption,
  RestaurantPricingConfig,
  TipInput,
} from './types.ts';

const RECOUP_CAP: Rate = parseRate('0.10');

// ---- Input validation -------------------------------------------------------

function requireCents(value: Cents | null | undefined, field: string, { allowNull = false } = {}): void {
  if (value === null || value === undefined) {
    if (allowNull) return;
    throw new PricingError('invalid_amount', `${field} is required`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingError('invalid_amount', `${field} must be a non-negative integer of cents, got ${value}`);
  }
}

function requireRateInRange(rate: Rate, field: string, min: string, max: string, maxExclusive = false): void {
  const belowMin = compareRate(rate, min) < 0;
  const aboveMax = maxExclusive ? compareRate(rate, max) >= 0 : compareRate(rate, max) > 0;
  if (belowMin || aboveMax) {
    throw new PricingError(
      'invalid_rate',
      `${field} must be ${min} to ${max}${maxExclusive ? ' (exclusive)' : ''}, got ${rateToString(rate)}`,
    );
  }
}

function validateLine(line: Line, index: number): void {
  const where = `lines[${index}]`;
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
    throw new PricingError('invalid_quantity', `${where}.quantity must be a positive integer, got ${line.quantity}`);
  }
  requireCents(line.basePrice, `${where}.basePrice`);
  line.modifiers.forEach((m, j) => {
    if (m.kind === 'addon') {
      requireCents(m.price, `${where}.modifiers[${j}].price`);
    } else {
      requireCents(m.topping.price, `${where}.modifiers[${j}].topping.price`);
      requireCents(m.topping.priceHalf, `${where}.modifiers[${j}].topping.priceHalf`, { allowNull: true });
      for (const [key, entry] of Object.entries(m.topping.sizePrices ?? {})) {
        requireCents(entry.price, `${where}.modifiers[${j}].sizePrices.${key}.price`, { allowNull: true });
        requireCents(entry.half, `${where}.modifiers[${j}].sizePrices.${key}.half`, { allowNull: true });
      }
    }
  });
  if (line.reward !== null) {
    if (line.basePrice !== 0 || line.modifiers.length > 0) {
      throw new PricingError('invalid_reward_line', `${where} is a reward line and must be $0 with no modifiers`);
    }
  }
}

function validateRewards(order: OrderInput): void {
  const rewardLines = order.lines.filter((l) => l.reward !== null);
  const redemption = order.loyaltyRedemption;
  if (rewardLines.length > 1) {
    throw new PricingError('reward_mismatch', 'at most one reward line per order');
  }
  const rewardLine = rewardLines[0];
  if (rewardLine && (!redemption || redemption.kind !== rewardLine.reward)) {
    throw new PricingError('reward_mismatch', `reward line (${rewardLine.reward}) has no matching redemption`);
  }
  if (!redemption) return;
  if (redemption.kind === 'item' && !rewardLine) {
    throw new PricingError('reward_mismatch', 'item redemption needs its $0 reward line');
  }
  requireCents(redemption.minSubtotal, 'loyaltyRedemption.minSubtotal');
  if (redemption.kind === 'discount') {
    requireCents(redemption.discountCents, 'loyaltyRedemption.discountCents');
    if (redemption.discountCents === 0) {
      throw new PricingError('invalid_amount', 'loyaltyRedemption.discountCents must be > 0');
    }
  }
}

function validateConfig(config: RestaurantPricingConfig): void {
  requireRateInRange(config.taxRate, 'taxRate', '0', '1', true);
  if (config.promoPercent !== null) requireRateInRange(config.promoPercent, 'promoPercent', '0', '100');
  requireCents(config.baseServiceFee, 'baseServiceFee');
  requireCents(config.deliveryMinimum, 'deliveryMinimum');
  if (compareRate(config.loyalty.pointsPerDollar, '0') < 0) {
    throw new PricingError('invalid_rate', 'loyalty.pointsPerDollar must be >= 0');
  }
}

// ---- Steps ------------------------------------------------------------------

/** Step 1: line amounts. */
function priceLine(line: Line): PricedLine {
  const modifiers = line.modifiers.map((m) => ({
    charge: m.kind === 'addon' ? m.price : toppingCharge(m.topping, line.sizeName, m.placement),
  }));
  const unit = addCents(line.basePrice, sumCents(modifiers.map((m) => m.charge)));
  return { unit, quantity: line.quantity, lineTotal: multiplyCents(unit, line.quantity), modifiers };
}

/** Step 5: delivery fee (0 unless a delivery order). */
function deliveryFeeFor(order: OrderInput): Cents {
  const delivery: DeliveryInput | null = order.delivery;
  if (order.orderType !== 'delivery') {
    if (delivery !== null) throw new PricingError('invalid_delivery', `${order.orderType} order must not carry delivery`);
    return ZERO;
  }
  if (delivery === null) throw new PricingError('invalid_delivery', 'delivery order needs delivery input');
  if (delivery.mode === 'uber_direct') {
    requireCents(delivery.customerFee, 'delivery.customerFee');
    return delivery.customerFee;
  }
  const { distanceMiles, tiers } = delivery;
  if (!Number.isFinite(distanceMiles) || distanceMiles < 0) {
    throw new PricingError('invalid_delivery', `distanceMiles must be a finite number >= 0, got ${distanceMiles}`);
  }
  requireCents(tiers.tier1Fee, 'delivery.tiers.tier1Fee', { allowNull: true });
  requireCents(tiers.tier2Fee, 'delivery.tiers.tier2Fee', { allowNull: true });
  if (!tiers.maxRadiusMiles || distanceMiles > tiers.maxRadiusMiles) {
    throw new PricingError('out_of_delivery_range', `${distanceMiles} mi exceeds radius ${tiers.maxRadiusMiles ?? 'unset'}`);
  }
  if (tiers.tier1MaxMiles && distanceMiles > tiers.tier1MaxMiles) {
    return tiers.tier2Fee ?? tiers.tier1Fee ?? ZERO;
  }
  return tiers.tier1Fee ?? ZERO;
}

/** Step 6: tip. Percent base = post-promo, pre-reward subtotal. */
function tipFor(tip: TipInput, discountedSubtotal: Cents): Cents {
  switch (tip.mode) {
    case 'none':
      return ZERO;
    case 'amount':
      if (!Number.isSafeInteger(tip.amount) || tip.amount < 0) {
        throw new PricingError('invalid_tip', `tip amount must be non-negative cents, got ${tip.amount}`);
      }
      return tip.amount;
    case 'percent':
      if (compareRate(tip.percent, '0') < 0 || compareRate(tip.percent, '100') > 0) {
        throw new PricingError('invalid_tip', `tip percent must be 0 to 100, got ${rateToString(tip.percent)}`);
      }
      return applyRate(discountedSubtotal, fromPercent(tip.percent)); // R3
  }
}

/** Effective recoup rate: <= 0 is off; capped at 0.10. */
function effectiveRecoupRate(rate: Rate): Rate {
  return compareRate(rate, '0') <= 0 ? ZERO_RATE : minRate(rate, RECOUP_CAP);
}

/** Step 11: loyalty earn preview (base points only; server awards real points). */
function loyaltyEarn(
  config: RestaurantPricingConfig,
  amounts: { subtotal: Cents; promoDiscount: Cents; total: Cents; loyaltyDiscountFace: Cents },
): { basisCents: Cents; basePoints: number } {
  if (!config.loyalty.enabled) return { basisCents: ZERO, basePoints: 0 };
  let basis: Cents;
  switch (config.loyalty.earnBasis) {
    case 'subtotal_less_discount':
      basis = maxCents(subtractCents(amounts.subtotal, amounts.promoDiscount), ZERO);
      break;
    case 'total':
      basis = amounts.total;
      break;
    default:
      basis = amounts.subtotal;
  }
  const basisCents = maxCents(subtractCents(basis, amounts.loyaltyDiscountFace), ZERO);
  return { basisCents, basePoints: floorDollarsTimesRate(basisCents, config.loyalty.pointsPerDollar) };
}

// ---- Entry point ------------------------------------------------------------

/** Price an order. Throws PricingError on invalid input or a failed rule. */
export function priceOrder(order: OrderInput, config: RestaurantPricingConfig): PricingBreakdown {
  validateConfig(config);
  order.lines.forEach(validateLine);
  validateRewards(order);

  // Step 1 — lines
  const lines = order.lines.map(priceLine);

  // Step 2 — subtotals
  const subtotal = sumCents(lines.map((l) => l.lineTotal));
  const discountableSubtotal = sumCents(
    lines.filter((_, i) => !order.lines[i].discountExempt && order.lines[i].reward === null).map((l) => l.lineTotal),
  );

  // Step 3 — promotion, once on the aggregate (R2)
  const promoDiscount = config.promoPercent === null ? ZERO : applyRate(discountableSubtotal, fromPercent(config.promoPercent));
  const discountedSubtotal = subtractCents(subtotal, promoDiscount);

  // Step 4 — loyalty discount reward
  const redemption: Redemption | null = order.loyaltyRedemption;
  if (redemption && discountedSubtotal < redemption.minSubtotal) {
    throw new PricingError(
      'reward_below_minimum',
      `subtotal after promo ${discountedSubtotal} < reward minimum ${redemption.minSubtotal}`,
    );
  }
  const loyaltyDiscountFace = redemption?.kind === 'discount' && redemption.discountCents !== null ? redemption.discountCents : ZERO;
  const netSubtotal = maxCents(subtractCents(discountedSubtotal, loyaltyDiscountFace), ZERO);
  const loyaltyDiscountApplied = subtractCents(discountedSubtotal, netSubtotal);

  // Step 5 — delivery fee + minimum
  const deliveryFee = deliveryFeeFor(order);
  if (order.orderType === 'delivery' && config.deliveryMinimum > 0 && netSubtotal < config.deliveryMinimum) {
    throw new PricingError('below_delivery_minimum', `net subtotal ${netSubtotal} < minimum ${config.deliveryMinimum}`);
  }

  // Step 6 — tip (before service fee: the recoup base includes it)
  const tip = tipFor(order.tip, discountedSubtotal);

  // Step 7 — service fee (R4)
  const recoupRate = effectiveRecoupRate(config.recoupRate);
  const recoupBase = sumCents([netSubtotal, deliveryFee, tip, config.baseServiceFee]);
  const recoup = applyRate(recoupBase, recoupRate);
  const serviceFee = addCents(config.baseServiceFee, recoup);

  // Step 8 — tax, once on the taxable total (R5)
  const taxable = sumCents([netSubtotal, deliveryFee, serviceFee]);
  const tax = applyRate(taxable, config.taxRate);

  // Step 9 — total
  const total = sumCents([netSubtotal, deliveryFee, serviceFee, tax, tip]);

  // Step 11 — loyalty earn preview
  const earn = loyaltyEarn(config, { subtotal, promoDiscount, total, loyaltyDiscountFace });

  return {
    lines,
    subtotal,
    discountableSubtotal,
    promoDiscount,
    discountedSubtotal,
    loyaltyDiscountFace,
    loyaltyDiscountApplied,
    netSubtotal,
    deliveryFee,
    tip,
    recoup,
    serviceFee,
    taxable,
    tax,
    total,
    loyaltyEarn: earn,
    rates: {
      promoPercent: config.promoPercent === null ? null : rateToString(config.promoPercent),
      recoupRate: rateToString(recoupRate),
      taxRate: rateToString(config.taxRate),
    },
  };
}
