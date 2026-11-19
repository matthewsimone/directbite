/**
 * pos-v1 API errors. Every code has exactly one HTTP status.
 *
 * Responses are `{ code, message }`. For 4xx the message explains the
 * problem to the caller. For 5xx the message is generic; details (DB errors,
 * which column was bad) go to the log only, never to the response.
 */
import { PricingError, type PricingErrorCode } from '../ordr-core/order/index.ts';

export const API_ERROR_STATUS = {
  // 400 — malformed or out-of-policy request
  invalid_request: 400,
  unsupported_api_version: 400,
  request_too_large: 400,
  too_many_lines: 400,
  too_many_modifiers: 400,
  quantity_too_large: 400,
  invalid_quantity: 400,
  invalid_tip: 400,
  invalid_placement: 400,
  duplicate_modifier: 400,
  unsupported_order_type: 400,
  delivery_location_required: 400,
  item_not_found: 400,
  size_not_found: 400,
  topping_not_allowed: 400,
  // 403 — the caller may not use this redemption
  redemption_requires_signin: 403,
  redemption_not_yours: 403,
  origin_not_allowed: 403,
  // 404
  restaurant_not_found: 404,
  // 405
  method_not_allowed: 405,
  // 409 — state conflict: re-fetch the menu / quote / reward and retry
  item_unavailable: 409,
  redemption_not_found: 409,
  redemption_wrong_restaurant: 409,
  redemption_not_pending: 409,
  redemption_expired: 409,
  quote_required: 409,
  quote_not_found: 409,
  quote_wrong_restaurant: 409,
  quote_expired: 409,
  quote_passthrough_changed: 409,
  // 422 — a pricing rule rejects this order
  reward_below_minimum: 422,
  below_delivery_minimum: 422,
  out_of_delivery_range: 422,
  // 500 — our problem; generic message
  pricing_config_invalid: 500,
  internal_error: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

const GENERIC_500: Record<'pricing_config_invalid' | 'internal_error', string> = {
  pricing_config_invalid: 'Pricing is temporarily unavailable for this restaurant.',
  internal_error: 'Something went wrong while pricing this order. Please try again.',
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Log-only detail. Never sent to the caller. */
  readonly detail: string | undefined;

  constructor(code: ApiErrorCode, message: string, detail?: string) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.detail = detail;
  }

  /** The response body: generic for 5xx. */
  toBody(): { code: ApiErrorCode; message: string } {
    if (this.code === 'pricing_config_invalid' || this.code === 'internal_error') {
      return { code: this.code, message: GENERIC_500[this.code] };
    }
    return { code: this.code, message: this.message.slice(this.code.length + 2) };
  }
}

/**
 * Map a PricingError from the vendored module to an API error.
 *
 * Client-caused (the client supplies quantity and tip) and business-rule codes
 * pass through. Everything else can only come from values the SERVER built —
 * DB prices and rates, the synthesized reward line, the delivery input — so
 * it is a 500, not the caller's fault.
 */
const PRICING_ERROR_MAP: Record<PricingErrorCode, ApiErrorCode> = {
  invalid_quantity: 'invalid_quantity',
  invalid_tip: 'invalid_tip',
  reward_below_minimum: 'reward_below_minimum',
  below_delivery_minimum: 'below_delivery_minimum',
  out_of_delivery_range: 'out_of_delivery_range',
  invalid_amount: 'pricing_config_invalid',
  invalid_rate: 'pricing_config_invalid',
  invalid_reward_line: 'internal_error',
  reward_mismatch: 'internal_error',
  invalid_delivery: 'internal_error',
};

export function fromPricingError(err: PricingError): ApiError {
  const code = PRICING_ERROR_MAP[err.code];
  const message = err.message.startsWith(`${err.code}: `) ? err.message.slice(err.code.length + 2) : err.message;
  return new ApiError(code, message, `PricingError ${err.code}: ${message}`);
}

/** Config errors: a DB value the pricing module cannot accept. */
export function configError(detail: string): ApiError {
  return new ApiError('pricing_config_invalid', 'restaurant pricing configuration is invalid', detail);
}
