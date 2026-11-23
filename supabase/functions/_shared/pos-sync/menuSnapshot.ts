/**
 * pos-v1-menu-snapshot body builder (ordr-pos SYNC-CONTRACT §4, DIRECTBITE-HANDOFF item 1).
 *
 * Every field of the contract's MenuSnapshot is ALWAYS present (null when absent). Money is integer
 * cents through the vendored `dollarsToCents` (> 2 decimals → SnapshotError naming the field);
 * rates and distances are decimal strings (`rateToString(parseRate(x))`, trailing zeros dropped);
 * the category window is the vendored `normalizeAvailability` (fails open → null). The promotion is
 * the pos-v1 loader's rule on the restaurant-LOCAL date (highest % wins, ties → lowest id).
 *
 * toppings[].size_prices is an ARRAY [{size_key, price_cents, half_cents}] sorted by size_key (CP9b,
 * POS-confirmed contract change; ./sizePrices.ts).
 *
 * Deterministic array order (the hash covers it): JS code-unit string compare, numbers ascending:
 *   categories          (sort_order, id)
 *   items               (category_id, sort_order, id)
 *   item_sizes          (item_id, sort_order, id)
 *   topping_groups      (sort_order, id)
 *   toppings            (group_id, sort_order, id)
 *   item_topping_groups (item_id, sort_order, group_id)
 *
 * hash = SHA-256 of the canonical JSON (SYNC §7) of the body without `hash` / `server_time`.
 *
 * Constants by decision / missing source (see CP9 report):
 *   restaurant.business_day_cutoff = "04:00" (Matt); restaurant.recoup_rate = "0" (in-person pricing:
 *   the reference fixture publishes "0" and neither FakeServer nor the POS prices from it);
 *   categories[].available = true and item_topping_groups[].is_active = true (no such columns in the
 *   repo schema; rows are deleted when unlinked).
 */
import { dollarsToCents, parseRate, rateToString } from '../ordr-core/money.ts';
import { normalizeAvailability, type Availability } from '../ordr-core-ext/availability.ts';
import { isValidTimeZone, localDateIn, resolvePromotion } from '../pos-v1/loader.ts';
import type { Numeric, PromotionRow } from '../pos-v1/db.ts';
import { contentHash, SNAPSHOT_HASH_EXCLUDES } from './canonicalJson.ts';
import { SizePriceError, sizePricesFromJsonb, type SizePriceEntry } from './sizePrices.ts';

export const BUSINESS_DAY_CUTOFF = '04:00';
export const SNAPSHOT_RECOUP_RATE = '0';

export class SnapshotError extends Error {
  readonly code: 'restaurant_not_found' | 'snapshot_config_invalid';
  readonly field: string | null;
  constructor(code: SnapshotError['code'], message: string, field: string | null = null) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.field = field;
  }
}

// ---- rows the builder reads (explicit columns; never secrets) ------------------------------------

export interface SnapshotRestaurantRow {
  id: string;
  name: string;
  phone: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  timezone: string | null;
  tax_rate: Numeric;
  delivery_available: boolean | null;
  delivery_fulfillment: string | null;
  delivery_max_radius_miles: Numeric | null;
  delivery_tier1_max_miles: Numeric | null;
  delivery_tier1_fee_cents: number | null;
  delivery_tier2_fee_cents: number | null;
  delivery_minimum_in_house: Numeric | null;
  delivery_minimum_uber_direct: Numeric | null;
  loyalty_enabled: boolean | null;
  loyalty_earn_basis: string | null;
  loyalty_points_per_dollar: Numeric | null;
}
export interface SnapshotCategoryRow { id: string; name: string; sort_order: number | null; discount_exempt: boolean | null; availability: unknown }
export interface SnapshotItemRow { id: string; category_id: string; name: string; description: string | null; is_available: boolean | null; sort_order: number | null }
export interface SnapshotSizeRow { id: string; item_id: string; name: string; price: Numeric; sort_order: number | null }
export interface SnapshotGroupRow { id: string; name: string; placement_type: string | null; selection_type: string | null; required: boolean | null; max_selections: number | null; sort_order: number | null }
export interface SnapshotToppingRow { id: string; topping_group_id: string; name: string; price: Numeric; price_half: Numeric | null; size_prices: unknown; is_available: boolean | null; is_default: boolean | null; sort_order: number | null }
export interface SnapshotLinkRow { item_id: string; topping_group_id: string; sort_order: number | null }

export interface SnapshotDb {
  getRestaurant(id: string): Promise<SnapshotRestaurantRow | null>;
  getCategories(restaurantId: string): Promise<SnapshotCategoryRow[]>;
  getItems(restaurantId: string): Promise<SnapshotItemRow[]>;
  getItemSizes(restaurantId: string): Promise<SnapshotSizeRow[]>;
  getToppingGroups(restaurantId: string): Promise<SnapshotGroupRow[]>;
  getToppings(restaurantId: string): Promise<SnapshotToppingRow[]>;
  getItemToppingGroups(restaurantId: string): Promise<SnapshotLinkRow[]>;
  getActivePromotions(restaurantId: string): Promise<PromotionRow[]>;
}

// ---- wire shape (= ordr-pos src/sync/contract.ts MenuSnapshot) -----------------------------------

export interface MenuSnapshot {
  hash: string;
  server_time: string;
  restaurant: {
    id: string;
    name: string;
    address: { street: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null };
    timezone: string;
    business_day_cutoff: string;
    tax_rate: string;
    recoup_rate: string;
    delivery: {
      max_radius_miles: string | null;
      tier1_max_miles: string | null;
      tier1_fee_cents: number | null;
      tier2_fee_cents: number | null;
      minimum_in_house_cents: number;
      minimum_uber_direct_cents: number;
      offline_fee_cents: number;
      enabled: boolean;
      fulfillment: 'in_house' | 'uber_direct' | 'both';
    };
    loyalty: { enabled: boolean; earn_basis: string | null; points_per_dollar: string };
  };
  promotion: { id: string; discount_percent: string } | null;
  categories: { id: string; name: string; sort_order: number; available: boolean; discount_exempt: boolean; availability: Availability }[];
  items: { id: string; category_id: string; name: string; description: string | null; is_available: boolean; sort_order: number }[];
  item_sizes: { id: string; item_id: string; name: string; price_cents: number; sort_order: number }[];
  topping_groups: { id: string; name: string; placement_type: 'pizza' | 'addon'; selection_type: 'single' | 'limited' | 'unlimited'; required: boolean; max_selections: number | null; sort_order: number }[];
  toppings: { id: string; group_id: string; name: string; price_cents: number; price_half_cents: number | null; size_prices: SizePriceEntry[] | null; is_available: boolean; is_default: boolean; sort_order: number }[];
  item_topping_groups: { item_id: string; group_id: string; is_active: boolean; sort_order: number }[];
}

// ---- conversions ---------------------------------------------------------------------------------

const invalid = (message: string, field: string) => new SnapshotError('snapshot_config_invalid', message, field);

function cents(value: Numeric, field: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw invalid(`${field} is ${JSON.stringify(value)}`, field);
  try {
    return dollarsToCents(value);
  } catch (err) {
    throw invalid(`${field}: ${(err as Error).message}`, field);
  }
}
const centsOrNull = (v: Numeric | null | undefined, field: string) => (v === null || v === undefined ? null : cents(v, field));
const centsOrZero = (v: Numeric | null | undefined, field: string) => (v === null || v === undefined ? 0 : cents(v, field));

function intCentsOrNull(v: unknown, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw invalid(`${field} must be integer cents, got ${JSON.stringify(v)}`, field);
  return v;
}

function decimal(v: Numeric, field: string): string {
  try {
    return rateToString(parseRate(v));
  } catch (err) {
    throw invalid(`${field}: ${(err as Error).message}`, field);
  }
}
const decimalOrNull = (v: Numeric | null | undefined, field: string) => (v === null || v === undefined ? null : decimal(v, field));

const int = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** US phone → E.164 (+1XXXXXXXXXX); anything else → null. */
export function usPhoneE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 10 ? d : d.length === 11 && d.startsWith('1') ? d.slice(1) : null;
  if (!ten || !/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

const blankToNull = (s: string | null | undefined) => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null);

/**
 * toppings.size_prices → the wire array (CP9b; rules in ./sizePrices.ts). A > 2-decimal value is a
 * snapshot_config_invalid error naming the field.
 */
export function wireSizePrices(raw: unknown, toppingId: string): SizePriceEntry[] | null {
  try {
    return sizePricesFromJsonb(raw, `toppings(${toppingId}).size_prices`);
  } catch (err) {
    if (err instanceof SizePriceError) throw invalid(err.message, err.field);
    throw err;
  }
}

type Key = (string | number)[];
function byKeys<T>(key: (x: T) => Key) {
  return (a: T, b: T) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < x.length; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  };
}

// ---- build ---------------------------------------------------------------------------------------

export async function buildMenuSnapshot(db: SnapshotDb, restaurantId: string, now: Date): Promise<MenuSnapshot> {
  const r = await db.getRestaurant(restaurantId);
  if (!r) throw new SnapshotError('restaurant_not_found', 'restaurant not found');
  if (!isValidTimeZone(r.timezone)) throw invalid(`restaurants.timezone is ${JSON.stringify(r.timezone)}`, 'restaurants.timezone');
  const timeZone = r.timezone;

  const [cats, items, sizes, groups, toppings, links, promos] = await Promise.all([
    db.getCategories(r.id),
    db.getItems(r.id),
    db.getItemSizes(r.id),
    db.getToppingGroups(r.id),
    db.getToppings(r.id),
    db.getItemToppingGroups(r.id),
    db.getActivePromotions(r.id),
  ]);

  const taxRate = decimal(r.tax_rate, 'restaurants.tax_rate');
  if (Number(taxRate) < 0 || Number(taxRate) >= 1) throw invalid(`restaurants.tax_rate ${taxRate} outside [0, 1)`, 'restaurants.tax_rate');
  const tier1 = intCentsOrNull(r.delivery_tier1_fee_cents, 'restaurants.delivery_tier1_fee_cents');
  const tier2 = intCentsOrNull(r.delivery_tier2_fee_cents, 'restaurants.delivery_tier2_fee_cents');
  const fulfillment = r.delivery_fulfillment === 'uber_direct' || r.delivery_fulfillment === 'both' ? r.delivery_fulfillment : 'in_house';

  let promotion: MenuSnapshot['promotion'] = null;
  try {
    const p = resolvePromotion(promos, localDateIn(timeZone, now));
    promotion = p ? { id: p.id, discount_percent: rateToString(p.percent) } : null;
  } catch (err) {
    throw invalid(`promotions: ${(err as Error).message}`, 'promotions.discount_percentage');
  }

  const body: Omit<MenuSnapshot, 'hash'> = {
    server_time: now.toISOString(),
    restaurant: {
      id: r.id,
      name: r.name,
      address: {
        street: blankToNull(r.address_street),
        city: blankToNull(r.address_city),
        state: blankToNull(r.address_state),
        zip: blankToNull(r.address_zip),
        phone: usPhoneE164(r.phone),
      },
      timezone: timeZone,
      business_day_cutoff: BUSINESS_DAY_CUTOFF,
      tax_rate: taxRate,
      recoup_rate: SNAPSHOT_RECOUP_RATE,
      delivery: {
        max_radius_miles: decimalOrNull(r.delivery_max_radius_miles, 'restaurants.delivery_max_radius_miles'),
        tier1_max_miles: decimalOrNull(r.delivery_tier1_max_miles, 'restaurants.delivery_tier1_max_miles'),
        tier1_fee_cents: tier1,
        tier2_fee_cents: tier2,
        minimum_in_house_cents: centsOrZero(r.delivery_minimum_in_house, 'restaurants.delivery_minimum_in_house'),
        minimum_uber_direct_cents: centsOrZero(r.delivery_minimum_uber_direct, 'restaurants.delivery_minimum_uber_direct'),
        offline_fee_cents: tier2 ?? tier1 ?? 0,
        enabled: r.delivery_available === true,
        fulfillment,
      },
      loyalty: {
        enabled: r.loyalty_enabled === true,
        earn_basis: r.loyalty_earn_basis ?? null,
        points_per_dollar: r.loyalty_points_per_dollar === null || r.loyalty_points_per_dollar === undefined
          ? '1'
          : decimal(r.loyalty_points_per_dollar, 'restaurants.loyalty_points_per_dollar'),
      },
    },
    promotion,
    categories: cats
      .map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: int(c.sort_order),
        available: true,
        discount_exempt: c.discount_exempt === true,
        availability: normalizeAvailability(c.availability),
      }))
      .sort(byKeys((c) => [c.sort_order, c.id])),
    items: items
      .map((i) => ({ id: i.id, category_id: i.category_id, name: i.name, description: i.description ?? null, is_available: i.is_available === true, sort_order: int(i.sort_order) }))
      .sort(byKeys((i) => [i.category_id, i.sort_order, i.id])),
    item_sizes: sizes
      .map((s) => ({ id: s.id, item_id: s.item_id, name: s.name, price_cents: cents(s.price, `item_sizes(${s.id}).price`), sort_order: int(s.sort_order) }))
      .sort(byKeys((s) => [s.item_id, s.sort_order, s.id])),
    topping_groups: groups
      .map((g) => ({
        id: g.id,
        name: g.name,
        // anything not 'addon' is a pizza group (the pos-v1 loader's rule)
        placement_type: (g.placement_type === 'addon' ? 'addon' : 'pizza') as 'pizza' | 'addon',
        selection_type: (g.selection_type === 'single' || g.selection_type === 'limited' ? g.selection_type : 'unlimited') as 'single' | 'limited' | 'unlimited',
        required: g.required === true,
        max_selections: typeof g.max_selections === 'number' && Number.isSafeInteger(g.max_selections) ? g.max_selections : null,
        sort_order: int(g.sort_order),
      }))
      .sort(byKeys((g) => [g.sort_order, g.id])),
    toppings: toppings
      .map((t) => ({
        id: t.id,
        group_id: t.topping_group_id,
        name: t.name,
        price_cents: cents(t.price, `toppings(${t.id}).price`),
        price_half_cents: centsOrNull(t.price_half, `toppings(${t.id}).price_half`),
        size_prices: wireSizePrices(t.size_prices, t.id),
        is_available: t.is_available === true,
        is_default: t.is_default === true,
        sort_order: int(t.sort_order),
      }))
      .sort(byKeys((t) => [t.group_id, t.sort_order, t.id])),
    item_topping_groups: links
      .map((l) => ({ item_id: l.item_id, group_id: l.topping_group_id, is_active: true, sort_order: int(l.sort_order) }))
      .sort(byKeys((l) => [l.item_id, l.sort_order, l.group_id])),
  };

  const hash = await contentHash(body as unknown as Record<string, unknown>, SNAPSHOT_HASH_EXCLUDES);
  return { hash, ...body };
}

// ---- Supabase reads (service role) ----------------------------------------------------------------

export const SNAPSHOT_RESTAURANT_COLUMNS =
  'id,name,phone,address_street,address_city,address_state,address_zip,timezone,tax_rate,delivery_available,delivery_fulfillment,' +
  'delivery_max_radius_miles,delivery_tier1_max_miles,delivery_tier1_fee_cents,delivery_tier2_fee_cents,delivery_minimum_in_house,' +
  'delivery_minimum_uber_direct,loyalty_enabled,loyalty_earn_basis,loyalty_points_per_dollar';

// deno-lint-ignore no-explicit-any
export function supabaseSnapshotDb(client: { from(table: string): any }): SnapshotDb {
  // deno-lint-ignore no-explicit-any
  const rows = async <T>(what: string, q: Promise<{ data: any; error: { message: string } | null }>): Promise<T[]> => {
    const { data, error } = await q;
    if (error) throw new Error(`snapshot read failed (${what}): ${error.message}`);
    return (data ?? []) as T[];
  };
  return {
    async getRestaurant(id) {
      const { data, error } = await client.from('restaurants').select(SNAPSHOT_RESTAURANT_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`snapshot read failed (restaurants): ${error.message}`);
      return data ?? null;
    },
    getCategories: (rid) => rows('menu_categories', client.from('menu_categories').select('id,name,sort_order,discount_exempt,availability').eq('restaurant_id', rid)),
    getItems: (rid) => rows('menu_items', client.from('menu_items').select('id,category_id,name,description,is_available,sort_order').eq('restaurant_id', rid)),
    // no restaurant_id column: filter through the item (same as the web's useMenu.js)
    getItemSizes: async (rid) =>
      (await rows<SnapshotSizeRow & { menu_items?: unknown }>('item_sizes', client.from('item_sizes').select('id,item_id,name,price,sort_order,menu_items!inner(restaurant_id)').eq('menu_items.restaurant_id', rid)))
        .map(({ menu_items: _m, ...s }) => s),
    getToppingGroups: (rid) => rows('topping_groups', client.from('topping_groups').select('id,name,placement_type,selection_type,required,max_selections,sort_order').eq('restaurant_id', rid)),
    getToppings: (rid) => rows('toppings', client.from('toppings').select('id,topping_group_id,name,price,price_half,size_prices,is_available,is_default,sort_order').eq('restaurant_id', rid)),
    getItemToppingGroups: async (rid) =>
      (await rows<SnapshotLinkRow & { menu_items?: unknown }>('item_topping_groups', client.from('item_topping_groups').select('item_id,topping_group_id,sort_order,menu_items!inner(restaurant_id)').eq('menu_items.restaurant_id', rid)))
        .map(({ menu_items: _m, ...l }) => l),
    getActivePromotions: (rid) => rows('promotions', client.from('promotions').select('id,restaurant_id,discount_percentage,is_active,is_perpetual,start_date,end_date').eq('restaurant_id', rid).eq('is_active', true)),
  };
}
