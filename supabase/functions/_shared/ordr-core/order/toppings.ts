/**
 * Topping charge for a size and placement. PRICING-SPEC §3 step 1.
 * Integer-cents port of the web's getToppingPrices rules (not its float math).
 */
import { halfOf, type Cents } from '../money.ts';
import type { Placement, ToppingPricing } from './types.ts';

/** Trim, lowercase, collapse inner whitespace. null/'' -> ''. */
export function normalizeSizeKey(name: string | null | undefined): string {
  if (name === null || name === undefined) return '';
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** { whole, half } for this topping at this size. */
export function toppingPrices(topping: ToppingPricing, sizeName: string | null): { whole: Cents; half: Cents } {
  const key = normalizeSizeKey(sizeName);
  const entry = key && topping.sizePrices && Object.prototype.hasOwnProperty.call(topping.sizePrices, key)
    ? topping.sizePrices[key]
    : undefined;
  const sizePrice = entry?.price ?? null;
  const sizeHalf = entry?.half ?? null;

  const whole = sizePrice ?? topping.price;

  let half: Cents;
  if (sizeHalf !== null) half = sizeHalf; // a. per-size half (0 = free)
  else if (sizePrice !== null) half = halfOf(sizePrice); // b. per-size price / 2
  else if (topping.priceHalf !== null) half = topping.priceHalf; // c. price_half (0 = free)
  else half = halfOf(topping.price); // d. price / 2

  return { whole, half };
}

export function toppingCharge(topping: ToppingPricing, sizeName: string | null, placement: Placement): Cents {
  const { whole, half } = toppingPrices(topping, sizeName);
  return placement === 'whole' ? whole : half;
}
