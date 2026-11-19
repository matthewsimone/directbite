/**
 * Shadow pricing for create-payment-intent (pos-v1 CP4). Loaded with a
 * DYNAMIC import from inside the guarded background task (shadowGuard.ts), so
 * nothing here can affect the charge.
 *
 * For an allowlisted restaurant it:
 *  1. translates the client's order_data into the ID-only pos-v1 request
 *     (anything it cannot translate is logged `untranslatable` with the field,
 *     never guessed);
 *  2. prices it with the same loader + vendored module as pos-v1-price-order
 *     (caps reported, not enforced);
 *  3. compares the client's charged amount and components with the server's,
 *     classifies every difference, and records one row (+ a log line).
 *
 * No customer PII is recorded: no name, phone, email, address or coordinates,
 * never the session token. Ids, cents, classes and the server breakdown only.
 */
import { dollarsToCents } from '../ordr-core/money.ts';
import { priceOrder, PricingError, type PricingBreakdown } from '../ordr-core/order/index.ts';
import type { PricingDb } from './db.ts';
import { ApiError, fromPricingError } from './errors.ts';
import { loadPricingInput, type Diagnostics, type Resolved } from './loader.ts';
import { PRICING_MODULE_HASH, SOURCE_COMMIT } from './moduleInfo.ts';
import { type CapHit, parsePriceRequestReportingCaps } from './request.ts';
import { type SupabaseLike, supabasePricingDb } from './supabaseDb.ts';

export type ShadowClass =
  | 'd3_half_topping'
  | 'promo'
  | 'percent_tip'
  | 'recoup'
  | 'no_coords'
  | 'category_window'
  | 'uber_dropoff'
  | 'cap_hit'
  | 'untranslatable'
  | 'unknown';

/** Classes that can explain a money delta; the rest are policy findings. */
const PRICE_CLASSES: ReadonlySet<ShadowClass> = new Set(['d3_half_topping', 'promo', 'percent_tip', 'recoup', 'unknown']);

export type ShadowOutcome = 'compared' | 'server_rejected' | 'untranslatable' | 'no_coords';

export interface ShadowInput {
  restaurantId: string;
  /** Deep copy of order_data taken before create-payment-intent mutates it. */
  orderData: unknown;
  /** The amount actually sent to Stripe (cents, from the client). */
  clientAmount: unknown;
  sessionToken: unknown;
  paymentIntentId: string | null;
  pendingOrderId: string | null;
  path: 'create' | 'update';
}

export interface ShadowRecord {
  restaurant_id: string;
  payment_intent_id: string | null;
  pending_order_id: string | null;
  path: 'create' | 'update';
  outcome: ShadowOutcome;
  classes: ShadowClass[];
  client_amount_cents: number | null;
  server_total_cents: number | null;
  /** client − server; positive = the customer was charged more than the server price. */
  delta_cents: number | null;
  server_error_code: string | null;
  breakdown: PricingBreakdown | null;
  resolved: Resolved | null;
  detail: Record<string, unknown>;
  pricing_module_hash: string;
  source_commit: string;
}

// ---- translation: order_data → ID-only request --------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIP_PRESETS = [15, 18, 20] as const;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface Untranslatable {
  field: string;
  reason: string;
}

export interface Translation {
  body: Record<string, unknown> | null;
  untranslatable: Untranslatable[];
  noCoords: boolean;
  /** How the tip was expressed to the server. */
  tip: { mode: 'none' } | { mode: 'amount' } | { mode: 'inferred_percent'; percent: number };
  /** Index into order_data.items for each translated (non-reward) line, in order. */
  itemIndexes: number[];
}

/**
 * The web's own float formulas, used ONLY to recognise what the browser did
 * (which tip preset produced this amount). Never used to price anything.
 */
const webRound2 = (n: number) => Math.round(n * 100) / 100;

export function translateOrderData(orderData: unknown, restaurantId: string, sessionToken: unknown): Translation {
  const od: Any = orderData && typeof orderData === 'object' ? orderData : {};
  const untranslatable: Untranslatable[] = [];
  const bad = (field: string, reason: string) => untranslatable.push({ field, reason });

  const orderType = od.order_type;
  if (orderType !== 'pickup' && orderType !== 'delivery') bad('order_type', `unsupported value ${JSON.stringify(orderType)}`);

  const redemptionId = od.loyalty_redemption_id ?? null;
  if (redemptionId !== null && (typeof redemptionId !== 'string' || !UUID.test(redemptionId))) bad('loyalty_redemption_id', 'not a uuid');

  const items: Any[] = Array.isArray(od.items) ? od.items : [];
  if (!Array.isArray(od.items)) bad('items', 'not an array');
  const lines: unknown[] = [];
  const itemIndexes: number[] = [];
  items.forEach((it: Any, i: number) => {
    const f = `items[${i}]`;
    if (!it || typeof it !== 'object') return bad(f, 'not an object');
    if (it.loyalty_redemption_id) {
      // Reward line: the server synthesizes it from the redemption row.
      if (it.loyalty_redemption_id !== redemptionId) bad(`${f}.loyalty_redemption_id`, 'does not match the order redemption');
      return;
    }
    if (typeof it.menu_item_id !== 'string' || !UUID.test(it.menu_item_id)) return bad(`${f}.menu_item_id`, 'not a uuid');
    const size = it.item_size_id ?? null;
    if (size !== null && (typeof size !== 'string' || !UUID.test(size))) return bad(`${f}.item_size_id`, 'not a uuid');
    if (!Number.isSafeInteger(it.quantity) || it.quantity < 1) return bad(`${f}.quantity`, `not a positive integer: ${JSON.stringify(it.quantity)}`);
    const tops: Any[] = Array.isArray(it.toppings) ? it.toppings : [];
    const modifiers: unknown[] = [];
    for (let k = 0; k < tops.length; k++) {
      const t = tops[k];
      const tf = `${f}.toppings[${k}]`;
      if (!t || typeof t.topping_id !== 'string' || !UUID.test(t.topping_id)) return bad(`${tf}.topping_id`, 'not a uuid');
      if (t.placement_type === 'addon') {
        modifiers.push({ toppingId: t.topping_id });
      } else if (t.placement === 'whole' || t.placement === 'left' || t.placement === 'right') {
        modifiers.push({ toppingId: t.topping_id, placement: t.placement });
      } else {
        return bad(`${tf}.placement`, `unsupported value ${JSON.stringify(t.placement)}`);
      }
    }
    lines.push({ menuItemId: it.menu_item_id, itemSizeId: size, quantity: it.quantity, modifiers });
    itemIndexes.push(i);
  });

  // Tip: the client sends dollars only. Recognise a 15/18/20% preset exactly as
  // TipSelector computes it (on the client's post-promo subtotal); otherwise
  // pass the amount through.
  let tip: Translation['tip'] = { mode: 'none' };
  let tipBody: unknown = { mode: 'none' };
  const tipRaw = od.tip_amount ?? 0;
  if (typeof tipRaw !== 'number' && typeof tipRaw !== 'string') {
    bad('tip_amount', 'not a number');
  } else {
    let tipCents: number | null = null;
    try {
      tipCents = dollarsToCents(tipRaw);
    } catch {
      bad('tip_amount', `not whole cents: ${JSON.stringify(tipRaw)}`);
    }
    if (tipCents !== null && tipCents > 0) {
      const discounted = Number(od.subtotal ?? 0) - Number(od.discount_amount ?? 0);
      const preset = TIP_PRESETS.find((p) => webRound2(discounted * (p / 100)) === Number(tipRaw));
      if (preset !== undefined) {
        tip = { mode: 'inferred_percent', percent: preset };
        tipBody = { mode: 'percent', percent: String(preset) };
      } else {
        tip = { mode: 'amount' };
        tipBody = { mode: 'amount', amountCents: tipCents };
      }
    }
  }

  let delivery: unknown = undefined;
  let noCoords = false;
  if (orderType === 'delivery') {
    const lat = od.dropoff_lat, lng = od.dropoff_lng;
    const quote = typeof od.uber_quote_id === 'string' && od.uber_quote_id ? od.uber_quote_id : null;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      if (quote) bad('dropoff_lat', 'uber order without coordinates');
      else noCoords = true; // in-house delivery without coords: own class
    } else {
      delivery = { lat, lng, ...(quote ? { uberQuoteId: quote } : {}), ...(od.extended_zone === true ? { extendedZone: true } : {}) };
    }
  }

  const body = untranslatable.length || noCoords ? null : {
    restaurantId,
    orderType,
    lines,
    tip: tipBody,
    ...(redemptionId ? { loyaltyRedemptionId: redemptionId } : {}),
    ...(typeof sessionToken === 'string' && sessionToken ? { sessionToken } : {}),
    ...(delivery ? { delivery } : {}),
  };
  return { body, untranslatable, noCoords, tip, itemIndexes };
}

// ---- classification -------------------------------------------------------------------------

/**
 * Client dollar fields → cents FOR COMPARISON ONLY (never priced). Exact via
 * the money boundary when the value has ≤ 2 decimals; the web's unrounded
 * float sums (D1, e.g. 34.970000000000006) are rounded to the nearest cent and
 * the field is listed in `floatNoise`.
 */
function clientCents(value: unknown, field: string, floatNoise: string[]): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') {
    floatNoise.push(field);
    return 0;
  }
  try {
    return dollarsToCents(value);
  } catch {
    floatNoise.push(field);
    return Math.round(Number(value) * 100); // comparison only: web float dollars
  }
}

interface Classified {
  classes: ShadowClass[];
  detail: Record<string, unknown>;
}

export function classify(
  od: Any,
  clientAmount: number | null,
  b: PricingBreakdown,
  resolved: Resolved,
  diagnostics: Diagnostics,
  translation: Translation,
  capHits: CapHit[],
): Classified {
  const classes = new Set<ShadowClass>();
  const floatNoise: string[] = [];
  const diffs: Record<string, { client: number; server: number; note?: string }> = {};
  const c = (field: string) => clientCents(od?.[field], field, floatNoise);

  // Lines and modifiers
  let lineDelta = false;
  translation.itemIndexes.forEach((itemIndex, j) => {
    const it = od.items[itemIndex];
    const server = b.lines[j];
    const rl = resolved.lines[j];
    const base = clientCents(it.base_price, `items[${itemIndex}].base_price`, floatNoise);
    const serverBase = server.unit - server.modifiers.reduce((s, m) => s + m.charge, 0);
    if (base !== serverBase) {
      lineDelta = true;
      classes.add('unknown');
      diffs[`items[${itemIndex}].base_price`] = { client: base, server: serverBase, note: 'base price differs (stale menu?)' };
    }
    (it.toppings ?? []).forEach((t: Any, k: number) => {
      const cl = clientCents(t.price_charged, `items[${itemIndex}].toppings[${k}].price_charged`, floatNoise);
      const sv = server.modifiers[k]?.charge;
      if (sv === undefined || cl === sv) return;
      lineDelta = true;
      const mod = rl.modifiers[k];
      const d3 = mod?.kind === 'pizza' && mod.placement !== 'whole' && Math.abs(cl - sv) === 1;
      classes.add(d3 ? 'd3_half_topping' : 'unknown');
      diffs[`items[${itemIndex}].toppings[${k}].price_charged`] = { client: cl, server: sv, note: d3 ? 'D3 float half' : 'topping charge differs' };
    });
  });

  const sub = c('subtotal'), disc = c('discount_amount'), deliv = c('delivery_fee'), tax = c('tax_amount');
  const tip = c('tip_amount'), svc = c('service_fee'), recoup = c('recoup_amount'), total = c('total_amount');
  if (sub !== b.subtotal) diffs.subtotal = { client: sub, server: b.subtotal };

  // Promo: a different percentage = selection / date (D14); same percentage = rounding (unless lines differ).
  const clientPct = Number(od.discount_percentage ?? 0);
  const serverPct = b.rates.promoPercent === null ? 0 : Number(b.rates.promoPercent);
  if (clientPct !== serverPct) {
    classes.add('promo');
    diffs.discount_percentage = { client: clientPct, server: serverPct, note: 'promo selection / local date (D14)' };
  }
  if (disc !== b.promoDiscount) {
    diffs.discount_amount = { client: disc, server: b.promoDiscount };
    if (clientPct === serverPct && !lineDelta) classes.add('promo');
  }

  // Tip: only a recognised preset can differ (an amount is passed through).
  if (tip !== b.tip) {
    diffs.tip_amount = { client: tip, server: b.tip };
    const sameBase = sub - disc === b.discountedSubtotal;
    if (translation.tip.mode === 'inferred_percent' && sameBase) classes.add('percent_tip');
    else if (translation.tip.mode !== 'inferred_percent') classes.add('unknown');
  }

  // Delivery fee
  if (deliv !== b.deliveryFee) {
    classes.add('unknown');
    diffs.delivery_fee = { client: deliv, server: b.deliveryFee, note: 'delivery fee differs' };
  }

  // Recoup: same base → rounding (R4); different base → follows another delta.
  const clientNet = Math.max(0, sub - disc - b.loyaltyDiscountFace);
  if (recoup !== b.recoup) {
    diffs.recoup_amount = { client: recoup, server: b.recoup };
    const clientBase = clientNet + deliv + tip + 150;
    const serverBase = b.netSubtotal + b.deliveryFee + b.tip + 150;
    if (clientBase === serverBase) classes.add('recoup');
  }
  if (svc !== b.serviceFee) {
    diffs.service_fee = { client: svc, server: b.serviceFee };
    if (svc - recoup !== b.serviceFee - b.recoup) classes.add('unknown');
  }

  // Tax: same taxable → rounding (no class of its own: unknown, noted); else follows.
  if (tax !== b.tax) {
    diffs.tax_amount = { client: tax, server: b.tax };
    if (clientNet + deliv + svc === b.taxable) {
      classes.add('unknown');
      diffs.tax_amount.note = 'tax rounding on equal taxable (D2)';
    }
  }

  // Policy findings (do not explain money)
  if (diagnostics.categoryWindow.length) classes.add('category_window');
  if (diagnostics.uberDropoff) classes.add('uber_dropoff');
  if (capHits.length) classes.add('cap_hit');

  const delta = clientAmount === null ? null : clientAmount - b.total;
  if (delta !== null && delta !== 0 && ![...classes].some((k) => PRICE_CLASSES.has(k))) {
    classes.add('unknown');
    diffs.total = { client: clientAmount!, server: b.total, note: 'unexplained' };
  }

  return {
    classes: [...classes].sort(),
    detail: {
      diffs,
      ...(floatNoise.length ? { float_noise: floatNoise } : {}),
      ...(clientAmount !== null && total !== clientAmount ? { amount_vs_total_amount: { amount: clientAmount, total_amount_cents: total } } : {}),
      tip: translation.tip,
      ...(diagnostics.categoryWindow.length ? { category_window: diagnostics.categoryWindow } : {}),
      ...(diagnostics.uberDropoff ? { uber_dropoff: diagnostics.uberDropoff } : {}),
      ...(capHits.length ? { cap_hits: capHits } : {}),
    },
  };
}

// ---- compute + record -------------------------------------------------------------------------

export async function computeShadow(db: PricingDb, input: ShadowInput, now: Date): Promise<ShadowRecord> {
  const clientAmount = Number.isSafeInteger(input.clientAmount) ? (input.clientAmount as number) : null;
  const base: ShadowRecord = {
    restaurant_id: input.restaurantId,
    payment_intent_id: input.paymentIntentId,
    pending_order_id: input.pendingOrderId,
    path: input.path,
    outcome: 'compared',
    classes: [],
    client_amount_cents: clientAmount,
    server_total_cents: null,
    delta_cents: null,
    server_error_code: null,
    breakdown: null,
    resolved: null,
    detail: clientAmount === null ? { client_amount_raw: String(input.clientAmount).slice(0, 40) } : {},
    pricing_module_hash: PRICING_MODULE_HASH,
    source_commit: SOURCE_COMMIT,
  };

  const translation = translateOrderData(input.orderData, input.restaurantId, input.sessionToken);
  if (translation.untranslatable.length) {
    return { ...base, outcome: 'untranslatable', classes: ['untranslatable'], detail: { ...base.detail, untranslatable: translation.untranslatable } };
  }
  if (translation.noCoords) {
    return { ...base, outcome: 'no_coords', classes: ['no_coords'], detail: { ...base.detail, note: 'in-house delivery without dropoff coordinates; enforcement would reject' } };
  }

  try {
    const { req, capHits } = parsePriceRequestReportingCaps(translation.body);
    const loaded = await loadPricingInput(db, req, { channel: 'online', now });
    const breakdown = priceOrder(loaded.order, loaded.config);
    const { classes, detail } = classify(input.orderData, clientAmount, breakdown, loaded.resolved, loaded.diagnostics, translation, capHits);
    return {
      ...base,
      classes,
      server_total_cents: breakdown.total,
      delta_cents: clientAmount === null ? null : clientAmount - breakdown.total,
      breakdown,
      resolved: loaded.resolved,
      detail: { ...base.detail, ...detail },
    };
  } catch (err) {
    const api = err instanceof ApiError ? err : err instanceof PricingError ? fromPricingError(err) : null;
    if (!api) throw err;
    // The client was charged; the server would have refused this order.
    return {
      ...base,
      outcome: 'server_rejected',
      classes: ['unknown'],
      server_error_code: api.code,
      detail: { ...base.detail, server_error: api.detail ?? api.message },
    };
  }
}

/** Entry point used by create-payment-intent's background task. */
export async function runShadow(
  client: SupabaseLike,
  input: ShadowInput,
  log: (event: string, data: Record<string, unknown>) => void,
  db: PricingDb = supabasePricingDb(client),
): Promise<void> {
  const record = await computeShadow(db, input, new Date());
  log('shadow result', record as unknown as Record<string, unknown>);
  const { error } = await client.from('pricing_shadow_log').insert(record);
  if (error) log('shadow insert failed', { error: error.message, payment_intent_id: input.paymentIntentId });
}
