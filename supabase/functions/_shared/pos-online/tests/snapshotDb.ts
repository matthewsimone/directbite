/**
 * A SnapshotDb over the FakeSupabase rows (tests only): the real menu-snapshot builder
 * (_shared/pos-sync/menuSnapshot.ts buildMenuSnapshot) runs over Test Pizza's fake menu_categories / menu_items and
 * restaurants row, so pos-v1-online-settings' item_availability answer carries a real snapshot hash.
 * Sizes / toppings / links / promotions: none.
 */
import type { SnapshotDb } from '../../pos-sync/menuSnapshot.ts';
import type { FakeSupabase } from './fakeSupabase.ts';

export function fakeSnapshotDb(db: FakeSupabase): SnapshotDb {
  return {
    getRestaurant: (id) => {
      const r = db.rows('restaurants').find((x) => x.id === id);
      return Promise.resolve(r ? {
        id: r.id, name: 'Test Pizza', phone: null, address_street: null, address_city: null, address_state: null, address_zip: null,
        timezone: r.timezone, tax_rate: '0.06625', delivery_available: r.delivery_available, delivery_fulfillment: r.delivery_fulfillment,
        delivery_max_radius_miles: null, delivery_tier1_max_miles: null, delivery_tier1_fee_cents: null, delivery_tier2_fee_cents: null,
        delivery_minimum_in_house: null, delivery_minimum_uber_direct: null, loyalty_enabled: false, loyalty_earn_basis: null,
        loyalty_points_per_dollar: null,
      } : null);
    },
    getCategories: (rid) => Promise.resolve(db.rows('menu_categories').filter((c) => c.restaurant_id === rid)
      .map((c) => ({ id: c.id, name: c.name, sort_order: c.sort_order, discount_exempt: false, availability: null }))),
    getItems: (rid) => Promise.resolve(db.rows('menu_items').filter((i) => i.restaurant_id === rid)
      .map((i) => ({ id: i.id, category_id: i.category_id, name: i.name, description: null, is_available: i.is_available, sort_order: i.sort_order }))),
    getItemSizes: () => Promise.resolve([]),
    getToppingGroups: () => Promise.resolve([]),
    getToppings: () => Promise.resolve([]),
    getItemToppingGroups: () => Promise.resolve([]),
    getActivePromotions: () => Promise.resolve([]),
  };
}
