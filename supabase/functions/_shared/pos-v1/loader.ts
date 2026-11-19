/**
 * pos-v1 loader: request IDs + DB rows → OrderInput + RestaurantPricingConfig
 * for the vendored pricing module (_shared/ordr-core, PRICING-SPEC).
 *
 * Everything money-related comes from the DB: prices, rates, fees, promo,
 * redemption, Uber quote, and the delivery distance (computed here from
 * coordinates). Dollars become cents only through ordr-core's money boundary
 * (`dollarsToCents`, which throws on > 2 decimals); rates only through
 * `parseRate`. A DB value either function rejects is `pricing_config_invalid`.
 *
 * Availability is decided here, not in the module (PRICING-SPEC §1.6): which
 * promo is active today (restaurant-local date), whether a redemption is
 * still the caller's and pending, whether items are available, which delivery
 * mode applies.
 */
import {
  cents,
  compareRate,
  compareRates,
  dollarsToCents,
  parseRate,
  ZERO_RATE,
  type Cents,
  type Rate,
} from '../ordr-core/money.ts';
import type {
  DeliveryInput,
  Line,
  Modifier,
  OrderInput,
  Redemption,
  RestaurantPricingConfig,
  SizePrice,
  TipInput,
  ToppingPricing,
} from '../ordr-core/order/index.ts';
import { resolveMode, type RestaurantForMode } from '../uberMode.ts';
import { applyPassthrough } from '../uberPassthrough.ts';
import { isCategoryAvailableAt } from './categoryWindow.ts';
import type { PricingDb, PromotionRow, RestaurantRow, ToppingRow } from './db.ts';
import { ApiError, configError } from './errors.ts';
import type { PriceRequest, RequestTip } from './request.ts';

/**
 * Who is ordering, derived server-side from caller identity — NEVER a request
 * field. Web checkout = online. POS device auth = in_person (not wired yet).
 */
export type Channel = 'online' | 'in_person';

/** PRICING-SPEC Q1: the $1.50 + recoup is the online wedge only. */
const CHANNEL_POLICY: Record<Channel, { baseServiceFee: Cents; recoup: boolean; orderTypes: readonly string[] }> = {
  online: { baseServiceFee: cents(150), recoup: true, orderTypes: ['pickup', 'delivery'] },
  in_person: { baseServiceFee: cents(0), recoup: false, orderTypes: ['pickup', 'delivery', 'dine_in'] },
};

/** Uber quotes this close to expiry are refused (same buffer as create-payment-intent). */
const QUOTE_EXPIRY_BUFFER_MS = 60 * 1000;
/**
 * How far the request's delivery coordinates may sit from the cached Uber
 * quote's dropoff before it counts as a different address. The quote stores
 * the exact coordinates the checkout sent, so the same address re-selected
 * matches to ~0; 0.05 mi (~80 m, about one building lot) absorbs geocoder
 * jitter between two Places lookups of the same address while catching a
 * changed address. Diagnostic only for now (shadow class `uber_dropoff`);
 * enforcement will reject.
 */
export const UBER_DROPOFF_TOLERANCE_MILES = 0.05;
/** Default extended-zone radius when uber_max_radius_miles is null (create-payment-intent parity). */
const DEFAULT_UBER_MAX_RADIUS_MILES = 10;

export interface LoadContext {
  channel: Channel;
  now: Date;
}

export interface ResolvedModifier {
  toppingId: string;
  kind: 'pizza' | 'addon';
  placement: 'whole' | 'left' | 'right';
}

export interface ResolvedLine {
  menuItemId: string | null;
  itemSizeId: string | null;
  sizeName: string | null;
  quantity: number;
  discountExempt: boolean;
  reward: 'item' | 'discount' | null;
  modifiers: ResolvedModifier[];
}

/** What the server decided, returned with the breakdown (no restaurant row data). */
export interface Resolved {
  channel: Channel;
  restaurantId: string;
  orderType: OrderInput['orderType'];
  /** Restaurant-local date used for the promo. */
  localDate: string;
  promotionId: string | null;
  deliveryMode: 'in_house' | 'uber_direct' | null;
  /** Display only (rounded to 0.01 mi); fee tiers use the exact value. */
  distanceMiles: number | null;
  uberQuoteId: string | null;
  redemption: { id: string; kind: 'item' | 'discount' } | null;
  /** Same order as breakdown.lines; the reward line (if any) is last. */
  lines: ResolvedLine[];
}

/**
 * Policy findings that do NOT change the price and do not reject (yet). Never
 * returned by the public endpoint; shadow mode logs them as their own classes.
 */
export interface Diagnostics {
  /** Lines whose category is outside its availability window at quote time. */
  categoryWindow: { lineIndex: number; menuItemId: string; categoryId: string }[];
  /** Set only when the request coords are farther than the tolerance from the quote's dropoff. */
  uberDropoff: { milesFromQuote: number; toleranceMiles: number } | null;
}

export interface Loaded {
  order: OrderInput;
  config: RestaurantPricingConfig;
  resolved: Resolved;
  diagnostics: Diagnostics;
}

// ---- small helpers -------------------------------------------------------------

/** Convert a DB value at the boundary; a rejection is a config error, not a guess. */
function fromDb<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw configError(`${what}: ${(err as Error).message}`);
  }
}

function dbRate(value: unknown, what: string): Rate {
  if (typeof value !== 'number' && typeof value !== 'string') throw configError(`${what} is ${JSON.stringify(value)}`);
  return fromDb(what, () => parseRate(value));
}

function dbDollars(value: unknown, what: string): Cents {
  if (typeof value !== 'number' && typeof value !== 'string') throw configError(`${what} is ${JSON.stringify(value)}`);
  return fromDb(what, () => dollarsToCents(value));
}

function dbDollarsOrZero(value: unknown, what: string): Cents {
  return value === null || value === undefined ? cents(0) : dbDollars(value, what);
}

function dbCentsOrNull(value: unknown, what: string): Cents | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw configError(`${what} is ${JSON.stringify(value)}`);
  return fromDb(what, () => cents(value));
}

function dbNumberOrNull(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw configError(`${what} is ${JSON.stringify(value)}`);
  return n;
}

/** IANA zone check via Intl (no pg_timezone_names CHECK in the DB; see 099). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of `now` in the restaurant's zone. */
export function localDateIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Great-circle miles. Same radius and formula as src/utils/haversine.js and create-payment-intent. */
const EARTH_RADIUS_MILES = 3958.8;
export function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** SHA-256 hex. MUST equal customer-auth's hashToken, or no session matches. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- promotion -------------------------------------------------------------------

/**
 * The promotion in effect on `localDate` (OPEN-QUESTIONS #10).
 *
 * In effect = is_active AND (is_perpetual OR start_date <= localDate <= end_date,
 * both dates set) — the web's rule (usePromotion.js), but on the restaurant's
 * local date instead of UTC. Several in effect → highest discount_percentage,
 * ties → lowest id. Deterministic.
 */
export function resolvePromotion(rows: PromotionRow[], localDate: string): { id: string; percent: Rate } | null {
  const live = rows
    .filter((p) => p.is_active === true)
    .filter((p) => p.is_perpetual === true || (!!p.start_date && !!p.end_date && p.start_date <= localDate && localDate <= p.end_date))
    .map((p) => ({ id: p.id, percent: dbRate(p.discount_percentage, `promotions(${p.id}).discount_percentage`) }));
  if (live.length === 0) return null;
  live.sort((a, b) => -compareRates(a.percent, b.percent) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const best = live[0];
  if (compareRate(best.percent, '0') < 0 || compareRate(best.percent, '100') > 0) {
    throw configError(`promotions(${best.id}).discount_percentage out of 0..100`);
  }
  return best;
}

// ---- toppings ---------------------------------------------------------------------

/**
 * toppings.size_prices (jsonb) → module SizePrice map. A blank, non-numeric or
 * negative entry becomes null — exactly as the web ignores it (toppingPrice.js
 * isValidPrice). A numeric entry with > 2 decimals is a config error.
 */
export function convertSizePrices(raw: unknown, toppingId: string): Record<string, SizePrice> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, SizePrice> = {};
  const one = (v: unknown, what: string): Cents | null => {
    if (typeof v === 'string') {
      if (v.trim() === '') return null;
    } else if (typeof v !== 'number') {
      return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return dbDollars(v, what);
  };
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    out[key] = {
      price: one(e.price, `toppings(${toppingId}).size_prices.${key}.price`),
      half: one(e.half, `toppings(${toppingId}).size_prices.${key}.half`),
    };
  }
  return Object.keys(out).length ? out : null;
}

function toppingPricing(t: ToppingRow): ToppingPricing {
  return {
    price: dbDollars(t.price, `toppings(${t.id}).price`),
    priceHalf: t.price_half === null || t.price_half === undefined ? null : dbDollars(t.price_half, `toppings(${t.id}).price_half`),
    sizePrices: convertSizePrices(t.size_prices, t.id),
  };
}

// ---- tip ----------------------------------------------------------------------------

function tipInput(tip: RequestTip): TipInput {
  switch (tip.mode) {
    case 'none':
      return { mode: 'none' };
    case 'amount':
      return { mode: 'amount', amount: cents(tip.amountCents) };
    case 'percent':
      try {
        return { mode: 'percent', percent: parseRate(tip.percent) };
      } catch {
        throw new ApiError('invalid_tip', 'tip.percent is not a decimal percentage');
      }
  }
}

// ---- config ------------------------------------------------------------------------

function restaurantConfig(r: RestaurantRow, channel: Channel, promo: Rate | null, deliveryMinimum: Cents): RestaurantPricingConfig {
  const taxRate = dbRate(r.tax_rate, 'restaurants.tax_rate');
  if (compareRate(taxRate, '0') < 0 || compareRate(taxRate, '1') >= 0) {
    throw configError(`restaurants.tax_rate ${r.tax_rate} outside [0, 1)`);
  }
  const policy = CHANNEL_POLICY[channel];
  const recoupRate = policy.recoup && r.recoup_enabled === true && r.recoup_rate !== null && r.recoup_rate !== undefined
    ? dbRate(r.recoup_rate, 'restaurants.recoup_rate')
    : ZERO_RATE;
  return {
    taxRate,
    promoPercent: promo,
    baseServiceFee: policy.baseServiceFee,
    recoupRate,
    deliveryMinimum,
    loyalty: {
      enabled: r.loyalty_enabled === true,
      earnBasis: r.loyalty_earn_basis ?? null,
      pointsPerDollar: r.loyalty_points_per_dollar === null || r.loyalty_points_per_dollar === undefined
        ? parseRate('1')
        : dbRate(r.loyalty_points_per_dollar, 'restaurants.loyalty_points_per_dollar'),
    },
  };
}

// ---- entry point ---------------------------------------------------------------------

export async function loadPricingInput(db: PricingDb, req: PriceRequest, ctx: LoadContext): Promise<Loaded> {
  const policy = CHANNEL_POLICY[ctx.channel];
  if (!policy.orderTypes.includes(req.orderType)) {
    throw new ApiError('unsupported_order_type', `${req.orderType} orders are not available on the ${ctx.channel} channel`);
  }

  const r = await db.getRestaurant(req.restaurantId);
  if (!r) throw new ApiError('restaurant_not_found', 'restaurant not found');
  if (!isValidTimeZone(r.timezone)) throw configError(`restaurants.timezone is ${JSON.stringify(r.timezone)} (migration 099 applied?)`);
  const timeZone: string = r.timezone;
  const localDate = localDateIn(timeZone, ctx.now);
  const diagnostics: Diagnostics = { categoryWindow: [], uberDropoff: null };

  // -- promo (restaurant-local date)
  const promo = resolvePromotion(await db.getActivePromotions(r.id), localDate);

  // -- redemption (read first: an item reward adds an item id to load)
  let redemption: Redemption | null = null;
  let rewardLine: { line: Line; resolved: ResolvedLine } | null = null;
  let redemptionResolved: Resolved['redemption'] = null;
  if (req.loyaltyRedemptionId) {
    const red = await db.getRedemption(req.loyaltyRedemptionId);
    if (!red) throw new ApiError('redemption_not_found', 'reward not found');
    if (red.restaurant_id !== r.id) throw new ApiError('redemption_wrong_restaurant', 'reward belongs to another restaurant');
    // Ownership before status/expiry: no point saying "expired" about a reward that was never theirs.
    if (!req.sessionToken) throw new ApiError('redemption_requires_signin', 'sign in to use this reward');
    const session = await db.getSessionByTokenHash(await hashToken(req.sessionToken));
    if (!session || session.revoked_at !== null || new Date(session.expires_at).getTime() < ctx.now.getTime()) {
      throw new ApiError('redemption_requires_signin', 'sign in to use this reward');
    }
    if (session.customer_id !== red.customer_id) throw new ApiError('redemption_not_yours', 'this reward belongs to another customer');
    if (red.status !== 'pending') throw new ApiError('redemption_not_pending', `reward is ${red.status}`);
    if (red.code_expires_at && new Date(red.code_expires_at).getTime() < ctx.now.getTime()) {
      throw new ApiError('redemption_expired', 'reward hold expired');
    }
    if (red.reward_kind !== 'item' && red.reward_kind !== 'discount') throw configError(`loyalty_redemptions(${red.id}).reward_kind ${red.reward_kind}`);
    const minRaw = red.reward_id ? await db.getRewardMinSubtotalCents(red.reward_id) : null;
    redemption = {
      kind: red.reward_kind,
      discountCents: red.reward_kind === 'discount' ? dbCentsOrNull(red.discount_cents, `loyalty_redemptions(${red.id}).discount_cents`) : null,
      minSubtotal: dbCentsOrNull(minRaw ?? 0, 'loyalty_rewards.min_subtotal_cents') ?? cents(0),
    };
    redemptionResolved = { id: red.id, kind: red.reward_kind };
    // The reward line is synthesized here from the redemption row, never taken from the cart.
    rewardLine = {
      line: { quantity: 1, basePrice: cents(0), sizeName: null, discountExempt: true, modifiers: [], reward: red.reward_kind },
      resolved: {
        menuItemId: red.reward_kind === 'item' ? red.menu_item_id : null,
        itemSizeId: red.reward_kind === 'item' ? red.item_size_id : null,
        sizeName: null,
        quantity: 1,
        discountExempt: true,
        reward: red.reward_kind,
        modifiers: [],
      },
    };
  }

  // -- menu rows (restaurant-scoped)
  const itemIds = [...new Set(req.lines.map((l) => l.menuItemId))];
  const toppingIds = [...new Set(req.lines.flatMap((l) => l.modifiers.map((m) => m.toppingId)))];
  const [items, sizes, toppings, links] = await Promise.all([
    itemIds.length ? db.getMenuItems(r.id, itemIds) : Promise.resolve([]),
    itemIds.length ? db.getItemSizes(itemIds) : Promise.resolve([]),
    toppingIds.length ? db.getToppings(r.id, toppingIds) : Promise.resolve([]),
    itemIds.length && toppingIds.length ? db.getItemToppingGroups(itemIds) : Promise.resolve([]),
  ]);
  const groupIds = [...new Set(toppings.map((t) => t.topping_group_id))];
  const groups = groupIds.length ? await db.getToppingGroups(r.id, groupIds) : [];

  const itemById = new Map(items.filter((i) => i.restaurant_id === r.id).map((i) => [i.id, i]));
  const categoryIds = [...new Set([...itemById.values()].map((i) => i.category_id).filter((c): c is string => !!c))];
  const categories = categoryIds.length ? await db.getCategories(r.id, categoryIds) : [];
  const categoryById = new Map(categories.filter((c) => c.restaurant_id === r.id).map((c) => [c.id, c]));
  const toppingById = new Map(toppings.filter((t) => t.restaurant_id === r.id).map((t) => [t.id, t]));
  const groupById = new Map(groups.filter((g) => g.restaurant_id === r.id).map((g) => [g.id, g]));
  const linked = new Set(links.map((l) => `${l.item_id}|${l.topping_group_id}`));

  const lines: Line[] = [];
  const resolvedLines: ResolvedLine[] = [];
  req.lines.forEach((reqLine, i) => {
    const where = `lines[${i}]`;
    const item = itemById.get(reqLine.menuItemId);
    if (!item) throw new ApiError('item_not_found', `${where}: menu item not found`);
    if (item.is_available !== true) throw new ApiError('item_unavailable', `${where}: item is unavailable`);
    const category = item.category_id ? categoryById.get(item.category_id) : undefined;
    // Promo exemption comes from the item's category (migration 052; useMenu.js).
    const discountExempt = category?.discount_exempt === true;
    if (category && !isCategoryAvailableAt(category.availability, ctx.now, timeZone)) {
      diagnostics.categoryWindow.push({ lineIndex: i, menuItemId: item.id, categoryId: category.id });
    }

    const itemSizes = sizes.filter((s) => s.item_id === item.id);
    let basePrice: Cents;
    let sizeName: string | null;
    if (reqLine.itemSizeId) {
      const size = itemSizes.find((s) => s.id === reqLine.itemSizeId);
      if (!size) throw new ApiError('size_not_found', `${where}: size not found for this item`);
      basePrice = dbDollars(size.price, `item_sizes(${size.id}).price`);
      sizeName = size.name;
    } else {
      if (itemSizes.length > 0) throw new ApiError('size_not_found', `${where}: a size is required for this item`);
      basePrice = cents(0);
      sizeName = null;
    }

    const seen = new Set<string>();
    const modifiers: Modifier[] = [];
    const resolvedMods: ResolvedModifier[] = [];
    reqLine.modifiers.forEach((m, j) => {
      const mwhere = `${where}.modifiers[${j}]`;
      if (seen.has(m.toppingId)) throw new ApiError('duplicate_modifier', `${mwhere}: topping listed twice`);
      seen.add(m.toppingId);
      const t = toppingById.get(m.toppingId);
      const group = t ? groupById.get(t.topping_group_id) : undefined;
      if (!t || !group || !linked.has(`${item.id}|${group.id}`)) {
        throw new ApiError('topping_not_allowed', `${mwhere}: topping is not offered on this item`);
      }
      if (t.is_available !== true) throw new ApiError('item_unavailable', `${mwhere}: topping is unavailable`);
      if (group.placement_type === 'addon') {
        // Add-on: stored price, no placement (ItemModal chargeFor).
        if (m.placement !== null && m.placement !== 'whole') {
          throw new ApiError('invalid_placement', `${mwhere}: add-ons take no half placement`);
        }
        modifiers.push({ kind: 'addon', price: dbDollars(t.price, `toppings(${t.id}).price`) });
        resolvedMods.push({ toppingId: t.id, kind: 'addon', placement: 'whole' });
      } else {
        // Anything not 'addon' is a pizza topping (ItemModal: placement_type !== 'addon').
        if (m.placement === null) throw new ApiError('invalid_placement', `${mwhere}: pizza toppings need a placement`);
        modifiers.push({ kind: 'pizza', placement: m.placement, topping: toppingPricing(t) });
        resolvedMods.push({ toppingId: t.id, kind: 'pizza', placement: m.placement });
      }
    });

    lines.push({ quantity: reqLine.quantity, basePrice, sizeName, discountExempt, modifiers, reward: null });
    resolvedLines.push({
      menuItemId: item.id,
      itemSizeId: reqLine.itemSizeId,
      sizeName,
      quantity: reqLine.quantity,
      discountExempt,
      reward: null,
      modifiers: resolvedMods,
    });
  });
  if (rewardLine) {
    lines.push(rewardLine.line);
    resolvedLines.push(rewardLine.resolved);
  }

  // -- delivery
  let delivery: DeliveryInput | null = null;
  let deliveryMode: Resolved['deliveryMode'] = null;
  let distanceMiles: number | null = null;
  let uberQuoteId: string | null = null;
  let deliveryMinimum: Cents = cents(0);
  if (req.orderType === 'delivery') {
    const d = req.delivery!;
    const rLat = dbNumberOrNull(r.latitude, 'restaurants.latitude');
    const rLng = dbNumberOrNull(r.longitude, 'restaurants.longitude');
    if (rLat === null || rLng === null) throw configError('restaurant has no coordinates');
    const extendedZone = d.extendedZone && r.uber_extends_delivery === true && r.delivery_fulfillment === 'in_house';
    const mode = resolveMode(r as unknown as RestaurantForMode, ctx.now, extendedZone).resolved_mode;
    deliveryMode = mode;

    if (mode === 'uber_direct') {
      if (!d.uberQuoteId) throw new ApiError('quote_required', 'this delivery needs an Uber quote');
      const q = await db.getUberQuote(d.uberQuoteId);
      if (!q) throw new ApiError('quote_not_found', 'delivery quote not found');
      if (q.restaurant_id !== r.id) throw new ApiError('quote_wrong_restaurant', 'delivery quote is for another restaurant');
      if (new Date(q.expires_at).getTime() < ctx.now.getTime() + QUOTE_EXPIRY_BUFFER_MS) {
        throw new ApiError('quote_expired', 'delivery quote expired');
      }
      const recomputed = applyPassthrough(q.uber_quoted_fee_cents, r.uber_passthrough_mode ?? '', Number(r.uber_passthrough_value || 0));
      if (recomputed.customer_cents !== q.customer_delivery_fee_cents) {
        throw new ApiError('quote_passthrough_changed', 'delivery pricing changed; get a new quote');
      }
      if (typeof q.dropoff_lat === 'number' && typeof q.dropoff_lng === 'number') {
        const milesFromQuote = haversineDistanceMiles(d.lat, d.lng, q.dropoff_lat, q.dropoff_lng);
        if (milesFromQuote > UBER_DROPOFF_TOLERANCE_MILES) {
          diagnostics.uberDropoff = { milesFromQuote: Math.round(milesFromQuote * 1000) / 1000, toleranceMiles: UBER_DROPOFF_TOLERANCE_MILES };
        }
      }
      // The quote was priced at its own coordinates; those are authoritative.
      const lat = typeof q.dropoff_lat === 'number' ? q.dropoff_lat : d.lat;
      const lng = typeof q.dropoff_lng === 'number' ? q.dropoff_lng : d.lng;
      distanceMiles = haversineDistanceMiles(rLat, rLng, lat, lng);
      if (extendedZone) {
        const limit = dbNumberOrNull(r.uber_max_radius_miles, 'restaurants.uber_max_radius_miles') ?? DEFAULT_UBER_MAX_RADIUS_MILES;
        if (distanceMiles > limit) throw new ApiError('out_of_delivery_range', 'address is outside the delivery area');
      }
      uberQuoteId = q.quote_id;
      delivery = { mode: 'uber_direct', customerFee: dbCentsOrNull(q.customer_delivery_fee_cents, 'uber_quotes.customer_delivery_fee_cents') ?? cents(0) };
      deliveryMinimum = dbDollarsOrZero(r.delivery_minimum_uber_direct, 'restaurants.delivery_minimum_uber_direct');
    } else {
      distanceMiles = haversineDistanceMiles(rLat, rLng, d.lat, d.lng);
      delivery = {
        mode: 'in_house',
        distanceMiles,
        tiers: {
          maxRadiusMiles: dbNumberOrNull(r.delivery_max_radius_miles, 'restaurants.delivery_max_radius_miles'),
          tier1MaxMiles: dbNumberOrNull(r.delivery_tier1_max_miles, 'restaurants.delivery_tier1_max_miles'),
          tier1Fee: dbCentsOrNull(r.delivery_tier1_fee_cents, 'restaurants.delivery_tier1_fee_cents'),
          tier2Fee: dbCentsOrNull(r.delivery_tier2_fee_cents, 'restaurants.delivery_tier2_fee_cents'),
        },
      };
      deliveryMinimum = dbDollarsOrZero(r.delivery_minimum_in_house, 'restaurants.delivery_minimum_in_house');
    }
  }

  const config = restaurantConfig(r, ctx.channel, promo?.percent ?? null, deliveryMinimum);
  const order: OrderInput = {
    orderType: req.orderType,
    lines,
    tip: tipInput(req.tip),
    delivery,
    loyaltyRedemption: redemption,
  };
  return {
    order,
    config,
    diagnostics,
    resolved: {
      channel: ctx.channel,
      restaurantId: r.id,
      orderType: req.orderType,
      localDate,
      promotionId: promo?.id ?? null,
      deliveryMode,
      distanceMiles: distanceMiles === null ? null : Math.round(distanceMiles * 100) / 100,
      uberQuoteId,
      redemption: redemptionResolved,
      lines: resolvedLines,
    },
  };
}
