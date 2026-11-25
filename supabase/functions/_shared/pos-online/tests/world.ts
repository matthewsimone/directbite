/**
 * The pos-online handler test world: the device middleware (pos-device harness), MemoryOnlineStore (= 110 + 111 SQL,
 * bound to the fake's orders / restaurants for the order actions) and an in-memory PostgREST (fakeSupabase.ts).
 * Test Pizza (R1), negative order numbers, made-up ids. Shared by handlers.test.ts and actions.test.ts.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { FAKE_IP, harness, ok, R1, R2, type Registered } from '../../pos-device/tests/harness.ts';
import { handleOnlineOrderAction, handleOnlineOrders, handleOnlinePrint, handleOnlineSettings, type OnlineDeps } from '../handlers.ts';
import { handleKitchenhubItems } from '../khItemsHandler.ts';
import type { OnlineStationRef } from '../printRules.ts';
import { MemoryOnlineStore } from '../store.ts';
import type { OnlineOrderWire } from '../wire.ts';
import { FakeSupabase } from './fakeSupabase.ts';
import { parseOnlineOrder } from './referenceParse.ts';
import { fakeSnapshotDb } from './snapshotDb.ts';
import { moneyFakes } from './moneyFakes.ts';

export const CAT_PIZZA = 'c0000000-0000-4000-8000-0000000000c1';
export const CAT_SIDES = 'c0000000-0000-4000-8000-0000000000c2';
export const ITEM_CHEESE = 'c0000000-0000-4000-8000-0000000000a1';
export const ITEM_KNOTS = 'c0000000-0000-4000-8000-0000000000a2';
export const COUNTER: OnlineStationRef = { station: 'p-counter', name: 'Counter', lines: [0, 1] };
export const OVEN: OnlineStationRef = { station: 'p-oven', name: 'Pizza oven', lines: [0] };

let seq = 0;
export const uid = (p = 'e') => `${p.repeat(8)}-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function restaurantRow(o: Record<string, unknown> = {}) {
  return {
    id: R1, timezone: 'America/New_York', pickup_schedule: null, delivery_schedule: null, estimated_pickup_minutes: 20, estimated_delivery_minutes: 45,
    ready_time_confirmation_enabled: false, delivery_available: true, print_trigger: 'received', auto_print_copies: 1, receipt_font: 'standard',
    dsp_orders_enabled: false, delivery_fulfillment: 'both', uber_direct_active: true, ...o,
  };
}

/** An orders row as PostgREST returns FEED_SELECT (items + current category + toppings + adjustments embedded). */
// deno-lint-ignore no-explicit-any
export function ordrRow(at: string, o: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: uid(), order_number: -(++seq), restaurant_id: R1, status: 'new', order_type: 'pickup',
    customer_name: 'Test Customer', customer_phone: '5165550142', phone_e164: '+15165550142', customer_email: 'test@example.test',
    delivery_address: null, subtotal: 26.98, discount_amount: 0, discount_percentage: 0, delivery_fee: 0, tax_amount: 2.39, tip_amount: 4.05,
    service_fee: 1.5, total_amount: 34.92, loyalty_discount_amount: 0, print_status: 'pending', print_attempts: 0,
    special_instructions: 'Extra napkins please', include_utensils: true, refund_status: null, refund_amount: null, refunded_at: null, refund_reason: null,
    scheduled_for: null, accepted_at: null, acknowledged_at: null, stuck_acknowledged_at: null, quoted_for: null, cancelled_by: null,
    delivery_fulfillment_method: 'in_house', uber_delivery_id: null, uber_status: null, uber_tracking_url: null, uber_pickup_ready_dt: null,
    uber_pickup_eta: null, uber_dropoff_eta: null, uber_dispatched_at: null, uber_status_updated_at: null, uber_courier_info: null,
    items_written_at: at, created_at: at,
    order_items: [
      {
        id: uid('a'), created_at: at, menu_item_id: ITEM_CHEESE, menu_items: { category_id: CAT_PIZZA }, item_name: 'Cheese Pizza', size_name: 'Large 16"',
        base_price: 18.99, quantity: 1, special_instructions: 'Well done', discount_exempt: false, loyalty_redemption_id: null,
        order_item_toppings: [{ id: uid('b'), topping_name: 'Pepperoni', placement: 'whole', placement_type: 'pizza', price_charged: 2 }],
      },
      {
        id: uid('a'), created_at: at, menu_item_id: ITEM_KNOTS, menu_items: { category_id: CAT_SIDES }, item_name: 'Garlic Knots', size_name: null,
        base_price: 5.99, quantity: 1, special_instructions: null, discount_exempt: false, loyalty_redemption_id: null, order_item_toppings: [],
      },
    ],
    adjustment_requests: [],
    ...o,
  };
}

// deno-lint-ignore no-explicit-any
export function khRow(at: string, o: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: uid('f'), restaurant_id: R1, kh_order_id: 900000 + (++seq), kh_store_id: 'kh-test', provider_id: 'doordash', provider_name: 'DoorDash',
    order_number: 'A1B2C', daily_number: 12, order_type: 'delivery', status: 'new', kh_status_raw: 'new', asap: true, scheduled_for: null,
    pickup_at: null, placed_at: at, customer_name: 'Jordan P.', customer_phone: null, customer_phone_code: null, notes: 'Leave at the counter',
    delivery_type: 'provider', delivery: { type: 'provider', courier: { name: 'Sam', phone_number: null, status: 'assigned' } },
    items: [
      {
        name: 'Large Cheese Pizza', quantity: 1,
        options: [
          { name: 'Half & Half', modifier_name: 'Style', options: [{ name: 'Left: Pepperoni', modifier_name: 'Half & Half' }, { name: 'Right: Mushroom', modifier_name: 'Half & Half' }] },
          { name: 'Extra cheese', modifier_name: 'Extras', quantity: 2 },
        ],
      },
      { name: 'DD Exclusive Combo #3', quantity: 2, instructions: 'No onions' },
    ],
    charges: { subtotal: 41.47, tax: 3.68, tips: 5, total: 50.15, service_fee: 'n/a' }, total: 50.15, payment_method: 'card', prep_time_minutes: null,
    acknowledged_at: null, accepted_at: null, completed_at: null, cancelled_at: null, cancelled_by: null,
    print_status: 'pending', print_attempts: 0, printed_at: null, last_print_error: null, paid: true, raw: { never: 'served' }, created_at: at,
    ...o,
  };
}

export async function world(o: { restaurant?: Record<string, unknown> } = {}) {
  const h = harness();
  const A = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const B = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const X = ok<Registered>(await h.register(h.req((await h.enroll({ restaurantId: R2 })).code)));
  const db = new FakeSupabase();
  const online = new MemoryOnlineStore(h.clock.now, {
    orders: () => db.rows('orders'), restaurants: () => db.rows('restaurants'), menu_items: () => db.rows('menu_items'), adjustment_requests: () => db.rows('adjustment_requests'),
    menu_categories: () => db.rows('menu_categories'), kitchenhub_item_maps: () => db.rows('pos_kitchenhub_item_maps'),
  });
  for (const d of [A, B, X]) online.devices.set(d.device_id, { id: d.device_id, restaurant_id: d.restaurant_id, status: 'active' });
  db.insertRow('restaurants', restaurantRow(o.restaurant));
  db.insertRow('restaurants', restaurantRow({ id: R2 }));
  for (let d = 0; d < 7; d++) db.insertRow('hours', { restaurant_id: R1, day_of_week: d, is_open: true, open_time: '11:00', close_time: '22:00' });
  const readyEmails: string[] = [];
  const deps: OnlineDeps = { ...h.deps, db, online, sleep: () => Promise.resolve(), readyEmail: (id) => void readyEmails.push(id), snapshotDb: fakeSnapshotDb(db), refund: undefined };
  const money = moneyFakes(db);
  deps.refund = { stripe: money.stripe, cancelUberDelivery: money.cancelUberDelivery, refundUberAppFee: money.refundUberAppFee };
  deps.uber = { createUberDelivery: money.createUberDelivery };
  const nowIso = () => new Date(h.clock.now()).toISOString();
  const call = (fn: typeof handleOnlineOrders, body: unknown, dev: Registered = A) =>
    fn({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', 'x-ordr-client': 'ordr-pos/1.0.0', ...h.asDevice(dev) }), bodyText: JSON.stringify(body), ip: FAKE_IP }, deps);
  const poll = (body: Record<string, unknown> = {}, dev: Registered = A) => call(handleOnlineOrders, { restaurant_id: R1, if_none_match: null, if_none_match_settings: null, ...body }, dev);
  const print = (body: Record<string, unknown>, dev: Registered = A) =>
    call(handleOnlinePrint, { action_id: crypto.randomUUID(), restaurant_id: R1, stations: null, station: null, variant: null, result: null, error: null, device_time: nowIso(), ...body }, dev);
  /** pos-v1-online-order-action: every key present, null when unused (§3c:596-601). */
  const action = (body: Record<string, unknown>, dev: Registered = A) =>
    call(handleOnlineOrderAction, {
      action_id: crypto.randomUUID(), restaurant_id: R1, order_id: null, action: 'ack', expected_status: null, quoted_ready_minutes: null,
      prep_minutes: null, amount_cents: null, adjustment_type: null, accepted_quote_id: null, reason: null, approver_staff_id: null,
      actor_staff_id: 'register', device_time: nowIso(), ...body,
    }, dev);
  /** pos-v1-online-settings (§3c:649-657). */
  const settings = (change: unknown, body: Record<string, unknown> = {}, dev: Registered = A) =>
    call(handleOnlineSettings, { action_id: crypto.randomUUID(), restaurant_id: R1, change, approver_staff_id: null, actor_staff_id: 'register', device_time: nowIso(), ...body }, dev);
  const autoOn = async () => {
    await online.setPrintRegister(R1, A.device_id, 'admin@example.test');
    online.setFlags(R1, { online_auto_print_enabled: true, kitchenhub_auto_print_enabled: true, pos_online_orders_enabled: true });
  };
  /** pos-v1-kitchenhub-items (CP21). */
  const items = (body: Record<string, unknown>, dev: Registered = A) =>
    call(handleKitchenhubItems, { restaurant_id: R1, actor_staff_id: 'register', approver_staff_id: null, device_time: nowIso(), ...body }, dev);
  const order = (id: string) => db.rows('orders').find((r) => r.id === id)!;
  const logs = (id: string) => db.rows('print_logs').filter((r) => r.order_id === id);
  return { h, A, B, X, online, db, deps, poll, print, action, settings, items, autoOn, order, logs, nowIso, readyEmails, money };
}

export function served(body: unknown): OnlineOrderWire[] {
  const b = body as { orders: unknown[] };
  for (const raw of b.orders) {
    const p = parseOnlineOrder(raw);
    assertEquals(p.kind, 'ok', `the POS could not read a served row: ${JSON.stringify(p)}`);
  }
  return b.orders as OnlineOrderWire[];
}


/** The world's SnapshotDb (the fake's menu rows) — for computing the expected snapshot hash in tests. */
export function snapshotDbOf(w: { db: FakeSupabase }) {
  return fakeSnapshotDb(w.db);
}
