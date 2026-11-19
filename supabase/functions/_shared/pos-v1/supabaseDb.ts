/**
 * PricingDb over a service-role Supabase client. Explicit column lists only;
 * restaurants is read with RESTAURANT_COLUMNS, never `*`.
 *
 * Structural client type so this file imports no remote module (tests and
 * `deno check` run offline); the function's index.ts passes the real client.
 */
import {
  type ItemSizeRow,
  type ItemToppingGroupRow,
  type MenuItemRow,
  type PricingDb,
  type PromotionRow,
  RESTAURANT_COLUMNS,
  type RedemptionRow,
  type RestaurantRow,
  type SessionRow,
  type ToppingGroupRow,
  type ToppingRow,
  type UberQuoteRow,
} from './db.ts';
import { configError } from './errors.ts';

// deno-lint-ignore no-explicit-any
export type SupabaseLike = { from(table: string): any };

interface PgResult<T> {
  data: T | null;
  error: { code?: string; message: string } | null;
}

class DbError extends Error {
  constructor(what: string, message: string) {
    super(`db read failed (${what}): ${message}`);
    this.name = 'DbError';
  }
}

function rows<T>(what: string, res: PgResult<T[]>): T[] {
  if (res.error) throw new DbError(what, res.error.message);
  return res.data ?? [];
}

function one<T>(what: string, res: PgResult<T>): T | null {
  if (res.error) throw new DbError(what, res.error.message);
  return res.data ?? null;
}

export function supabasePricingDb(client: SupabaseLike): PricingDb {
  return {
    async getRestaurant(id) {
      const res: PgResult<RestaurantRow> = await client
        .from('restaurants')
        .select(RESTAURANT_COLUMNS.join(','))
        .eq('id', id)
        .maybeSingle();
      // 42703 = undefined_column: migration 099 (timezone) not applied yet.
      if (res.error?.code === '42703') throw configError(`restaurants select: ${res.error.message}`);
      return one('restaurants', res);
    },
    async getMenuItems(restaurantId, ids) {
      return rows<MenuItemRow>('menu_items', await client
        .from('menu_items')
        .select('id,restaurant_id,is_available,discount_exempt')
        .eq('restaurant_id', restaurantId)
        .in('id', ids));
    },
    async getItemSizes(itemIds) {
      return rows<ItemSizeRow>('item_sizes', await client
        .from('item_sizes')
        .select('id,item_id,name,price')
        .in('item_id', itemIds));
    },
    async getToppings(restaurantId, ids) {
      return rows<ToppingRow>('toppings', await client
        .from('toppings')
        .select('id,restaurant_id,topping_group_id,price,price_half,size_prices,is_available')
        .eq('restaurant_id', restaurantId)
        .in('id', ids));
    },
    async getToppingGroups(restaurantId, ids) {
      return rows<ToppingGroupRow>('topping_groups', await client
        .from('topping_groups')
        .select('id,restaurant_id,placement_type')
        .eq('restaurant_id', restaurantId)
        .in('id', ids));
    },
    async getItemToppingGroups(itemIds) {
      return rows<ItemToppingGroupRow>('item_topping_groups', await client
        .from('item_topping_groups')
        .select('item_id,topping_group_id')
        .in('item_id', itemIds));
    },
    async getActivePromotions(restaurantId) {
      return rows<PromotionRow>('promotions', await client
        .from('promotions')
        .select('id,restaurant_id,discount_percentage,is_active,is_perpetual,start_date,end_date')
        .eq('restaurant_id', restaurantId)
        .eq('is_active', true));
    },
    async getRedemption(id) {
      return one<RedemptionRow>('loyalty_redemptions', await client
        .from('loyalty_redemptions')
        .select('id,restaurant_id,customer_id,status,reward_kind,discount_cents,reward_id,menu_item_id,item_size_id,code_expires_at')
        .eq('id', id)
        .maybeSingle());
    },
    async getRewardMinSubtotalCents(rewardId) {
      const row = one<{ min_subtotal_cents: number }>('loyalty_rewards', await client
        .from('loyalty_rewards')
        .select('min_subtotal_cents')
        .eq('id', rewardId)
        .maybeSingle());
      return row?.min_subtotal_cents ?? null;
    },
    async getSessionByTokenHash(tokenHash) {
      return one<SessionRow>('customer_sessions', await client
        .from('customer_sessions')
        .select('customer_id,revoked_at,expires_at')
        .eq('token_hash', tokenHash)
        .maybeSingle());
    },
    async getUberQuote(quoteId) {
      return one<UberQuoteRow>('uber_quotes', await client
        .from('uber_quotes')
        .select('quote_id,restaurant_id,uber_quoted_fee_cents,customer_delivery_fee_cents,expires_at,dropoff_lat,dropoff_lng')
        .eq('quote_id', quoteId)
        .maybeSingle());
    },
  };
}
