/**
 * pos-v1 price request: shape validation and input caps.
 *
 * The request carries IDs and customer choices only. No price, rate, fee,
 * promo, discount or distance is accepted from the caller; unknown keys are
 * rejected so a client cannot believe it set one.
 */
import { ApiError } from './errors.ts';

/** Body size cap. A 50-line, 40-modifier order is ~12 KB of JSON. */
export const MAX_BODY_BYTES = 32 * 1024;
/** Distinct cart lines. Real carts are < 15; catering orders < 30. */
export const MAX_LINES = 50;
/** Toppings + add-ons on one line. */
export const MAX_MODIFIERS_PER_LINE = 40;
/** Quantity of one line (e.g. 50 pies for a catering order). */
export const MAX_QUANTITY = 50;

export type RequestOrderType = 'pickup' | 'delivery' | 'dine_in';
export type RequestPlacement = 'whole' | 'left' | 'right';

export interface RequestModifier {
  toppingId: string;
  /** Required for pizza toppings; absent or 'whole' for add-ons. */
  placement: RequestPlacement | null;
}

export interface RequestLine {
  menuItemId: string;
  itemSizeId: string | null;
  quantity: number;
  modifiers: RequestModifier[];
}

export type RequestTip =
  | { mode: 'none' }
  /** Decimal text, e.g. "18" = 18%. */
  | { mode: 'percent'; percent: string }
  | { mode: 'amount'; amountCents: number };

export interface RequestDelivery {
  lat: number;
  lng: number;
  uberQuoteId: string | null;
  extendedZone: boolean;
}

export interface PriceRequest {
  restaurantId: string;
  orderType: RequestOrderType;
  lines: RequestLine[];
  tip: RequestTip;
  loyaltyRedemptionId: string | null;
  /** Customer session token; only needed with a redemption. Never logged. */
  sessionToken: string | null;
  delivery: RequestDelivery | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^\d{1,3}(\.\d{1,4})?$/;

function bad(message: string): never {
  throw new ApiError('invalid_request', message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) bad(`${where}: unknown field "${k}"`);
  }
}

function uuid(v: unknown, where: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) bad(`${where} must be a UUID`);
  return v.toLowerCase();
}

function optionalUuid(v: unknown, where: string): string | null {
  return v === undefined || v === null ? null : uuid(v, where);
}

function parseModifier(raw: unknown, where: string): RequestModifier {
  if (!isObject(raw)) bad(`${where} must be an object`);
  onlyKeys(raw, ['toppingId', 'placement'], where);
  const placement = raw.placement;
  if (placement !== undefined && placement !== null && placement !== 'whole' && placement !== 'left' && placement !== 'right') {
    throw new ApiError('invalid_placement', `${where}.placement must be whole, left or right`);
  }
  return { toppingId: uuid(raw.toppingId, `${where}.toppingId`), placement: (placement ?? null) as RequestPlacement | null };
}

function parseLine(raw: unknown, i: number): RequestLine {
  const where = `lines[${i}]`;
  if (!isObject(raw)) bad(`${where} must be an object`);
  onlyKeys(raw, ['menuItemId', 'itemSizeId', 'quantity', 'modifiers'], where);
  const q = raw.quantity;
  if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 1) {
    throw new ApiError('invalid_quantity', `${where}.quantity must be a positive integer`);
  }
  if (q > MAX_QUANTITY) throw new ApiError('quantity_too_large', `${where}.quantity exceeds ${MAX_QUANTITY}`);
  const mods = raw.modifiers ?? [];
  if (!Array.isArray(mods)) bad(`${where}.modifiers must be an array`);
  if (mods.length > MAX_MODIFIERS_PER_LINE) {
    throw new ApiError('too_many_modifiers', `${where} has more than ${MAX_MODIFIERS_PER_LINE} modifiers`);
  }
  return {
    menuItemId: uuid(raw.menuItemId, `${where}.menuItemId`),
    itemSizeId: optionalUuid(raw.itemSizeId, `${where}.itemSizeId`),
    quantity: q,
    modifiers: mods.map((m, j) => parseModifier(m, `${where}.modifiers[${j}]`)),
  };
}

function parseTip(raw: unknown): RequestTip {
  if (raw === undefined || raw === null) return { mode: 'none' };
  if (!isObject(raw)) throw new ApiError('invalid_tip', 'tip must be an object');
  switch (raw.mode) {
    case 'none':
      onlyKeys(raw, ['mode'], 'tip');
      return { mode: 'none' };
    case 'percent': {
      onlyKeys(raw, ['mode', 'percent'], 'tip');
      const p = typeof raw.percent === 'number' ? String(raw.percent) : raw.percent;
      if (typeof p !== 'string' || !DECIMAL.test(p)) {
        throw new ApiError('invalid_tip', 'tip.percent must be a decimal percentage, e.g. "18"');
      }
      return { mode: 'percent', percent: p };
    }
    case 'amount': {
      onlyKeys(raw, ['mode', 'amountCents'], 'tip');
      const a = raw.amountCents;
      if (typeof a !== 'number' || !Number.isSafeInteger(a) || a < 0) {
        throw new ApiError('invalid_tip', 'tip.amountCents must be a non-negative integer');
      }
      return { mode: 'amount', amountCents: a };
    }
    default:
      throw new ApiError('invalid_tip', 'tip.mode must be none, percent or amount');
  }
}

function parseDelivery(raw: unknown): RequestDelivery {
  if (!isObject(raw)) throw new ApiError('delivery_location_required', 'delivery orders need delivery.lat and delivery.lng');
  onlyKeys(raw, ['lat', 'lng', 'uberQuoteId', 'extendedZone'], 'delivery');
  const { lat, lng } = raw;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ApiError('delivery_location_required', 'delivery.lat / delivery.lng must be valid coordinates');
  }
  const q = raw.uberQuoteId;
  if (q !== undefined && q !== null && (typeof q !== 'string' || q.length === 0 || q.length > 200)) {
    bad('delivery.uberQuoteId must be a string');
  }
  if (raw.extendedZone !== undefined && typeof raw.extendedZone !== 'boolean') bad('delivery.extendedZone must be a boolean');
  return { lat, lng, uberQuoteId: (q ?? null) as string | null, extendedZone: raw.extendedZone === true };
}

/** Parse a decoded JSON body. Throws ApiError (4xx) on any problem. */
export function parsePriceRequest(body: unknown): PriceRequest {
  if (!isObject(body)) bad('body must be a JSON object');
  onlyKeys(body, ['restaurantId', 'orderType', 'lines', 'tip', 'loyaltyRedemptionId', 'sessionToken', 'delivery'], 'body');

  const orderType = body.orderType;
  if (orderType !== 'pickup' && orderType !== 'delivery' && orderType !== 'dine_in') {
    bad('orderType must be pickup or delivery');
  }
  if (!Array.isArray(body.lines)) bad('lines must be an array');
  if (body.lines.length > MAX_LINES) throw new ApiError('too_many_lines', `more than ${MAX_LINES} lines`);

  const token = body.sessionToken;
  if (token !== undefined && token !== null && (typeof token !== 'string' || token.length > 512)) {
    bad('sessionToken must be a string');
  }

  let delivery: RequestDelivery | null = null;
  if (orderType === 'delivery') delivery = parseDelivery(body.delivery);
  else if (body.delivery !== undefined && body.delivery !== null) bad(`${orderType} orders must not carry delivery`);

  return {
    restaurantId: uuid(body.restaurantId, 'restaurantId'),
    orderType,
    lines: body.lines.map(parseLine),
    tip: parseTip(body.tip),
    loyaltyRedemptionId: optionalUuid(body.loyaltyRedemptionId, 'loyaltyRedemptionId'),
    sessionToken: typeof token === 'string' && token.trim() ? token : null,
    delivery,
  };
}
