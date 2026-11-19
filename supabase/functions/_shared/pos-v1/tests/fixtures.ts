/**
 * Test fixtures: an in-memory PricingDb over plain DB-shaped rows (decimal
 * strings for numeric columns, as PostgREST returns them).
 *
 * The fake getRestaurant deliberately returns the WHOLE row, secret columns
 * included, so the response tests prove nothing from the row leaks even if
 * the loader were handed more than RESTAURANT_COLUMNS.
 */
import type {
  CategoryRow,
  ItemSizeRow,
  ItemToppingGroupRow,
  MenuItemRow,
  PricingDb,
  PromotionRow,
  RedemptionRow,
  RestaurantRow,
  SessionRow,
  ToppingGroupRow,
  ToppingRow,
  UberQuoteRow,
} from '../db.ts';
import { hashToken } from '../loader.ts';

// ---- deterministic UUIDs by label ----------------------------------------------

const ids = new Map<string, string>();
export function id(label: string): string {
  let v = ids.get(label);
  if (!v) {
    v = `00000000-0000-4000-8000-${(ids.size + 1).toString(16).padStart(12, '0')}`;
    ids.set(label, v);
  }
  return v;
}

// ---- in-memory db --------------------------------------------------------------------

export interface Tables {
  restaurants: Record<string, unknown>[];
  menu_items: MenuItemRow[];
  menu_categories: CategoryRow[];
  item_sizes: ItemSizeRow[];
  toppings: ToppingRow[];
  topping_groups: ToppingGroupRow[];
  item_topping_groups: ItemToppingGroupRow[];
  promotions: PromotionRow[];
  loyalty_redemptions: RedemptionRow[];
  loyalty_rewards: { id: string; min_subtotal_cents: number }[];
  customer_sessions: (SessionRow & { token_hash: string })[];
  uber_quotes: UberQuoteRow[];
}

export function emptyTables(): Tables {
  return {
    restaurants: [], menu_items: [], menu_categories: [], item_sizes: [], toppings: [], topping_groups: [], item_topping_groups: [],
    promotions: [], loyalty_redemptions: [], loyalty_rewards: [], customer_sessions: [], uber_quotes: [],
  };
}

export class FakeDb implements PricingDb {
  calls: string[] = [];
  constructor(public t: Tables) {}
  getRestaurant(rid: string) {
    this.calls.push('restaurants');
    return Promise.resolve((this.t.restaurants.find((r) => r.id === rid) as unknown as RestaurantRow) ?? null);
  }
  getMenuItems(restaurantId: string, list: string[]) {
    return Promise.resolve(this.t.menu_items.filter((i) => i.restaurant_id === restaurantId && list.includes(i.id)));
  }
  getCategories(restaurantId: string, list: string[]) {
    return Promise.resolve(this.t.menu_categories.filter((c) => c.restaurant_id === restaurantId && list.includes(c.id)));
  }
  getItemSizes(itemIds: string[]) {
    return Promise.resolve(this.t.item_sizes.filter((s) => itemIds.includes(s.item_id)));
  }
  getToppings(restaurantId: string, list: string[]) {
    return Promise.resolve(this.t.toppings.filter((x) => x.restaurant_id === restaurantId && list.includes(x.id)));
  }
  getToppingGroups(restaurantId: string, list: string[]) {
    return Promise.resolve(this.t.topping_groups.filter((g) => g.restaurant_id === restaurantId && list.includes(g.id)));
  }
  getItemToppingGroups(itemIds: string[]) {
    return Promise.resolve(this.t.item_topping_groups.filter((l) => itemIds.includes(l.item_id)));
  }
  getActivePromotions(restaurantId: string) {
    return Promise.resolve(this.t.promotions.filter((p) => p.restaurant_id === restaurantId && p.is_active));
  }
  getRedemption(rid: string) {
    return Promise.resolve(this.t.loyalty_redemptions.find((r) => r.id === rid) ?? null);
  }
  getRewardMinSubtotalCents(rewardId: string) {
    return Promise.resolve(this.t.loyalty_rewards.find((r) => r.id === rewardId)?.min_subtotal_cents ?? null);
  }
  getSessionByTokenHash(h: string) {
    const s = this.t.customer_sessions.find((x) => x.token_hash === h);
    return Promise.resolve(s ? { customer_id: s.customer_id, revoked_at: s.revoked_at, expires_at: s.expires_at } : null);
  }
  getUberQuote(q: string) {
    return Promise.resolve(this.t.uber_quotes.find((x) => x.quote_id === q) ?? null);
  }
}

// ---- restaurants -----------------------------------------------------------------------

export const SECRET_VALUES = {
  uber_client_secret: 'SECRET-uber-client-secret-xyz',
  uber_webhook_signing_secret: 'SECRET-uber-webhook-signing-abc',
};

export const RESTAURANT_LAT = 40.0;
export const RESTAURANT_LNG = -74.0;

/** A full restaurants row (extra columns included on purpose). */
export function restaurantRow(rid: string, over: Partial<RestaurantRow> = {}): Record<string, unknown> {
  return {
    id: rid,
    name: 'Fixture Pizza',
    slug: 'fixture',
    stripe_account_id: 'acct_fixture',
    ...SECRET_VALUES,
    timezone: 'America/New_York',
    tax_rate: '0.08875',
    recoup_enabled: false,
    recoup_rate: '0.0000',
    loyalty_enabled: false,
    loyalty_earn_basis: 'subtotal',
    loyalty_points_per_dollar: '1.00',
    latitude: RESTAURANT_LAT,
    longitude: RESTAURANT_LNG,
    delivery_max_radius_miles: null,
    delivery_tier1_max_miles: null,
    delivery_tier1_fee_cents: null,
    delivery_tier2_fee_cents: null,
    delivery_minimum_in_house: '0.00',
    delivery_minimum_uber_direct: '0.00',
    delivery_fulfillment: 'in_house',
    uber_credentials_verified_at: null,
    uber_direct_active: false,
    uber_schedule: null,
    uber_billing_mode: 'self',
    uber_passthrough_mode: 'customer_full',
    uber_passthrough_value: '0',
    uber_extends_delivery: false,
    uber_max_radius_miles: null,
    ...over,
  };
}

/** Point `miles` due north of the restaurant (haversine along a meridian). */
export function pointAtMiles(miles: number): { lat: number; lng: number } {
  return { lat: RESTAURANT_LAT + (miles / 3958.8) * (180 / Math.PI), lng: RESTAURANT_LNG };
}

// ---- golden menu (PRICING-SPEC golden fixtures as DB rows) ---------------------------------

type SP = Record<string, { price: string | null; half: string | null }>;
const TOPPINGS: Record<string, { price: string; price_half: string | null; size_prices?: SP }> = {
  pepperoni: { price: '2.50', price_half: null },
  sausage: { price: '2.75', price_half: null },
  extra_cheese: { price: '1.15', price_half: null }, // half 0.575 → 58¢ (D3)
  ricotta: { price: '1.15', price_half: null }, // second 1.15 topping, see G5
  mushrooms: { price: '2.25', price_half: '1.25', size_prices: { small: { price: '1.75', half: null }, large: { price: '2.25', half: null } } },
  onions: { price: '1.50', price_half: null, size_prices: { small: { price: '1.15', half: null } } },
  fresh_garlic: { price: '1.00', price_half: '0.50' },
  anchovies: { price: '2.01', price_half: null }, // half 1.005 → 101¢ (D3)
};

/** Adds the standard pizzeria menu to restaurant `rk` (labels are prefixed by rk). */
export function addMenu(t: Tables, rk: string): void {
  const rid = id(rk);
  // Promo exemption is a category flag (migration 052): drinks are exempt.
  t.menu_categories.push({ id: id(`${rk}:cat:main`), restaurant_id: rid, availability: null, discount_exempt: false });
  t.menu_categories.push({ id: id(`${rk}:cat:drinks`), restaurant_id: rid, availability: null, discount_exempt: true });
  const item = (key: string, sizes: [string, string][], exempt = false) => {
    t.menu_items.push({ id: id(`${rk}:item:${key}`), restaurant_id: rid, category_id: id(`${rk}:cat:${exempt ? 'drinks' : 'main'}`), is_available: true });
    for (const [name, price] of sizes) {
      t.item_sizes.push({ id: id(`${rk}:size:${key}:${name}`), item_id: id(`${rk}:item:${key}`), name, price });
    }
  };
  item('pie', [['Large', '18.99'], ['Small', '13.99']]);
  item('specialty', [['Large', '19.50']]);
  item('knots', [['6 pc', '5.99']]);
  item('wings', [['10 pc', '14.99']]);
  item('caesar', [['Regular', '9.99']]);
  item('soda', [['2 liter', '3.49']], true);

  const group = (key: string, placement_type: string, items: string[]) => {
    t.topping_groups.push({ id: id(`${rk}:group:${key}`), restaurant_id: rid, placement_type });
    for (const it of items) t.item_topping_groups.push({ item_id: id(`${rk}:item:${it}`), topping_group_id: id(`${rk}:group:${key}`) });
  };
  group('pizza', 'pizza', ['pie', 'specialty']);
  group('wing_extras', 'addon', ['wings']);
  group('salad_extras', 'addon', ['caesar']);

  for (const [key, tp] of Object.entries(TOPPINGS)) {
    t.toppings.push({
      id: id(`${rk}:top:${key}`), restaurant_id: rid, topping_group_id: id(`${rk}:group:pizza`),
      price: tp.price, price_half: tp.price_half, size_prices: tp.size_prices ?? null, is_available: true,
    });
  }
  t.toppings.push({ id: id(`${rk}:top:ranch`), restaurant_id: rid, topping_group_id: id(`${rk}:group:wing_extras`), price: '0.75', price_half: null, size_prices: null, is_available: true });
  t.toppings.push({ id: id(`${rk}:top:chicken`), restaurant_id: rid, topping_group_id: id(`${rk}:group:salad_extras`), price: '3.50', price_half: null, size_prices: null, is_available: true });
}

/** A signed-in customer: returns the raw session token. */
export async function addSession(t: Tables, customerLabel: string, over: Partial<SessionRow> = {}): Promise<string> {
  const token = `token-${customerLabel}`;
  t.customer_sessions.push({
    token_hash: await hashToken(token),
    customer_id: id(`customer:${customerLabel}`),
    revoked_at: null,
    expires_at: '2099-01-01T00:00:00Z',
    ...over,
  });
  return token;
}

/** Request line helper. */
export function line(rk: string, item: string, size: string | null, quantity = 1, mods: [string, ('whole' | 'left' | 'right')?][] = []) {
  return {
    menuItemId: id(`${rk}:item:${item}`),
    itemSizeId: size ? id(`${rk}:size:${item}:${size}`) : null,
    quantity,
    modifiers: mods.map(([top, placement]) => ({ toppingId: id(`${rk}:top:${top}`), ...(placement ? { placement } : {}) })),
  };
}

export const NOW = new Date('2026-11-19T17:00:00Z'); // noon Eastern

export function headers(version: string | null = '1'): Headers {
  const h = new Headers({ 'content-type': 'application/json' });
  if (version !== null) h.set('x-ordr-api-version', version);
  return h;
}
