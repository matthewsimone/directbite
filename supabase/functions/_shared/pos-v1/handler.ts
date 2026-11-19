/**
 * pos-v1-price-order core: a stateless quote. No writes.
 *
 * Transport-free so it can be tested with fixture rows: takes the method,
 * headers and raw body, returns { status, body }. CORS and Deno.serve live in
 * the function's index.ts.
 */
import { priceOrder, PricingError, type PricingBreakdown } from '../ordr-core/order/index.ts';
import type { PricingDb } from './db.ts';
import { ApiError, fromPricingError } from './errors.ts';
import { loadPricingInput, type Channel, type Resolved } from './loader.ts';
import { pricingModuleHash, SOURCE_COMMIT } from './moduleInfo.ts';
import { MAX_BODY_BYTES, parsePriceRequest } from './request.ts';

export const API_VERSION = 1;
export const API_VERSION_HEADER = 'x-ordr-api-version';

export interface QuoteResponse {
  apiVersion: typeof API_VERSION;
  pricingModuleHash: string;
  sourceCommit: string;
  breakdown: PricingBreakdown;
  resolved: Resolved;
}

export interface HandlerInput {
  method: string;
  headers: Headers;
  bodyText: string;
}

export interface HandlerDeps {
  db: PricingDb;
  now: () => Date;
  /** Caller identity → channel. The web checkout is 'online'. */
  channel: Channel;
  /** Structured log sink (console.error in production). */
  log: (event: string, data: Record<string, unknown>) => void;
}

export interface HandlerResult {
  status: number;
  body: QuoteResponse | { code: string; message: string };
}

function errorResult(err: ApiError, deps: HandlerDeps, ctx: Record<string, unknown>): HandlerResult {
  if (err.status >= 500 || err.detail) {
    deps.log('pos-v1-price-order error', { code: err.code, status: err.status, detail: err.detail ?? err.message, ...ctx });
  }
  return { status: err.status, body: err.toBody() };
}

export async function handlePriceRequest(input: HandlerInput, deps: HandlerDeps): Promise<HandlerResult> {
  const ctx: Record<string, unknown> = {};
  try {
    if (input.method !== 'POST') throw new ApiError('method_not_allowed', 'use POST');

    const version = input.headers.get(API_VERSION_HEADER);
    if (version !== String(API_VERSION)) {
      throw new ApiError('unsupported_api_version', `${API_VERSION_HEADER} must be ${API_VERSION}`);
    }

    if (new TextEncoder().encode(input.bodyText).length > MAX_BODY_BYTES) {
      throw new ApiError('request_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    let json: unknown;
    try {
      json = JSON.parse(input.bodyText);
    } catch {
      throw new ApiError('invalid_request', 'body is not valid JSON');
    }

    const req = parsePriceRequest(json);
    ctx.restaurant_id = req.restaurantId; // never the session token
    const loaded = await loadPricingInput(deps.db, req, { channel: deps.channel, now: deps.now() });
    const breakdown = priceOrder(loaded.order, loaded.config);

    return {
      status: 200,
      body: {
        apiVersion: API_VERSION,
        pricingModuleHash: await pricingModuleHash(),
        sourceCommit: SOURCE_COMMIT,
        breakdown,
        resolved: loaded.resolved,
      },
    };
  } catch (err) {
    if (err instanceof ApiError) return errorResult(err, deps, ctx);
    if (err instanceof PricingError) return errorResult(fromPricingError(err), deps, ctx);
    deps.log('pos-v1-price-order unexpected error', { message: (err as Error)?.message ?? String(err), ...ctx });
    return { status: 500, body: new ApiError('internal_error', 'internal error').toBody() };
  }
}
