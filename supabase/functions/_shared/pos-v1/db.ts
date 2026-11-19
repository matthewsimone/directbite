/**
 * The pricing loader's view of the database: explicit columns only.
 *
 * `RestaurantRow` is EVERY restaurants column the loader reads. The Supabase
 * implementation selects exactly RESTAURANT_COLUMNS (never `*`), so no secret
 * column (uber_client_secret, uber_webhook_signing_secret, ...) is ever
 * loaded, let alone returned.
 *
 * numeric columns arrive from PostgREST as JSON numbers or strings; both are
 * accepted and converted exactly at the money boundary.
 */

export type Numeric = number | string;

export const RESTAURANT_COLUMNS = [
  'id',
  'timezone',
  'tax_rate',
  'recoup_enabled',
  'recoup_rate',
  'loyalty_enabled',
  'loyalty_earn_basis',
  'loyalty_points_per_dollar',
  'latitude',
  'longitude',
  'delivery_max_radius_miles',
  'delivery_tier1_max_miles',
  'delivery_tier1_fee_cents',
  'delivery_tier2_fee_cents',
  'delivery_minimum_in_house',
  'delivery_minimum_uber_direct',
  'delivery_fulfillment',
  'uber_credentials_verified_at',
  'uber_direct_active',
  'uber_schedule',
  'uber_billing_mode',
  'uber_passthrough_mode',
  'uber_passthrough_value',
  'uber_extends_delivery',
  'uber_max_radius_miles',
] as const;

export interface RestaurantRow {
  id: string;
  /** Migration 099. Missing column / null → pricing_config_invalid. */
  timezone: string | null | undefined;
  tax_rate: Numeric;
  recoup_enabled: boolean | null;
  recoup_rate: Numeric | null;
  loyalty_enabled: boolean | null;
  loyalty_earn_basis: string | null;
  loyalty_points_per_dollar: Numeric | null;
  latitude: Numeric | null;
  longitude: Numeric | null;
  delivery_max_radius_miles: Numeric | null;
  delivery_tier1_max_miles: Numeric | null;
  delivery_tier1_fee_cents: number | null;
  delivery_tier2_fee_cents: number | null;
  delivery_minimum_in_house: Numeric | null;
  delivery_minimum_uber_direct: Numeric | null;
  delivery_fulfillment: string | null;
  uber_credentials_verified_at: string | null;
  uber_direct_active: boolean | null;
  // deno-lint-ignore no-explicit-any
  uber_schedule: any;
  uber_billing_mode: string | null;
  uber_passthrough_mode: string | null;
  uber_passthrough_value: Numeric | null;
  uber_extends_delivery: boolean | null;
  uber_max_radius_miles: Numeric | null;
}

export interface MenuItemRow {
  id: string;
  restaurant_id: string;
  category_id: string | null;
  is_available: boolean;
}

export interface CategoryRow {
  id: string;
  restaurant_id: string;
  /** jsonb availability window (migration 086); null = always. */
  availability: unknown;
  /**
   * Migration 052: promo exemption is a CATEGORY flag. There is no
   * menu_items.discount_exempt (PRICING-SPEC §2.2 says otherwise; the schema
   * and the web, useMenu.js, read it from the category).
   */
  discount_exempt: boolean;
}

export interface ItemSizeRow {
  id: string;
  item_id: string;
  name: string;
  price: Numeric;
}

export interface ToppingRow {
  id: string;
  restaurant_id: string;
  topping_group_id: string;
  price: Numeric;
  price_half: Numeric | null;
  /** jsonb; may hold junk entries (ignored, as the web ignores them). */
  size_prices: unknown;
  is_available: boolean;
}

export interface ToppingGroupRow {
  id: string;
  restaurant_id: string;
  placement_type: string;
}

export interface ItemToppingGroupRow {
  item_id: string;
  topping_group_id: string;
}

export interface PromotionRow {
  id: string;
  restaurant_id: string;
  discount_percentage: Numeric;
  is_active: boolean;
  is_perpetual: boolean;
  start_date: string | null;
  end_date: string | null;
}

export interface RedemptionRow {
  id: string;
  restaurant_id: string;
  customer_id: string;
  status: string;
  reward_kind: string;
  discount_cents: number | null;
  reward_id: string | null;
  menu_item_id: string | null;
  item_size_id: string | null;
  code_expires_at: string | null;
}

export interface SessionRow {
  customer_id: string;
  revoked_at: string | null;
  expires_at: string;
}

export interface UberQuoteRow {
  quote_id: string;
  restaurant_id: string;
  uber_quoted_fee_cents: number;
  customer_delivery_fee_cents: number;
  expires_at: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
}

/**
 * Reads the loader needs. Implementations throw on a database error (the
 * handler turns that into a generic 500) and return null / [] for "no rows".
 */
export interface PricingDb {
  getRestaurant(id: string): Promise<RestaurantRow | null>;
  getMenuItems(restaurantId: string, ids: string[]): Promise<MenuItemRow[]>;
  getCategories(restaurantId: string, ids: string[]): Promise<CategoryRow[]>;
  getItemSizes(itemIds: string[]): Promise<ItemSizeRow[]>;
  getToppings(restaurantId: string, ids: string[]): Promise<ToppingRow[]>;
  getToppingGroups(restaurantId: string, ids: string[]): Promise<ToppingGroupRow[]>;
  getItemToppingGroups(itemIds: string[]): Promise<ItemToppingGroupRow[]>;
  getActivePromotions(restaurantId: string): Promise<PromotionRow[]>;
  getRedemption(id: string): Promise<RedemptionRow | null>;
  getRewardMinSubtotalCents(rewardId: string): Promise<number | null>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  getUberQuote(quoteId: string): Promise<UberQuoteRow | null>;
}
