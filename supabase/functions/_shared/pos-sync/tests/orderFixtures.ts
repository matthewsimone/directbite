/** Order fixtures shared by the submit-order and staff tests (ordr-pos test/support/fixtures.ts makeSnapshot as wire). */
import { contentHash, ORDER_HASH_EXCLUDES, SNAPSHOT_HASH_EXCLUDES } from '../canonicalJson.ts';
import type { MenuSnapshot } from '../menuSnapshot.ts';
import type { OrderPayload, WireLine, WirePayment } from '../orderPayload.ts';
import { priceAgainstSnapshot } from '../orderPricing.ts';
import { R1 } from '../../pos-device/tests/harness.ts';
import type { Registered } from '../../pos-device/tests/harness.ts';

// ---- fixture: ordr-pos test/support/fixtures.ts makeSnapshot, as the wire form ---------------------

export const IDS = {
  catPizza: 'cat-pizza', catSides: 'cat-sides', catDrinks: 'cat-drinks',
  pie: 'item-pie', pieLarge: 'size-pie-large', pieSmall: 'size-pie-small',
  knots: 'item-knots', knotsReg: 'size-knots-reg', soda: 'item-soda', sodaReg: 'size-soda-reg',
  gToppings: 'grp-toppings', gAddons: 'grp-addons',
  pepperoni: 'top-pepperoni', extraCheese: 'top-extra-cheese', mushrooms: 'top-mushrooms', ranch: 'top-ranch',
} as const;

export interface SnapOpts {
  taxRate?: string;
  piePriceLarge?: number;
  promoPercent?: string;
  sidesAvailability?: Record<string, { start: string | null; end: string | null }> | null;
  knotsUnavailable?: boolean;
  mushroomsUnavailable?: boolean;
  largeName?: string;
  mushroomSizePrices?: MenuSnapshot['toppings'][number]['size_prices'];
  restaurantId?: string;
}

export async function snapshot(o: SnapOpts = {}): Promise<MenuSnapshot> {
  const body: Omit<MenuSnapshot, 'hash'> = {
    server_time: '2026-11-19T16:00:00.000Z',
    restaurant: {
      id: o.restaurantId ?? R1,
      name: 'Test Pizza',
      address: { street: '100 Washington St', city: 'Hoboken', state: 'NJ', zip: '07030', phone: '+12015550100' },
      timezone: 'America/New_York',
      business_day_cutoff: '04:00',
      tax_rate: o.taxRate ?? '0.08875',
      recoup_rate: '0',
      delivery: { max_radius_miles: '5', tier1_max_miles: '2', tier1_fee_cents: 299, tier2_fee_cents: 499, minimum_in_house_cents: 1500, minimum_uber_direct_cents: 0, offline_fee_cents: 499, enabled: true, fulfillment: 'in_house' },
      loyalty: { enabled: true, earn_basis: 'subtotal', points_per_dollar: '1' },
    },
    promotion: o.promoPercent ? { id: 'promo-1', discount_percent: o.promoPercent } : null,
    categories: [
      { id: IDS.catPizza, name: 'Pizza', sort_order: 1, available: true, discount_exempt: false, availability: null },
      { id: IDS.catSides, name: 'Sides', sort_order: 2, available: true, discount_exempt: false, availability: o.sidesAvailability ?? null },
      { id: IDS.catDrinks, name: 'Drinks', sort_order: 3, available: true, discount_exempt: true, availability: null },
    ],
    items: [
      { id: IDS.pie, category_id: IDS.catPizza, name: 'Pie', description: null, is_available: true, sort_order: 1 },
      { id: IDS.knots, category_id: IDS.catSides, name: 'Garlic knots (6)', description: null, is_available: !o.knotsUnavailable, sort_order: 1 },
      { id: IDS.soda, category_id: IDS.catDrinks, name: '2-liter soda', description: null, is_available: true, sort_order: 1 },
    ],
    item_sizes: [
      { id: IDS.pieLarge, item_id: IDS.pie, name: o.largeName ?? 'Large', price_cents: o.piePriceLarge ?? 1899, sort_order: 2 },
      { id: IDS.pieSmall, item_id: IDS.pie, name: 'Small', price_cents: 1399, sort_order: 1 },
      { id: IDS.knotsReg, item_id: IDS.knots, name: 'Regular', price_cents: 599, sort_order: 1 },
      { id: IDS.sodaReg, item_id: IDS.soda, name: 'Regular', price_cents: 349, sort_order: 1 },
    ],
    topping_groups: [
      { id: IDS.gToppings, name: 'Toppings', placement_type: 'pizza', selection_type: 'unlimited', required: false, max_selections: null, sort_order: 1 },
      { id: IDS.gAddons, name: 'Add-ons', placement_type: 'addon', selection_type: 'unlimited', required: false, max_selections: null, sort_order: 2 },
    ],
    toppings: [
      { id: IDS.pepperoni, group_id: IDS.gToppings, name: 'Pepperoni', price_cents: 250, price_half_cents: null, size_prices: null, is_available: true, is_default: false, sort_order: 1 },
      { id: IDS.extraCheese, group_id: IDS.gToppings, name: 'Extra cheese', price_cents: 115, price_half_cents: null, size_prices: null, is_available: true, is_default: false, sort_order: 2 },
      {
        id: IDS.mushrooms, group_id: IDS.gToppings, name: 'Mushrooms', price_cents: 225, price_half_cents: 125,
        size_prices: o.mushroomSizePrices !== undefined ? o.mushroomSizePrices : [{ size_key: 'large', price_cents: 300, half_cents: null }, { size_key: 'small', price_cents: 175, half_cents: null }],
        is_available: !o.mushroomsUnavailable, is_default: false, sort_order: 3,
      },
      { id: IDS.ranch, group_id: IDS.gAddons, name: 'Ranch', price_cents: 75, price_half_cents: null, size_prices: null, is_available: true, is_default: false, sort_order: 1 },
    ],
    item_topping_groups: [
      { item_id: IDS.pie, group_id: IDS.gToppings, is_active: true, sort_order: 1 },
      { item_id: IDS.knots, group_id: IDS.gAddons, is_active: true, sort_order: 1 },
    ],
  };
  return { hash: await contentHash(body as unknown as Record<string, unknown>, SNAPSHOT_HASH_EXCLUDES), ...body };
}

// ---- payload builder (the device's payload shape, src/db/repo/payload.ts) -------------------------

export const uuid = () => crypto.randomUUID();
export const DEVICE_TIME = '2026-11-19T17:00:00Z'; // Thursday 12:00 New York

export function line(item: string, size: string | null, o: Partial<WireLine> = {}): WireLine {
  return {
    id: uuid(), position: 0, menu_item_id: item, item_size_id: size, item_name: item, size_name: null, quantity: 1,
    base_price_cents: 0, discount_exempt: false, status: 'active', void_reason: null, voided_by: null, void_approved_by: null,
    seat: null, course: null, check_no: null, fired_seq: null, special_instructions: null, modifiers: [], ...o,
  };
}
export const mod = (topping: string, placement: 'whole' | 'left' | 'right' | null = 'whole', o: Record<string, unknown> = {}) => ({
  id: uuid(), position: 0, kind: 'pizza' as const, topping_id: topping, name: topping, placement, price_cents: 0, price_half_cents: null, size_prices: null, charge_cents: 0, ...o,
});
export function cash(amount: number, o: Partial<WirePayment> = {}): WirePayment {
  return { id: uuid(), method: 'cash', amount_cents: amount, tendered_cents: amount, change_cents: 0, status: 'captured', check_no: null, last4: null, external_ref: null, taken_by: 'register', voided_by: null, void_approved_by: null, void_reason: null, ...o };
}
export function card(amount: number, o: Partial<WirePayment> = {}): WirePayment {
  return cash(amount, { method: 'external_card', last4: '1234', external_ref: 'AUTH 004211', ...o });
}

export async function rehash(p: OrderPayload): Promise<OrderPayload> {
  p.content_hash = await contentHash(p as unknown as Record<string, unknown>, ORDER_HASH_EXCLUDES);
  return p;
}

/** A payload whose provisional pricing = the server's (no mismatch) unless given. */
export async function payload(dev: Registered, snap: MenuSnapshot, o: Partial<OrderPayload> = {}, provisionalFrom?: MenuSnapshot): Promise<OrderPayload> {
  const p: OrderPayload = {
    order_id: uuid(), version: 1, base_server_version: 0, content_hash: '',
    restaurant_id: dev.restaurant_id, device_id: dev.device_id,
    ticket: { prefix: dev.prefix, business_date: '2026-11-19', counter: 1 },
    order_type: 'pickup', channel: 'counter', status: 'closed',
    customer: { name: null, phone_e164: null }, note: null, ready_at: null, void_reason: null,
    created_by: 'register', closed_by: 'register', voided_by: null, void_approved_by: null,
    delivery: null, table: { label: null, guest_count: null }, menu_snapshot_hash: snap.hash,
    lines: [line(IDS.pie, IDS.pieLarge)],
    tip: { mode: 'none', percent: null, amount_cents: null }, payments: [],
    provisional_pricing: null as unknown as OrderPayload['provisional_pricing'],
    pricing_config: { tax_rate: '0.08875', promo_percent: null, base_service_fee_cents: 0, recoup_rate: '0', delivery_minimum_cents: 0 },
    device_time: DEVICE_TIME,
    ...o,
  };
  if (!o.provisional_pricing) p.provisional_pricing = priceAgainstSnapshot(p, provisionalFrom ?? snap).pricing;
  return await rehash(p);
}

/** Next version of an order (the device's next outbox entry). */
export async function next(p: OrderPayload, o: Partial<OrderPayload> = {}, snap?: MenuSnapshot): Promise<OrderPayload> {
  const n: OrderPayload = { ...structuredClone(p), version: p.version + 1, ...o };
  if (snap && !o.provisional_pricing) n.provisional_pricing = priceAgainstSnapshot(n, snap).pricing;
  return await rehash(n);
}

