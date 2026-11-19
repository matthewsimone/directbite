/** Typed pricing failures. The module never guesses or silently clamps input. */

export type PricingErrorCode =
  | 'invalid_amount'
  | 'invalid_quantity'
  | 'invalid_rate'
  | 'invalid_tip'
  | 'invalid_reward_line'
  | 'reward_mismatch'
  | 'reward_below_minimum'
  | 'invalid_delivery'
  | 'out_of_delivery_range'
  | 'below_delivery_minimum';

export class PricingError extends Error {
  readonly code: PricingErrorCode;

  constructor(code: PricingErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PricingError';
    this.code = code;
  }
}
