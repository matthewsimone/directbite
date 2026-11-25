/**
 * POS delivery (CP23) end to end over the device middleware, MemoryDeliveryStore (= 115 SQL), the in-memory
 * PostgREST (restaurants) and a fake Uber HTTP server (the COPIED Uber calls run for real against it — payloads,
 * status mapping, parse) + a fake geocoder. Matt's decisions: server geocode → Uber quote → the restaurant's EXISTING
 * passthrough split → the customer fee; driver tip (default $0); CARD ONLY; dispatch only after paid in full;
 * polling (≤ every 30 s); dispatch behind pos_delivery_dispatch_enabled (default off; quotes work when off); the full
 * ledger; provider-neutral. CP20 rules: never double-book.
 * ordr-pos @ 4f729e4 DELIVERY.md §2 (the quote: request / response / address_not_found / 24 h / out of radius),
 * §6.3 (the Uber flow), §7.1 (delivery.uber).
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { err, harness, ok, R1, R2, type Registered } from '../../pos-device/tests/harness.ts';
import { FakeSupabase } from '../../pos-online/tests/fakeSupabase.ts';
import { applyPassthrough } from '../../uberPassthrough.ts';
import type { MenuSnapshot } from '../../pos-sync/menuSnapshot.ts';
import { handleDeliveryCancel, handleDeliveryDispatch, handleDeliveryStatus, handleQuoteDelivery, PENDING_STALE_MS, POLL_EVERY_MS, type DeliveryDeps } from '../handlers.ts';
import { MemoryDeliveryStore, type PosOrderForDelivery } from '../store.ts';
import type { GeocodeResult } from '../geocode.ts';

const MIN = 60_000;
const HASH = 'snap-hash-1';
const SNAP = {
  hash: HASH,
  restaurant: { delivery: { max_radius_miles: '5', tier1_max_miles: '2', tier1_fee_cents: 299, tier2_fee_cents: 499, minimum_in_house_cents: 1500, minimum_uber_direct_cents: 0, offline_fee_cents: 499, enabled: true, fulfillment: 'both' } },
} as unknown as MenuSnapshot;

// restaurant at Hoboken (40.7440, -74.0324); test addresses by distance
const GEO: Record<string, GeocodeResult> = {
  '1 River St, Hoboken, NJ 07030': { kind: 'ok', lat: 40.7500, lng: -74.0300, formatted: '1 River St, Hoboken, NJ 07030, USA', partial: false },         // ~0.43 mi
  '500 Grove St Apt 2, Jersey City, NJ 07302': { kind: 'ok', lat: 40.7200, lng: -74.0450, formatted: '500 Grove St Apt 2, Jersey City, NJ 07302, USA', partial: true }, // ~1.8 mi
  '9 Far Rd, Newark, NJ 07102': { kind: 'ok', lat: 40.7357, lng: -74.1724, formatted: '9 Far Rd, Newark, NJ 07102, USA', partial: false },              // ~7.3 mi
  '2 Mid Ave, Union City, NJ 07087': { kind: 'ok', lat: 40.7700, lng: -74.0300, formatted: '2 Mid Ave, Union City, NJ 07087, USA', partial: false },     // ~1.8 → tier 1
  '3 Edge Ave, Weehawken, NJ 07086': { kind: 'ok', lat: 40.7800, lng: -74.0100, formatted: '3 Edge Ave, Weehawken, NJ 07086, USA', partial: false },     // ~2.7 → tier 2
};

type UberCall = { method: string; path: string; body: Record<string, unknown> | null };

function uberServer() {
  const calls: UberCall[] = [];
  const state = {
    quoteFee: 900, quoteStatus: 200, quoteSeq: 0, quoteExpiresInMs: 10 * MIN,
    createStatus: 200, createSeq: 0, cancelStatus: 200, cancelFee: null as number | null,
    getStatus: 'pending', courier: null as Record<string, unknown> | null, rateLimitNext: 0,
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (state.rateLimitNext > 0) {
      state.rateLimitNext--;
      return Promise.resolve(json(429, {}, { 'retry-after': '7' }));
    }
    if (url.pathname.endsWith('/delivery_quotes')) {
      if (state.quoteStatus !== 200) return Promise.resolve(json(state.quoteStatus, { message: 'no' }));
      return Promise.resolve(json(200, { id: `dqt_${++state.quoteSeq}`, fee: state.quoteFee, expires: new Date(Date.now() + state.quoteExpiresInMs).toISOString(), dropoff_eta: new Date(Date.now() + 40 * MIN).toISOString() }));
    }
    if (url.pathname.endsWith('/cancel')) {
      if (state.cancelStatus !== 200) return Promise.resolve(json(state.cancelStatus, { message: 'too late' }));
      return Promise.resolve(json(200, state.cancelFee === null ? {} : { cancellation_fee: state.cancelFee }));
    }
    if (url.pathname.endsWith('/deliveries') && init?.method === 'POST') {
      if (state.createStatus !== 200) return Promise.resolve(json(state.createStatus, { message: 'bad' }));
      const id = `del_${++state.createSeq}`;
      return Promise.resolve(json(200, { id, tracking_url: `https://track.example/${id}`, status: 'pending' }));
    }
    if (/\/deliveries\/[^/]+$/.test(url.pathname)) {
      return Promise.resolve(json(200, { status: state.getStatus, courier: state.courier, dropoff_eta: '2026-11-19T18:00:00Z', pickup_eta: '2026-11-19T17:30:00Z', tracking_url: 'https://track.example/x' }));
    }
    return Promise.resolve(json(404, {}));
  };
  return { calls, state, fetch: fetchFn as typeof fetch };
}

async function world(o: { restaurant?: Record<string, unknown>; uber?: boolean } = {}) {
  const h = harness();
  const A = ok<Registered>(await h.register(h.req((await h.enroll()).code)));
  const X = ok<Registered>(await h.register(h.req((await h.enroll({ restaurantId: R2 })).code)));
  const db = new FakeSupabase();
  db.insertRow('restaurants', {
    id: R1, name: 'Test Pizza', latitude: 40.744, longitude: -74.0324, address: '100 Washington St, Hoboken, NJ', phone: '2015550100',
    delivery_fulfillment: 'both', uber_credentials_verified_at: '2026-11-01T00:00:00Z', uber_direct_active: true, uber_schedule: null,
    uber_passthrough_mode: 'split', uber_passthrough_value: 50, uber_customer_id: null, uber_environment: 'sandbox', uber_billing_mode: 'platform',
    uber_extends_delivery: false, uber_max_radius_miles: null, ...o.restaurant,
  });
  const store = new MemoryDeliveryStore(h.clock.now);
  const uber = uberServer();
  const logs: Record<string, unknown>[] = [];
  let hex = 0;
  const deps: DeliveryDeps = {
    ...h.deps,
    log: (event, data = {}) => {
      logs.push({ event, ...data });
      h.deps.log(event, data);
    },
    db,
    delivery: store,
    uber: o.uber === false ? null : {
      supabase: db, getUberToken: () => Promise.resolve({ success: true, access_token: 'tok' }),
      resolveUrlCreds: (r: Record<string, unknown>) => ({ success: true, creds: { customer_id: 'cust_platform', environment: r.uber_environment === 'sandbox' ? 'sandbox' : 'production' } }),
      getUberApiBase: () => 'https://api.uber.test', applyPassthrough, logUber: () => {}, fetch: uber.fetch,
    },
    geocode: (addr) => Promise.resolve(addr === 'DOWN' || addr.startsWith('down') ? { kind: 'unavailable' as const, detail: 'x' } : GEO[addr] ?? { kind: 'not_found' as const }),
    snapshot: (hash, rid) => Promise.resolve(hash === HASH && rid === R1 ? SNAP : null),
    resolveMode: (r) => ({ resolved_mode: r.delivery_fulfillment === 'in_house' || r.uber_direct_active === false ? 'in_house' : 'uber_direct' }),
    hexId: () => String(++hex).padStart(32, '0'),
  };
  const call = (fn: typeof handleQuoteDelivery, body: unknown, dev: Registered = A) =>
    fn({ method: 'POST', headers: new Headers({ 'x-ordr-api-version': '1', 'x-ordr-client': 'ordr-pos/1.0.0', ...h.asDevice(dev) }), bodyText: JSON.stringify(body), ip: null }, deps);
  const quote = (addr: Record<string, unknown>, extra: Record<string, unknown> = {}, dev: Registered = A) =>
    call(handleQuoteDelivery, { address: { unit: null, state: 'NJ', ...addr }, menu_snapshot_hash: HASH, ...extra }, dev);
  /** A synced, closed, card-paid POS Uber delivery order using the given provider quote. */
  const posOrder = (pq: string | null, o: Partial<PosOrderForDelivery> = {}, delivery: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    store.posOrders.set(id, {
      order_id: id, restaurant_id: R1, order_type: 'delivery', channel: 'phone', status: 'closed', total_cents: 3100, subtotal_cents: 2400,
      delivery: { fee_source: 'uber', driver_type: 'uber_direct', address: { instructions: 'Ring twice' }, uber: { quote_id: pq, driver_tip_cents: 300 }, ...delivery },
      customer_name: 'Pat Doe', customer_phone_e164: '+12015550142', note: null, ticket_label: 'F-007',
      lines: [{ item_name: 'Large Cheese', quantity: 2, base_price_cents: 1200 }], payments: [{ method: 'external_card', amount_cents: 3100, status: 'captured' }], ...o,
    });
    return id;
  };
  const dispatch = (orderId: string, extra: Record<string, unknown> = {}, dev: Registered = A) =>
    call(handleDeliveryDispatch, { action_id: crypto.randomUUID(), restaurant_id: R1, order_id: orderId, pickup_ready_minutes: 20, accepted_quote_id: null, actor_staff_id: 'register', approver_staff_id: null, device_time: new Date(h.clock.now()).toISOString(), ...extra }, dev);
  const cancel = (orderId: string, extra: Record<string, unknown> = {}) =>
    call(handleDeliveryCancel, { action_id: crypto.randomUUID(), restaurant_id: R1, order_id: orderId, actor_staff_id: 'register', approver_staff_id: null, device_time: new Date(h.clock.now()).toISOString(), ...extra });
  const status = (ids: string[]) => call(handleDeliveryStatus, { restaurant_id: R1, order_ids: ids });
  /** A quote with Uber for 1 River St → the pq id. */
  const uberQuoteId = async () => ok<{ uber: { quote_id: string } }>(await quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { include_uber: true })).uber.quote_id;
  return { h, A, X, db, store, uber, deps, logs, quote, posOrder, dispatch, cancel, status, uberQuoteId };
}

const errBody = (r: { body: unknown }) => (r.body as { error: Record<string, unknown> }).error;
type Quote = Record<string, unknown> & { uber: Record<string, unknown> | null };

// ---- pos-v1-quote-delivery (DELIVERY.md §2) ------------------------------------------------------------------------

Deno.test('quote: server geocode → haversine from the restaurant → the PINNED snapshot\'s tier fee; stored 24 h; the §2 response; no restaurant_id needed', async () => {
  const w = await world();
  const q = ok<Quote>(await w.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }));
  assertEquals(Object.keys(q).sort(), ['distance_miles', 'expires_at', 'fee_cents', 'in_radius', 'lat', 'lng', 'max_radius_miles', 'needs_confirmation', 'normalized_address', 'quote_id', 'tier', 'uber', 'uber_unavailable_reason']);
  assertEquals([q.in_radius, q.tier, q.fee_cents, q.lat, q.lng, q.max_radius_miles, q.uber, q.needs_confirmation], [true, 1, 299, '40.750000', '-74.030000', '5', null, false]);
  assert(/^\d+\.\d{2}$/.test(String(q.distance_miles)) && Number(q.distance_miles) < 1, String(q.distance_miles));
  assertEquals(Date.parse(String(q.expires_at)) - w.h.clock.now(), 24 * 3600_000);
  assert(/^dq_[0-9a-f]{32}$/.test(String(q.quote_id)));
  const stored = w.store.quotes.get(String(q.quote_id))!;
  assertEquals([stored.restaurant_id, stored.device_id, stored.fee_cents, stored.menu_snapshot_hash], [R1, w.A.device_id, 299, HASH]);
  // tier 2 beyond 2 mi; partial match → needs_confirmation; out of radius → in_radius false, tier / fee null (still stored)
  assertEquals(ok<Quote>(await w.quote({ street: '3 Edge Ave', city: 'Weehawken', zip: '07086' })).fee_cents, 499);
  assertEquals(ok<Quote>(await w.quote({ street: '500 Grove St', unit: 'Apt 2', city: 'Jersey City', zip: '07302' })).needs_confirmation, true);
  const far = ok<Quote>(await w.quote({ street: '9 Far Rd', city: 'Newark', zip: '07102' }));
  assertEquals([far.in_radius, far.tier, far.fee_cents], [false, null, null]);
  assertEquals(w.store.quotes.size, 4);
});

Deno.test('quote refused: address not found → 400 address_not_found; geocoder down → 503 (the POS offers the offline rate); unknown snapshot / bad address / another restaurant → 400', async () => {
  const w = await world();
  assertEquals(err(await w.quote({ street: '404 Nowhere', city: 'Hoboken', zip: '07030' })).code, 'address_not_found');
  const down = await w.quote({ street: 'down', city: 'x', zip: '1' });
  assertEquals([down.status, err(down).code], [503, 'geocode_unavailable']);
  assertEquals(err(await w.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { menu_snapshot_hash: 'other' })).code, 'unknown_snapshot');
  assertEquals(err(await w.quote({ street: '', city: 'Hoboken', zip: '07030' })).code, 'invalid_payload');
  assertEquals(err(await w.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { restaurant_id: R2 })).code, 'restaurant_mismatch');
  assertEquals(w.store.quotes.size, 0);
});

Deno.test('quote + include_uber: the Uber quote (server coordinates) split by the restaurant\'s EXISTING passthrough (split 50 %) → the customer fee; stored with billing mode + environment', async () => {
  const w = await world();
  const q = ok<Quote>(await w.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { include_uber: true }));
  assertEquals([q.uber!.provider, q.uber!.customer_fee_cents, q.uber_unavailable_reason], ['uber_direct', 450, null]);
  const call = w.uber.calls.find((c) => c.path.endsWith('/delivery_quotes'))!;
  assertEquals(call.path, '/v1/customers/cust_platform/delivery_quotes');
  assertEquals([call.body!.dropoff_latitude, call.body!.dropoff_longitude, call.body!.pickup_latitude, call.body!.dropoff_address], [40.75, -74.03, 40.744, JSON.stringify({ street_address: ['1 River St, Hoboken, NJ 07030, USA'], country: 'US' })]);
  const pq = w.store.providerQuotes.get(String(q.uber!.quote_id))!;
  assertEquals([pq.provider_quote_id, pq.provider_fee_cents, pq.customer_fee_cents, pq.restaurant_absorbs_cents, pq.billing_mode, pq.provider_environment, pq.passthrough_mode], ['dqt_1', 900, 450, 450, 'platform', 'sandbox', 'split']);
  assertEquals(pq.delivery_quote_id, q.quote_id);
});

Deno.test('quote + include_uber: not the active method → uber null + not_active; Uber 400 → delivery_unavailable; 429 → rate_limited; not configured → not_configured; the in-house quote still answers', async () => {
  const off = await world({ restaurant: { delivery_fulfillment: 'in_house' } });
  const q1 = ok<Quote>(await off.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { include_uber: true }));
  assertEquals([q1.uber, q1.uber_unavailable_reason, q1.fee_cents, off.uber.calls.length], [null, 'not_active', 299, 0]);
  const w = await world();
  w.uber.state.quoteStatus = 400;
  assertEquals(ok<Quote>(await w.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { include_uber: true })).uber_unavailable_reason, 'delivery_unavailable');
  w.uber.state.quoteStatus = 200;
  w.uber.state.rateLimitNext = 1;
  assertEquals(ok<Quote>(await w.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { include_uber: true })).uber_unavailable_reason, 'rate_limited');
  const none = await world({ uber: false });
  assertEquals(ok<Quote>(await none.quote({ street: '1 River St', city: 'Hoboken', zip: '07030' }, { include_uber: true })).uber_unavailable_reason, 'not_configured');
  assertEquals(w.store.providerQuotes.size, 0);
});

// ---- dispatch ---------------------------------------------------------------------------------------------------

type DispatchBody = { result: string; delivery: Record<string, unknown> | null };

Deno.test('dispatch: switched off by default → 403 delivery_not_enabled (quotes still work); on → the Uber booking (the copied create payload) + the full ledger', async () => {
  const w = await world();
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  const off = await w.dispatch(id);
  assertEquals([off.status, err(off).code], [403, 'delivery_not_enabled']);
  w.store.enabled.add(R1);
  const t0 = w.h.clock.now(); // the server's clock sets the pickup time
  const b = ok<DispatchBody>(await w.dispatch(id));
  assertEquals([b.result, b.delivery!.state, b.delivery!.provider, b.delivery!.provider_status, b.delivery!.customer_fee_cents, b.delivery!.driver_tip_cents], ['applied', 'booked', 'uber_direct', 'pending', 450, 300]);
  const create = w.uber.calls.find((c) => c.path === '/v1/customers/cust_platform/deliveries')!.body!;
  assertEquals([create.quote_id, create.pickup_notes, create.dropoff_name, create.dropoff_phone_number, create.dropoff_notes, create.tip, create.manifest_total_value, create.external_id],
    ['dqt_1', 'Order #F-007', 'Pat Doe', '+12015550142', 'Ring twice', 300, 2400, id]);
  assertEquals(create.manifest_items, [{ name: '2x Large Cheese', quantity: 2, size: 'small', price: 1200 }]);
  assertEquals(create.test_specifications, { robo_courier_specification: { mode: 'auto' } }, 'sandbox only');
  assertEquals([create.dropoff_latitude, create.dropoff_longitude], [40.75, -74.03]);
  assertEquals(Date.parse(String(create.pickup_ready_dt)), t0 + 20 * MIN);
  const row = w.store.deliveries[0];
  assertEquals([row.provider_delivery_id, row.provider_fee_cents, row.customer_fee_cents, row.restaurant_absorbs_cents, row.driver_tip_cents, row.cancellation_fee_cents, row.billing_mode, row.provider_environment],
    ['del_1', 900, 450, 450, 300, null, 'platform', 'sandbox']);
});

Deno.test('dispatch refused (stored): not paid in full / open → 409 not_paid; any cash → 400 card_only; not an Uber delivery; no quote; already dispatched → 409; pickup outside 5–120 → 400; not configured → 501', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  assertEquals(err(await w.dispatch(w.posOrder(pq, { status: 'open' }))).code, 'not_paid');
  assertEquals(err(await w.dispatch(w.posOrder(pq, { payments: [{ method: 'external_card', amount_cents: 1000, status: 'captured' }] }))).code, 'not_paid');
  assertEquals(err(await w.dispatch(w.posOrder(pq, { payments: [{ method: 'external_card', amount_cents: 2000, status: 'captured' }, { method: 'cash', amount_cents: 1100, status: 'captured' }] }))).code, 'card_only');
  assertEquals(err(await w.dispatch(w.posOrder(pq, {}, { driver_type: 'in_house', fee_source: 'quoted' }))).code, 'action_not_allowed');
  assertEquals(err(await w.dispatch(w.posOrder(pq, { order_type: 'pickup' }))).code, 'action_not_allowed');
  assertEquals(err(await w.dispatch(w.posOrder(null))).code, 'quote_unknown');
  for (const m of [4, 121, 20.5]) assertEquals(err(await w.dispatch(w.posOrder(pq), { pickup_ready_minutes: m })).code, 'invalid_payload');
  const once = w.posOrder(pq);
  ok(await w.dispatch(once));
  const twice = await w.dispatch(once);
  assertEquals([twice.status, err(twice).code], [409, 'already_dispatched']);
  assertEquals(w.uber.calls.filter((c) => c.path.endsWith('/deliveries')).length, 1, 'one booking');
  assertEquals(err(await w.dispatch(crypto.randomUUID())).code, 'unknown_order');
  const none = await world({ uber: false });
  none.store.enabled.add(R1);
  assertEquals(err(await none.dispatch(none.posOrder('pq_x'))).status, 501);
});

Deno.test('dispatch: an expired quote is re-quoted — within $2 silently (the restaurant absorbs the difference), ≥ $2 → 409 quote_price_changed + quote; Dispatch anyway (accepted_quote_id) → booked once', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  w.store.providerQuotes.get(pq)!.expires_at = new Date(w.h.clock.now() - MIN).toISOString();
  w.uber.state.quoteFee = 1100; // customer share 550 (was 450): Δ 100 < 200
  const id = w.posOrder(pq);
  ok(await w.dispatch(id));
  const row = w.store.deliveries[0];
  assertEquals([row.provider_fee_cents, row.customer_fee_cents, row.restaurant_absorbs_cents, row.provider_quote_id], [1100, 450, 650, 'dqt_2']);
  // ≥ $2
  const pq2 = await w.uberQuoteId();
  w.store.providerQuotes.get(pq2)!.expires_at = new Date(w.h.clock.now() - MIN).toISOString();
  w.uber.state.quoteFee = 1700; // customer 850 vs 550 → Δ 300
  const id2 = w.posOrder(pq2);
  const actionId = crypto.randomUUID();
  const r = await w.dispatch(id2, { action_id: actionId });
  assertEquals([r.status, err(r).code], [409, 'quote_price_changed']);
  const quote = errBody(r).quote as Record<string, unknown>;
  assertEquals([quote.original_fee_cents, quote.new_fee_cents, quote.delta_cents], [550, 850, 300]);
  assertEquals(errBody(await w.dispatch(id2, { action_id: actionId })).quote, quote, 'the stored answer replays the quote');
  const bookingsBefore = w.uber.calls.filter((c) => c.path.endsWith('/deliveries')).length;
  const anyway = ok<DispatchBody>(await w.dispatch(id2, { accepted_quote_id: quote.new_quote_id }));
  assertEquals(anyway.delivery!.state, 'booked');
  assertEquals(w.uber.calls.filter((c) => c.path.endsWith('/deliveries')).length, bookingsBefore + 1);
  assertEquals(w.store.deliveries.filter((d) => d.pos_order_id === id2).map((d) => d.state), ['failed', 'booked']);
});

Deno.test('dispatch: Uber refuses (bad address) → stored 502 delivery_failed bad_address; rate_limited → 503 Retry-After, NOT stored (released); a lost answer → duplicate, one booking', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  w.uber.state.createStatus = 400;
  const bad = await w.dispatch(id);
  assertEquals([bad.status, err(bad).code, errBody(bad).reason], [502, 'delivery_failed', 'bad_address']);
  w.uber.state.createStatus = 200;
  w.uber.state.rateLimitNext = 1;
  const actionId = crypto.randomUUID();
  const rl = await w.dispatch(id, { action_id: actionId });
  assertEquals([rl.status, err(rl).code, rl.headers?.['Retry-After'], w.store.actions.has(actionId)], [503, 'rate_limited', '7', false]);
  ok(await w.dispatch(id, { action_id: actionId }));
  const again = ok<DispatchBody>(await w.dispatch(id, { action_id: actionId }));
  assertEquals(again.result, 'duplicate');
  assertEquals(w.uber.calls.filter((c) => c.path.endsWith('/deliveries') && c.method === 'POST').length, 3, '1 refused + 1 rate limited + 1 booked');
  assertEquals(w.store.deliveries.map((d) => d.state), ['failed', 'failed', 'booked']);
});

Deno.test('dispatch never double-books: pending → 503; STALE with a booking row → never re-run (booked → applied; booking → stored "outcome unknown"); STALE with no row → run (nothing was sent); the row-save failure → one loud reconcile line', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  const actionId = crypto.randomUUID();
  const body = { action_id: actionId, restaurant_id: R1, order_id: id, pickup_ready_minutes: 20, accepted_quote_id: null, actor_staff_id: 'register', approver_staff_id: null };
  await w.store.beginAction({ actionId, restaurantId: R1, deviceId: w.A.device_id, orderId: id, action: 'dispatch', request: body, actor: 'register', approver: null, deviceTime: null });
  const claim = await w.store.claimDelivery({ pos_order_id: id, restaurant_id: R1, provider: 'uber_direct', action_id: actionId, provider_quote_ref: pq, provider_quote_id: null, customer_fee_cents: 450, driver_tip_cents: 0, billing_mode: 'platform', provider_environment: 'sandbox' });
  assertEquals((await w.dispatch(id, body)).status, 503);
  w.h.clock.advance(PENDING_STALE_MS);
  const unknown = await w.dispatch(id, body);
  assertEquals([unknown.status, err(unknown).message], [502, 'outcome unknown — check the Uber dashboard before dispatching again']);
  assertEquals([w.store.deliveries[0].state, w.store.deliveries[0].failure_code, claim.outcome], ['failed', 'outcome_unknown', 'claimed']);
  assertEquals(w.uber.calls.filter((c) => c.path.endsWith('/deliveries')).length, 0, 'never re-run');
  // stale, no row → provably nothing sent → run
  const id2 = w.posOrder(pq);
  const a2 = crypto.randomUUID();
  const b2 = { ...body, action_id: a2, order_id: id2 };
  await w.store.beginAction({ actionId: a2, restaurantId: R1, deviceId: w.A.device_id, orderId: id2, action: 'dispatch', request: b2, actor: 'register', approver: null, deviceTime: null });
  w.h.clock.advance(PENDING_STALE_MS);
  assertEquals(ok<DispatchBody>(await w.dispatch(id2, b2)).delivery!.state, 'booked');
  // the courier booked but the row could not be saved
  const id3 = w.posOrder(pq);
  const update = w.store.updateDelivery.bind(w.store);
  w.store.updateDelivery = (rowId, patch) => (patch.state === 'booked' ? Promise.reject(new Error('db down')) : update(rowId, patch));
  const r3 = await w.dispatch(id3);
  assertEquals([r3.status, errBody(r3).reason], [502, 'provider_error']);
  assertEquals(w.logs.filter((l) => l.event === 'POS_DELIVERY_UNPERSISTED_RECONCILE').map((l) => [l.order_id, l.provider_delivery_id]), [[id3, 'del_2']]);
});

// ---- cancel -----------------------------------------------------------------------------------------------------

Deno.test('cancel: a booked delivery → Uber cancel → canceled + cancellation fee in the ledger; again → noop; the driver has the food → 502 cannot_cancel; nothing booked → 400', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  ok(await w.dispatch(id));
  w.uber.state.cancelFee = 0;
  const c = ok<DispatchBody>(await w.cancel(id));
  assertEquals([c.result, c.delivery!.state], ['applied', 'canceled']);
  assertEquals(w.uber.calls.at(-1)!.path, '/v1/customers/cust_platform/deliveries/del_1/cancel');
  assertEquals(w.store.deliveries[0].cancellation_fee_cents, 0);
  assertEquals(ok<DispatchBody>(await w.cancel(id)).result, 'noop');
  // re-dispatch after a cancel is allowed (a new booking)
  assertEquals(ok<DispatchBody>(await w.dispatch(id)).delivery!.state, 'booked');
  w.uber.state.cancelStatus = 409;
  const late = await w.cancel(id);
  assertEquals([late.status, errBody(late).reason], [502, 'cannot_cancel']);
  assertEquals(w.store.deliveries.at(-1)!.state, 'booked');
  assertEquals(err(await w.cancel(w.posOrder(pq))).code, 'no_active_delivery');
});

// ---- status (polling ≤ every 30 s) --------------------------------------------------------------------------------

Deno.test('status: a booked delivery is refreshed from Uber at most every 30 s (courier, ETAs); delivered → delivered; unknown orders → null', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  ok(await w.dispatch(id));
  const gets = () => w.uber.calls.filter((c) => c.method === 'GET').length;
  w.uber.state.getStatus = 'pickup';
  w.uber.state.courier = { name: 'Sam', phone_number: '+12015550199' };
  type S = { deliveries: { order_id: string; delivery: Record<string, unknown> | null }[] };
  const s1 = ok<S>(await w.status([id, crypto.randomUUID()]));
  assertEquals([s1.deliveries[0].delivery!.provider_status, s1.deliveries[0].delivery!.courier, s1.deliveries[1].delivery], ['pickup', { name: 'Sam', phone: '+12015550199' }, null]);
  assertEquals(gets(), 1);
  w.h.clock.advance(POLL_EVERY_MS - 1);
  ok(await w.status([id]));
  assertEquals(gets(), 1, 'not again within 30 s');
  w.h.clock.advance(2); // strictly older than 30 s
  w.uber.state.getStatus = 'delivered';
  const s2 = ok<S>(await w.status([id]));
  assertEquals([s2.deliveries[0].delivery!.state, gets()], ['delivered', 2]);
  w.h.clock.advance(POLL_EVERY_MS);
  ok(await w.status([id]));
  assertEquals(gets(), 2, 'a delivered one is not polled');
  assertEquals(err(await w.status([])).code, 'invalid_payload');
});

// ---- the Pg store: names must match 115 --------------------------------------------------------------------------

Deno.test('PgDeliveryStore: RPC + argument names match the 115 action functions', async () => {
  const { PgDeliveryStore } = await import('../store.ts');
  const calls: [string, string[]][] = [];
  const pg = new PgDeliveryStore({
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, Object.keys(args)]);
      return Promise.resolve({ data: { outcome: 'pending', since: '2026-11-24T14:00:00.123456+00:00' }, error: null });
    },
    from: () => ({}),
  });
  const b = await pg.beginAction({ actionId: 'a', restaurantId: R1, deviceId: 'd', orderId: 'o', action: 'dispatch', request: {}, actor: null, approver: null, deviceTime: null });
  assertEquals(b, { outcome: 'pending', since: '2026-11-24T14:00:00.123Z' });
  await pg.finishAction('a', 'd', 'error', { status: 502, code: 'delivery_failed', message: 'x' });
  await pg.releaseAction('a', 'd');
  assertEquals(calls, [
    ['pos_delivery_action_begin', ['p_action_id', 'p_restaurant_id', 'p_device_id', 'p_order_id', 'p_action', 'p_request', 'p_actor', 'p_approver', 'p_device_time']],
    ['pos_delivery_action_finish', ['p_action_id', 'p_device_id', 'p_outcome', 'p_error_status', 'p_error_code', 'p_error_message']],
    ['pos_delivery_action_release', ['p_action_id', 'p_device_id']],
  ]);
});

Deno.test('dispatch: a stored driver tip over 500 (an order from before the submit-order cap) → 400 invalid_payload, nothing sent to Uber', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq, {}, { uber: { quote_id: pq, driver_tip_cents: 600 } });
  const r = await w.dispatch(id);
  assertEquals([r.status, err(r).code, errBody(r).field], [400, 'invalid_payload', 'delivery.uber.driver_tip_cents']);
  assertEquals(w.uber.calls.filter((c) => c.path.endsWith('/deliveries')).length, 0);
  assertEquals(w.store.deliveries.length, 0);
  // 500 exactly is fine and reaches Uber as 500
  const ok500 = w.posOrder(pq, {}, { uber: { quote_id: pq, driver_tip_cents: 500 } });
  ok(await w.dispatch(ok500));
  assertEquals(w.uber.calls.find((c) => c.path.endsWith('/deliveries'))!.body!.tip, 500);
});
