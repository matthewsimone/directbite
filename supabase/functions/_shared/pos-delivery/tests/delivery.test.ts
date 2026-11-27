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
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { err, harness, ok, R1, R2, type Registered } from '../../pos-device/tests/harness.ts';
import { FakeSupabase } from '../../pos-online/tests/fakeSupabase.ts';
import { applyPassthrough } from '../../uberPassthrough.ts';
import type { MenuSnapshot } from '../../pos-sync/menuSnapshot.ts';
import { handleDeliveryAlert, handleDeliveryCancel, handleDeliveryDispatch, handleDeliveryStatus, handleQuoteDelivery, PENDING_STALE_MS, POLL_EVERY_MS, type DeliveryDeps } from '../handlers.ts';
import { MemoryDeliveryStore, type PosOrderForDelivery } from '../store.ts';
import type { GeocodeResult } from '../geocode.ts';
import { businessDate } from '../../pos-eod/rules.ts';
import { BUSINESS_DAY_CUTOFF } from '../../pos-sync/menuSnapshot.ts';

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
    id: R1, name: 'Test Pizza', timezone: 'America/New_York', latitude: 40.744, longitude: -74.0324, address: '100 Washington St, Hoboken, NJ', phone: '2015550100',
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
      order_id: id, restaurant_id: R1, order_type: 'delivery', channel: 'phone', status: 'closed', total_cents: 3100, subtotal_cents: 2400, tip_cents: 300,
      delivery: { fee_source: 'uber', driver_type: 'uber_direct', address: { instructions: 'Ring twice' }, uber: { quote_id: pq }, ...delivery },
      customer_name: 'Pat Doe', customer_phone_e164: '+12015550142', note: null, ticket_label: 'F-007',
      lines: [{ item_name: 'Large Cheese', quantity: 2, base_price_cents: 1200 }], payments: [{ method: 'external_card', amount_cents: 3100, status: 'captured' }],
      // closed a minute ago, today (the dispatch window)
      sales_day: businessDate(h.clock.now(), 'America/New_York', BUSINESS_DAY_CUTOFF),
      first_closed: { device_time: new Date(h.clock.now() - MIN).toISOString(), received_at: new Date(h.clock.now()).toISOString() }, ...o,
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
  return { h, A, X, db, store, uber, deps, logs, quote, posOrder, dispatch, cancel, status, uberQuoteId, call };
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
  assertEquals([row.quoted_provider_fee_cents, row.canceled_by, (b.delivery as unknown as Record<string, unknown>).fee_delta_cents], [900, null, 0]);
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

Deno.test('dispatch (Matt, CP23 change): the customer fee is LOCKED — an expired quote is re-quoted and booked automatically, any Δ (+ or −) absorbed by the restaurant (signed), fee_delta_cents on the wire; never 409 quote_price_changed; accepted_quote_id ignored', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  // a fresh quote → fee_delta 0, absorbs = 900 − 450
  const fresh = ok<DispatchBody>(await w.dispatch(w.posOrder(await w.uberQuoteId())));
  assertEquals((fresh.delivery as unknown as Record<string, unknown>).fee_delta_cents, 0);
  assertEquals(w.store.deliveries[0].restaurant_absorbs_cents, 450);
  // expired + Uber now $5 dearer (900 → 1400; the old guard's customer-share Δ = 250 ≥ 200 would have been a 409)
  const pqUp = await w.uberQuoteId();
  w.store.providerQuotes.get(pqUp)!.expires_at = new Date(w.h.clock.now() - MIN).toISOString();
  w.uber.state.quoteFee = 1400;
  const up = await w.dispatch(w.posOrder(pqUp), { accepted_quote_id: 'pq_' + 'f'.repeat(32) }); // an older POS's field: ignored
  assertEquals(up.status, 200);
  const upB = ok<DispatchBody>(up);
  assertEquals([upB.delivery!.state, upB.delivery!.customer_fee_cents, (upB.delivery as unknown as Record<string, unknown>).fee_delta_cents], ['booked', 450, 500]);
  const rowUp = w.store.deliveries.at(-1)!;
  assertEquals([rowUp.provider_fee_cents, rowUp.customer_fee_cents, rowUp.restaurant_absorbs_cents, rowUp.quoted_provider_fee_cents], [1400, 450, 950, 900]);
  assertEquals(w.logs.filter((l) => l.event === 'delivery_dispatch_fee_delta').map((l) => [l.quoted_cents, l.booked_cents]), [[900, 1400]]);
  // expired + Uber now cheaper than the customer paid (900 → 300): absorbs NEGATIVE, stored, not floored
  w.uber.state.quoteFee = 900;
  const pqDown = await w.uberQuoteId();
  w.store.providerQuotes.get(pqDown)!.expires_at = new Date(w.h.clock.now() - MIN).toISOString();
  w.uber.state.quoteFee = 300;
  const down = ok<DispatchBody>(await w.dispatch(w.posOrder(pqDown)));
  assertEquals((down.delivery as unknown as Record<string, unknown>).fee_delta_cents, -600);
  const rowDown = w.store.deliveries.at(-1)!;
  assertEquals([rowDown.provider_fee_cents, rowDown.customer_fee_cents, rowDown.restaurant_absorbs_cents], [300, 450, -150]);
  assert(!w.logs.some((l) => l.code === 'quote_price_changed' || l.error_code === 'quote_price_changed'));
  assertEquals(w.store.deliveries.map((d) => d.state), ['booked', 'booked', 'booked']);
  // a resend with / without accepted_quote_id is the same request (not action_id_reused)
  const id = w.posOrder(await w.uberQuoteId());
  const actionId = crypto.randomUUID();
  ok(await w.dispatch(id, { action_id: actionId }));
  assertEquals(ok<DispatchBody>(await w.dispatch(id, { action_id: actionId, accepted_quote_id: 'pq_' + 'a'.repeat(32) })).result, 'duplicate');
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
  const body = { action_id: actionId, restaurant_id: R1, order_id: id, pickup_ready_minutes: 20, actor_staff_id: 'register', approver_staff_id: null };
  await w.store.beginAction({ actionId, restaurantId: R1, deviceId: w.A.device_id, orderId: id, action: 'dispatch', request: body, actor: 'register', approver: null, deviceTime: null });
  const claim = await w.store.claimDelivery({ pos_order_id: id, restaurant_id: R1, provider: 'uber_direct', action_id: actionId, provider_quote_ref: pq, provider_quote_id: null, customer_fee_cents: 450, quoted_provider_fee_cents: 900, driver_tip_cents: 0, billing_mode: 'platform', provider_environment: 'sandbox' });
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
  w.uber.state.cancelFee = 0; // Uber says 0 → none charged → null
  const c = ok<DispatchBody>(await w.cancel(id));
  const cw = c.delivery as unknown as Record<string, unknown>;
  assertEquals([c.result, cw.state, cw.cancellation_fee_cents, cw.canceled_by], ['applied', 'canceled', null, 'restaurant']);
  assertEquals(w.uber.calls.at(-1)!.path, '/v1/customers/cust_platform/deliveries/del_1/cancel');
  assertEquals([w.store.deliveries[0].cancellation_fee_cents, w.store.deliveries[0].canceled_by], [null, 'restaurant']);
  const again = ok<DispatchBody>(await w.cancel(id));
  assertEquals([again.result, (again.delivery as unknown as Record<string, unknown>).canceled_by], ['noop', 'restaurant']);
  // Uber charged one → integer cents on the 200 answer and in status polls
  const id2 = w.posOrder(pq);
  ok(await w.dispatch(id2));
  w.uber.state.cancelFee = 725;
  const c2 = ok<DispatchBody>(await w.cancel(id2)).delivery as unknown as Record<string, unknown>;
  assertEquals([c2.cancellation_fee_cents, c2.canceled_by], [725, 'restaurant']);
  const polled = ok<{ deliveries: { delivery: Record<string, unknown> }[] }>(await w.status([id2])).deliveries[0].delivery;
  assertEquals([polled.state, polled.cancellation_fee_cents, polled.canceled_by], ['canceled', 725, 'restaurant']);
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
  assertEquals([s2.deliveries[0].delivery!.cancellation_fee_cents, s2.deliveries[0].delivery!.canceled_by], [null, null]);
  assertEquals(err(await w.status([])).code, 'invalid_payload');
});

Deno.test('status: Uber canceled / returned it → canceled, canceled_by provider, cancellation_fee_cents null', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  type S = { deliveries: { order_id: string; delivery: Record<string, unknown> | null }[] };
  for (const st of ['canceled', 'returned']) {
    const id = w.posOrder(pq);
    ok(await w.dispatch(id));
    w.uber.state.getStatus = st;
    const d = ok<S>(await w.status([id])).deliveries[0].delivery!;
    assertEquals([d.state, d.canceled_by, d.cancellation_fee_cents, d.provider_status], ['canceled', 'provider', null, st]);
    w.uber.state.getStatus = 'pending';
  }
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

Deno.test('dispatch tip (Matt, R2 — online exactly): the ORDER\'s tip is the driver tip; Uber gets min(tip, 500); the excess stays with the restaurant; delivery.uber.driver_tip_cents ignored', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const sentTip = () => w.uber.calls.filter((c) => c.path.endsWith('/deliveries') && c.method === 'POST').at(-1)!.body!.tip;
  // $8 tip: allowed (no 400), Uber gets $5, the ledger + the wire say $5 (what the driver receives)
  const big = ok<DispatchBody>(await w.dispatch(w.posOrder(pq, { tip_cents: 800, total_cents: 3600, payments: [{ method: 'external_card', amount_cents: 3600, status: 'captured' }] }, { uber: { quote_id: pq, driver_tip_cents: 9999 } })));
  assertEquals([big.result, sentTip(), big.delivery!.driver_tip_cents, w.store.deliveries.at(-1)!.driver_tip_cents], ['applied', 500, 500, 500]);
  // exactly $5 and under: all of it
  ok(await w.dispatch(w.posOrder(pq, { tip_cents: 500, total_cents: 3300, payments: [{ method: 'external_card', amount_cents: 3300, status: 'captured' }] })));
  assertEquals(sentTip(), 500);
  ok(await w.dispatch(w.posOrder(pq, { tip_cents: 0, total_cents: 2800, payments: [{ method: 'external_card', amount_cents: 2800, status: 'captured' }] }, { uber: { quote_id: pq, driver_tip_cents: 300 } })));
  assertEquals([sentTip(), w.store.deliveries.at(-1)!.driver_tip_cents], [0, 0], 'the retired field never adds a tip');
});

Deno.test('dispatch pickup_ready_at (Matt, pos-pickup-exact): the EXACT courier arrival time, sent to Uber as is — no lead, whatever the restaurant\'s uber_scheduled_lead_minutes; > now + 5 min; exactly one timing', async () => {
  const w = await world({ restaurant: { uber_scheduled_lead_minutes: 25 } });
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const now = () => w.h.clock.now();
  const posts = () => w.uber.calls.filter((c) => c.path.endsWith('/deliveries') && c.method === 'POST');
  const ready = () => Date.parse(String(posts().at(-1)!.body!.pickup_ready_dt));
  // the time itself, with a lead set (25) — online's lead is not applied on the POS path
  const at = now() + 3 * 60 * MIN;
  const b = ok<DispatchBody>(await w.dispatch(w.posOrder(pq), { pickup_ready_minutes: null, pickup_ready_at: new Date(at).toISOString() }));
  assertEquals([b.result, ready(), Date.parse(String(b.delivery!.pickup_ready_at))], ['applied', at, at]);
  assert(!w.logs.some((l) => l.event === 'scheduled_lead_applied'));
  // closer than the lead → still the exact time (no ASAP switch, no floor)
  const near = now() + 6 * MIN;
  ok(await w.dispatch(w.posOrder(pq), { pickup_ready_minutes: null, pickup_ready_at: new Date(near).toISOString() }));
  assertEquals(ready(), near);
  // NULL lead / any lead: the same
  for (const lead of [null, 5, 90]) {
    w.db.rows('restaurants')[0].uber_scheduled_lead_minutes = lead;
    ok(await w.dispatch(w.posOrder(pq), { pickup_ready_minutes: null, pickup_ready_at: new Date(at).toISOString() }));
    assertEquals(ready(), at, `lead ${lead}`);
  }
  // ASAP is unchanged
  ok(await w.dispatch(w.posOrder(pq), { pickup_ready_minutes: 20 }));
  assertEquals(ready(), now() + 20 * MIN);
  // exactly one; ISO; strictly > now + 5 min (exactly 5 min, 4 min, the past → refused); nothing claimed or sent
  const bad = async (extra: Record<string, unknown>) => {
    const r = await w.dispatch(w.posOrder(pq), extra);
    return [r.status, err(r).code, errBody(r).field];
  };
  const sent = posts().length;
  const claimed = w.store.deliveries.length;
  assertEquals(await bad({ pickup_ready_minutes: 20, pickup_ready_at: new Date(at).toISOString() }), [400, 'invalid_payload', 'pickup_ready_minutes']);
  assertEquals(await bad({ pickup_ready_minutes: null }), [400, 'invalid_payload', 'pickup_ready_minutes']);
  assertEquals(await bad({ pickup_ready_minutes: null, pickup_ready_at: 'tomorrow' }), [400, 'invalid_payload', 'pickup_ready_at']);
  for (const off of [5 * MIN, 4 * MIN, 0, -MIN]) {
    assertEquals(await bad({ pickup_ready_minutes: null, pickup_ready_at: new Date(now() + off).toISOString() }), [400, 'invalid_payload', 'pickup_ready_at'], `now + ${off / MIN} min`);
  }
  ok(await w.dispatch(w.posOrder(pq), { pickup_ready_minutes: null, pickup_ready_at: new Date(now() + 5 * MIN + 1000).toISOString() }));
  assertEquals([posts().length, w.store.deliveries.length], [sent + 1, claimed + 1], 'only the valid one claimed + sent');

  // a too-close time is NOT stored: the action is released, so the same id can be resent with a new time
  const order = w.posOrder(pq);
  const id = crypto.randomUUID();
  const r1 = await w.dispatch(order, { action_id: id, pickup_ready_minutes: null, pickup_ready_at: new Date(now() + 3 * MIN).toISOString() });
  assertEquals([r1.status, err(r1).code], [400, 'invalid_payload']);
  assertEquals(w.store.actions.has(id), false, 'released');
  const later = now() + 30 * MIN;
  ok(await w.dispatch(order, { action_id: id, pickup_ready_minutes: null, pickup_ready_at: new Date(later).toISOString() }));
  assertEquals(ready(), later);

  // a resend of an ANSWERED dispatch after its time has come inside the window → the stored answer, never a 400 / re-book
  const o2 = w.posOrder(pq);
  const id2 = crypto.randomUUID();
  const body2 = { action_id: id2, pickup_ready_minutes: null, pickup_ready_at: new Date(now() + 7 * MIN).toISOString() };
  ok(await w.dispatch(o2, body2));
  const booked = posts().length;
  w.h.clock.advance(4 * MIN);
  const again = ok<DispatchBody>(await w.dispatch(o2, body2));
  assertEquals([again.result, posts().length], ['duplicate', booked]);
});

Deno.test('status: Uber failed → canceled, canceled_by provider (online treats failed as terminal)', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const id = w.posOrder(await w.uberQuoteId());
  ok(await w.dispatch(id));
  w.uber.state.getStatus = 'failed';
  const d = ok<{ deliveries: { delivery: Record<string, unknown> }[] }>(await w.status([id])).deliveries[0].delivery;
  assertEquals([d.state, d.canceled_by, d.provider_status, d.cancellation_fee_cents], ['canceled', 'provider', 'failed', null]);
});

// ---- 118: the every-register toast (scope 'restaurant' + pos-v1-delivery-alert) -----------------------------------

type RestBody = { deliveries: { order_id: string; ticket_label: string | null; customer: { name: string | null; phone: string | null }; delivery: Record<string, unknown> }[]; business_day: string; server_time: string };

async function toastWorld() {
  const w = await world();
  w.store.enabled.add(R1);
  const B = ok<Registered>(await w.h.register(w.h.req((await w.h.enroll()).code))); // a second register of Test Pizza
  const rest = (dev: Registered = w.A) => w.call(handleDeliveryStatus, { restaurant_id: R1, scope: 'restaurant' }, dev);
  const alert = (body: Record<string, unknown>, dev: Registered = w.A) =>
    w.call(handleDeliveryAlert, { action_id: crypto.randomUUID(), restaurant_id: R1, choice: 'in_house', actor_staff_id: 'register', approver_staff_id: null, device_time: new Date(w.h.clock.now()).toISOString(), ...body }, dev);
  return { ...w, B, rest, alert };
}

Deno.test('status scope restaurant: every register sees every POS Uber delivery of the restaurant (latest per order, live or ended this business day) + ticket / customer; alert computed; another restaurant\'s never', async () => {
  const w = await toastWorld();
  const pq = await w.uberQuoteId();
  const booked = w.posOrder(pq);
  ok(await w.dispatch(booked));
  const canceled = w.posOrder(pq, { customer_name: 'Sam Roe', ticket_label: 'F-008' });
  ok(await w.dispatch(canceled));
  w.uber.state.getStatus = 'canceled';
  ok(await w.status([canceled]));          // A's own poll sees Uber's cancel
  w.uber.state.getStatus = 'pending';
  const failed = w.posOrder(pq, { ticket_label: 'F-009' });
  w.uber.state.createStatus = 500;
  await w.dispatch(failed);                // booking failed for good (provider_error)
  const limited = w.posOrder(pq, { ticket_label: 'F-010' });
  w.uber.state.createStatus = 200;
  w.uber.state.rateLimitNext = 1;
  await w.dispatch(limited);               // rate limited: the register retries — no toast
  // register B never took these orders, and still sees all four
  const b = ok<RestBody>(await w.rest(w.B));
  const by = Object.fromEntries(b.deliveries.map((d) => [d.ticket_label, d]));
  assertEquals(Object.keys(by).sort(), ['F-007', 'F-008', 'F-009', 'F-010']);
  assertEquals([by['F-007'].delivery.state, by['F-007'].delivery.alert], ['booked', null]);
  assertEquals([by['F-008'].delivery.state, by['F-008'].delivery.canceled_by, by['F-008'].delivery.alert, by['F-008'].customer], ['canceled', 'provider', 'provider_canceled', { name: 'Sam Roe', phone: '+12015550142' }]);
  assertEquals([by['F-009'].delivery.state, by['F-009'].delivery.alert, by['F-009'].delivery.failure_code], ['failed', 'booking_failed', 'provider_error']);
  assertEquals([by['F-010'].delivery.state, by['F-010'].delivery.alert], ['failed', null]);
  assertEquals(by['F-007'].order_id, booked);
  assertEquals(b.business_day, '2026-11-19');
  // a re-dispatch supersedes the failed one (latest per order)
  ok(await w.dispatch(failed));
  assertEquals(ok<RestBody>(await w.rest()).deliveries.find((d) => d.ticket_label === 'F-009')!.delivery.state, 'booked');
  // the next business day (04:00 New York): ended ones drop off, live ones stay
  w.h.clock.advance(24 * 60 * MIN);
  const next = ok<RestBody>(await w.rest());
  assertEquals(next.deliveries.map((d) => d.ticket_label).sort(), ['F-007', 'F-009']);
  // another restaurant's register sees none of it
  w.db.insertRow('restaurants', { id: R2, name: 'Other', timezone: 'America/New_York' });
  assertEquals(ok<RestBody>(await w.call(handleDeliveryStatus, { restaurant_id: R2, scope: 'restaurant' }, w.X)).deliveries, []);
});

Deno.test('status scope restaurant: a booked delivery is refreshed at most once per 30 s however many registers poll', async () => {
  const w = await toastWorld();
  const id = w.posOrder(await w.uberQuoteId());
  ok(await w.dispatch(id));
  const gets = () => w.uber.calls.filter((c) => c.method === 'GET').length;
  ok(await w.rest());
  ok(await w.rest(w.B));
  ok(await w.status([id]));
  assertEquals(gets(), 1);
  w.h.clock.advance(POLL_EVERY_MS + 1);
  ok(await w.rest(w.B));
  ok(await w.rest());
  assertEquals(gets(), 2);
});

Deno.test('status scope validation: scope must be restaurant; no order_ids with it', async () => {
  const w = await toastWorld();
  assertEquals([err(await w.call(handleDeliveryStatus, { restaurant_id: R1, scope: 'all' })).code, errBody(await w.call(handleDeliveryStatus, { restaurant_id: R1, scope: 'all' })).field], ['invalid_payload', 'scope']);
  assertEquals(errBody(await w.call(handleDeliveryStatus, { restaurant_id: R1, scope: 'restaurant', order_ids: [crypto.randomUUID()] })).field, 'order_ids');
});

Deno.test('alert: the first register handles it (applied, set once); every register sees the mark on its next poll; a second register → noop with the first mark; resend → duplicate', async () => {
  const w = await toastWorld();
  const id = w.posOrder(await w.uberQuoteId());
  ok(await w.dispatch(id));
  w.uber.state.getStatus = 'canceled';
  const d = ok<RestBody>(await w.rest()).deliveries[0].delivery;
  assertEquals(d.alert, 'provider_canceled');
  const actionId = crypto.randomUUID();
  const first = ok<{ result: string; delivery: Record<string, unknown> }>(await w.alert({ action_id: actionId, order_id: id, delivery_id: d.id }, w.B));
  assertEquals([first.result, first.delivery.alert_choice, first.delivery.alert_handled_by, first.delivery.alert_handled_at], ['applied', 'in_house', 'register', new Date(w.h.clock.now()).toISOString()]);
  // register A's next poll: handled (the toast clears) — the alert itself stays as history
  const seen = ok<RestBody>(await w.rest()).deliveries[0].delivery;
  assertEquals([seen.alert, seen.alert_handled_at !== null, seen.alert_choice], ['provider_canceled', true, 'in_house']);
  // A handles it too, a moment later: noop, the first mark kept
  const second = ok<{ result: string; delivery: Record<string, unknown> }>(await w.alert({ order_id: id, delivery_id: d.id, choice: 'acknowledged' }));
  assertEquals([second.result, second.delivery.alert_choice], ['noop', 'in_house']);
  assertEquals(ok<{ result: string }>(await w.alert({ action_id: actionId, order_id: id, delivery_id: d.id }, w.B)).result, 'duplicate');
  assertEquals(err(await w.alert({ action_id: actionId, order_id: id, delivery_id: d.id, choice: 'acknowledged' }, w.B)).code, 'action_id_reused');
  assertEquals(w.uber.calls.filter((c) => c.path.endsWith('/cancel')).length, 0, 'no provider call');
});

Deno.test('alert: a failed booking can be handled; nothing to handle → 400 no_alert; a newer delivery → 409 delivery_changed; validation', async () => {
  const w = await toastWorld();
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  w.uber.state.createStatus = 500;
  await w.dispatch(id);
  const failedRow = w.store.deliveries.at(-1)!;
  assertEquals(ok<{ result: string }>(await w.alert({ order_id: id, delivery_id: failedRow.id, choice: 'acknowledged' })).result, 'applied');
  // re-dispatched since → the old delivery's toast is stale
  w.uber.state.createStatus = 200;
  ok(await w.dispatch(id));
  const changed = await w.alert({ order_id: id, delivery_id: failedRow.id });
  assertEquals([changed.status, err(changed).code, (errBody(changed).delivery as Record<string, unknown>).state], [409, 'delivery_changed', 'booked']);
  const live = w.store.deliveries.at(-1)!;
  assertEquals([(await w.alert({ order_id: id, delivery_id: live.id })).status, err(await w.alert({ order_id: id, delivery_id: live.id })).code], [400, 'no_alert']);
  assertEquals(err(await w.alert({ order_id: crypto.randomUUID(), delivery_id: live.id })).code, 'no_alert');
  for (const [k, v] of [['choice', 'refund'], ['delivery_id', 'x'], ['order_id', 'x'], ['action_id', 'x']] as const) {
    const r = await w.alert({ order_id: id, delivery_id: live.id, [k]: v });
    assertEquals([err(r).code, errBody(r).field], ['invalid_payload', k]);
  }
});

Deno.test('PgDeliveryStore.markAlert: one conditional update (alert_handled_at is null) — 0 rows = another register was first', async () => {
  const { PgDeliveryStore } = await import('../store.ts');
  const calls: [string, ...unknown[]][] = [];
  let rows: unknown[] = [{ id: 'd' }];
  // deno-lint-ignore no-explicit-any
  const q: any = { update: (v: unknown) => (calls.push(['update', v]), q), eq: (c: string, v: unknown) => (calls.push(['eq', c, v]), q), is: (c: string, v: unknown) => (calls.push(['is', c, v]), q), select: () => Promise.resolve({ data: rows, error: null }) };
  const pg = new PgDeliveryStore({ rpc: () => Promise.resolve({ data: null, error: null }), from: (t: string) => (calls.push(['from', t]), q) });
  const mark = { at: '2026-11-25T17:00:00.000Z', by: 'register', deviceId: 'dev', choice: 'in_house' as const };
  assertEquals(await pg.markAlert('d', mark), 'marked');
  assertEquals(calls, [['from', 'pos_deliveries'], ['update', { alert_handled_at: mark.at, alert_handled_by: 'register', alert_handled_device_id: 'dev', alert_choice: 'in_house' }], ['eq', 'id', 'd'], ['is', 'alert_handled_at', null]]);
  rows = [];
  assertEquals(await pg.markAlert('d', mark), 'already');
});

// ---- pos-pickup-exact: the claim's NOT NULL columns, the dispatch window, uber_not_active, release on a throw ----------

/** pos_deliveries' NOT NULL columns WITHOUT a default, parsed from every migration (115's create table + any later
 *  `alter table … add column`), so a store fake that fills a column itself can never hide a missing one again. */
function requiredDeliveryColumns(): Set<string> {
  const dir = new URL('../../../../migrations/', import.meta.url);
  const out = new Set<string>();
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = Deno.readTextFileSync(new URL(f, dir)).replace(/--[^\n]*/g, '');
    const create = /create table public\.pos_deliveries \(([\s\S]*?)\n\);/.exec(sql);
    if (create) {
      for (const line of create[1].split('\n')) {
        const m = /^\s*([a-z_]+)\s+\S/.exec(line);
        if (!m || ['check', 'unique', 'constraint', 'primary', 'foreign', 'exclude'].includes(m[1])) continue;
        if (/\bnot null\b/.test(line) && !/\bdefault\b/.test(line)) out.add(m[1]);
      }
    }
    for (const alt of sql.matchAll(/alter table public\.pos_deliveries\b([\s\S]*?);/g)) {
      for (const add of alt[1].split(/\badd column\s+/).slice(1)) {
        const name = /^([a-z_]+)/.exec(add)?.[1];
        if (name && /\bnot null\b/.test(add) && !/\bdefault\b/.test(add)) out.add(name);
      }
    }
  }
  return out;
}

Deno.test('PgDeliveryStore.claimDelivery: the dispatch claim\'s INSERT carries every NOT NULL column without a default of pos_deliveries (parsed from the migrations) — state \'booking\' (live dispatch failed 23502 → 500 without it)', async () => {
  const required = requiredDeliveryColumns();
  // the parser found 115's table (sanity): these are the columns the claim must send
  assertEquals([...required].sort(), ['action_id', 'billing_mode', 'customer_fee_cents', 'pos_order_id', 'provider', 'provider_environment', 'restaurant_id', 'state']);
  // the claim exactly as dispatch makes it (the memory store would fill state itself — so capture the handler's argument)
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  let seen: Parameters<typeof w.store.claimDelivery>[0] | null = null;
  const claim = w.store.claimDelivery.bind(w.store);
  w.store.claimDelivery = (d) => ((seen = d), claim(d));
  ok(await w.dispatch(w.posOrder(pq)));
  assert(seen, 'dispatch claimed');
  // … through the Pg store: the payload PostgREST would insert
  const { PgDeliveryStore } = await import('../store.ts');
  let inserted: Record<string, unknown> = {};
  // deno-lint-ignore no-explicit-any
  const q: any = { insert: (v: Record<string, unknown>) => ((inserted = v), q), select: () => q, single: () => Promise.resolve({ data: { id: 'x', ...inserted }, error: null }) };
  const pg = new PgDeliveryStore({ rpc: () => Promise.resolve({ data: null, error: null }), from: () => q });
  const r = await pg.claimDelivery(seen!);
  assertEquals(r.outcome, 'claimed');
  const missing = [...required].filter((k) => inserted[k] === undefined || inserted[k] === null);
  assertEquals(missing, [], `the insert lacks NOT NULL column(s) without a default: ${missing.join(', ')}`);
  assertEquals(inserted.state, 'booking');
});

Deno.test('PgDeliveryStore.getPosOrder: sales_day + the FIRST closed version (pos_order_submissions: payload status closed, lowest version) → first_closed { device_time, received_at }', async () => {
  const { PgDeliveryStore } = await import('../store.ts');
  const calls: unknown[][] = [];
  const result: Record<string, unknown> = {
    pos_orders: { order_id: 'o', restaurant_id: R1, order_type: 'delivery', channel: 'phone', status: 'closed', total_cents: 3100, pricing: { subtotal_cents: 2400, tip_cents: 300 }, delivery: null, customer_name: null, customer_phone_e164: null, note: null, ticket_prefix: 'F', ticket_counter: 7, sales_day: '2026-11-19' },
    pos_order_lines: [], pos_payments: [],
    pos_order_submissions: [{ version: 3, received_at: '2026-11-19T16:59:00.123456+00:00', device_time: '2026-11-19T16:58:30.000Z' }],
  };
  const chain = (t: string) => {
    // deno-lint-ignore no-explicit-any
    const q: any = {};
    for (const m of ['select', 'eq', 'order', 'limit']) q[m] = (...a: unknown[]) => (calls.push([t, m, ...a]), q);
    q.maybeSingle = () => Promise.resolve({ data: result[t], error: null });
    q.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve({ data: result[t], error: null }).then(f, r);
    return q;
  };
  const pg = new PgDeliveryStore({ rpc: () => Promise.resolve({ data: null, error: null }), from: chain });
  const o = (await pg.getPosOrder(R1, 'o'))!;
  assertEquals([o.sales_day, o.first_closed], ['2026-11-19', { device_time: '2026-11-19T16:58:30.000Z', received_at: '2026-11-19T16:59:00.123Z' }]);
  assertEquals(calls.filter((c) => c[0] === 'pos_order_submissions'), [
    ['pos_order_submissions', 'select', 'version, received_at, device_time:payload->>device_time'],
    ['pos_order_submissions', 'eq', 'order_id', 'o'],
    ['pos_order_submissions', 'eq', 'payload->>status', 'closed'],
    ['pos_order_submissions', 'order', 'version', { ascending: true }],
    ['pos_order_submissions', 'limit', 1],
  ]);
  assert(calls.some((c) => c[0] === 'pos_orders' && c[1] === 'select' && String(c[2]).endsWith(', sales_day')));
  result.pos_order_submissions = [];
  assertEquals((await pg.getPosOrder(R1, 'o'))!.first_closed, null);
});

Deno.test('dispatch window (Matt, pos-pickup-exact): closed today and ≤ 120 min ago (first closed device_time, capped at received_at) → books; else stored 409 dispatch_window_passed — nothing claimed, no Uber call, a resend replays it', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const now = () => w.h.clock.now();
  const at = (ms: number) => new Date(ms).toISOString();
  const uberCalls = () => w.uber.calls.filter((c) => c.path.includes('/deliveries')).length;
  const closed = (deviceAgo: number, receivedAgo = deviceAgo) => ({ first_closed: { device_time: at(now() - deviceAgo), received_at: at(now() - receivedAgo) } });
  const refused = async (o: Partial<PosOrderForDelivery>) => {
    const id = w.posOrder(pq, o);
    const actionId = crypto.randomUUID();
    const [rows, calls] = [w.store.deliveries.length, uberCalls()];
    const r = await w.dispatch(id, { action_id: actionId });
    assertEquals([r.status, err(r).code], [409, 'dispatch_window_passed']);
    assertEquals([w.store.deliveries.length, uberCalls()], [rows, calls], 'nothing claimed, no Uber call');
    assertEquals(w.store.actions.get(actionId)!.outcome, 'error', 'stored');
    const again = await w.dispatch(id, { action_id: actionId });
    assertEquals([again.status, err(again).code, uberCalls()], [409, 'dispatch_window_passed', calls], 'a resend replays the stored refusal');
    return String(err(r).message);
  };
  // closed 10 min ago → books
  assertEquals(ok<DispatchBody>(await w.dispatch(w.posOrder(pq, closed(10 * MIN)))).result, 'applied');
  // exactly 120 min → books; 120 min + 1 s → refused
  assertEquals(ok<DispatchBody>(await w.dispatch(w.posOrder(pq, closed(120 * MIN)))).result, 'applied');
  assert((await refused(closed(120 * MIN + 1000))).includes('more than 120 minutes'));
  // closed offline 3 h ago, synced just now → judged by the real close (device_time)
  await refused(closed(180 * MIN, 0));
  // a register clock running FAST (device_time in the future) → capped at received_at (121 min ago → refused)
  await refused(closed(-60 * MIN, 121 * MIN));
  // … and a fast clock with a recent receipt → books
  assertEquals(ok<DispatchBody>(await w.dispatch(w.posOrder(pq, closed(-60 * MIN, 10 * MIN)))).result, 'applied');
  // closed, but no closed version on record → refused (fail closed)
  assert((await refused({ first_closed: null })).includes('no closed version'));
  // no sales day → refused
  await refused({ sales_day: null });
});

Deno.test('dispatch window: a prior business day is refused even within 120 min (closed 03:50 New York, dispatched 04:10)', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  w.h.clock.advance(Date.parse('2026-11-20T09:10:00Z') - w.h.clock.now()); // 04:10 EST, business day 2026-11-20
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq, { sales_day: '2026-11-19', first_closed: { device_time: '2026-11-20T08:50:00.000Z', received_at: '2026-11-20T08:50:02.000Z' } });
  const r = await w.dispatch(id);
  assertEquals([r.status, err(r).code], [409, 'dispatch_window_passed']);
  assert(String(err(r).message).includes('earlier business day (2026-11-19, today 2026-11-20)'));
  assertEquals(w.store.deliveries.length, 0);
  // the same close time on today's business day → books
  assertEquals(ok<DispatchBody>(await w.dispatch(w.posOrder(pq, { sales_day: '2026-11-20', first_closed: { device_time: '2026-11-20T09:00:00.000Z', received_at: '2026-11-20T09:00:01.000Z' } }))).result, 'applied');
});

Deno.test('dispatch window vs the replay: a STALE action whose courier was booked still answers applied for an old order; the 66e6c6f2 case (STALE, no row, order closed days ago) → stored 409, zero Uber calls', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const twoDays = new Date(w.h.clock.now() - 2 * 24 * 60 * MIN).toISOString();
  const old = { first_closed: { device_time: twoDays, received_at: twoDays }, sales_day: '2026-11-17' };
  const seed = async (id: string, actionId: string) => {
    const body = { action_id: actionId, restaurant_id: R1, order_id: id, pickup_ready_minutes: 30, actor_staff_id: 'register', approver_staff_id: null };
    await w.store.beginAction({ actionId, restaurantId: R1, deviceId: w.A.device_id, orderId: id, action: 'dispatch', request: body, actor: 'register', approver: null, deviceTime: null });
    return body;
  };
  // a booked courier behind a stale action: the replay comes first → applied, never the window refusal
  const booked = w.posOrder(pq, old);
  const a1 = crypto.randomUUID();
  const b1 = await seed(booked, a1);
  const c = await w.store.claimDelivery({ pos_order_id: booked, restaurant_id: R1, provider: 'uber_direct', action_id: a1, provider_quote_ref: pq, provider_quote_id: null, customer_fee_cents: 450, quoted_provider_fee_cents: 900, driver_tip_cents: 0, billing_mode: 'platform', provider_environment: 'production' });
  await w.store.updateDelivery(c.delivery.id, { state: 'booked', provider_delivery_id: 'del_x', dispatched_at: new Date(w.h.clock.now()).toISOString() });
  // the 66e6c6f2 shape: begun, then nothing (no row), the order closed two days ago
  const stuck = w.posOrder(pq, old);
  const a2 = crypto.randomUUID();
  const b2 = await seed(stuck, a2);
  w.h.clock.advance(PENDING_STALE_MS);
  assertEquals(ok<DispatchBody>(await w.dispatch(booked, b1)).result, 'applied');
  const r = await w.dispatch(stuck, b2);
  assertEquals([r.status, err(r).code], [409, 'dispatch_window_passed']);
  assertEquals([w.store.deliveries.length, w.uber.calls.filter((x) => x.path.includes('/deliveries')).length, w.store.actions.get(a2)!.outcome], [1, 0, 'error']);
});

Deno.test('dispatch uber_not_active (Matt, pos-pickup-exact): the restaurant no longer resolves to Uber (resolveMode) → stored 409 uber_not_active — nothing claimed, no Uber call; same position as the window', async () => {
  for (const off of [{ uber_direct_active: false }, { delivery_fulfillment: 'in_house' }]) {
    const w = await world();
    w.store.enabled.add(R1);
    const pq = await w.uberQuoteId(); // quoted while Uber was on
    Object.assign(w.db.rows('restaurants')[0], off);
    const id = w.posOrder(pq);
    const actionId = crypto.randomUUID();
    const r = await w.dispatch(id, { action_id: actionId });
    assertEquals([r.status, err(r).code], [409, 'uber_not_active'], JSON.stringify(off));
    assertEquals([w.store.deliveries.length, w.uber.calls.filter((x) => x.path.includes('/deliveries')).length, w.store.actions.get(actionId)!.outcome], [0, 0, 'error']);
    const again = await w.dispatch(id, { action_id: actionId });
    assertEquals(err(again).code, 'uber_not_active');
  }
});

Deno.test('dispatch: a THROW between begin and the claim releases the action (nothing was sent), the 500 propagates; a resend then runs; a throw AFTER the claim leaves it pending (the row exists)', async () => {
  const w = await world();
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  const actionId = crypto.randomUUID();
  // a quote read fails
  const getPq = w.store.getProviderQuote.bind(w.store);
  w.store.getProviderQuote = () => Promise.reject(new Error('db down'));
  await assertRejects(() => w.dispatch(id, { action_id: actionId }), Error, 'db down');
  assertEquals(w.store.actions.has(actionId), false, 'released');
  assert(w.logs.some((l) => l.event === 'delivery_dispatch_released_after_error' && l.action_id === actionId));
  w.store.getProviderQuote = getPq;
  // the claim insert itself fails (what 23502 did live) → released, no row
  const claim = w.store.claimDelivery.bind(w.store);
  w.store.claimDelivery = (() => Promise.reject(new Error('pos_deliveries insert failed: null value in column "state"'))) as typeof claim;
  await assertRejects(() => w.dispatch(id, { action_id: actionId }));
  assertEquals([w.store.actions.has(actionId), w.store.deliveries.length], [false, 0]);
  w.store.claimDelivery = claim;
  // the restaurant read fails → released
  const from = w.db.from.bind(w.db);
  // deno-lint-ignore no-explicit-any
  (w.db as any).from = (t: string) => (t === 'restaurants' ? { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }) } : from(t));
  await assertRejects(() => w.dispatch(id, { action_id: actionId }), Error, 'restaurants read failed');
  assertEquals(w.store.actions.has(actionId), false);
  // deno-lint-ignore no-explicit-any
  (w.db as any).from = from;
  // the resend under the same id now runs
  assertEquals(ok<DispatchBody>(await w.dispatch(id, { action_id: actionId })).result, 'applied');
  assertEquals(w.uber.calls.filter((x) => x.path.endsWith('/deliveries') && x.method === 'POST').length, 1, 'booked once');
  // after the claim: an expired quote's re-quote save fails → NOT released (a booking row exists; the stale rules own it)
  const pq2 = await w.uberQuoteId();
  w.store.providerQuotes.get(pq2)!.expires_at = new Date(w.h.clock.now() - MIN).toISOString();
  const id2 = w.posOrder(pq2);
  const a2 = crypto.randomUUID();
  w.store.insertProviderQuote = () => Promise.reject(new Error('db down'));
  await assertRejects(() => w.dispatch(id2, { action_id: a2 }), Error, 'db down');
  assertEquals([w.store.actions.get(a2)?.outcome, w.store.deliveries.at(-1)!.state], [null, 'booking']);
});

Deno.test('dispatch: the restaurant has no valid time zone → 500 delivery_config_invalid, NOT stored (released) — a resend works once fixed', async () => {
  const w = await world({ restaurant: { timezone: 'Mars/Olympus' } });
  w.store.enabled.add(R1);
  const pq = await w.uberQuoteId();
  const id = w.posOrder(pq);
  const actionId = crypto.randomUUID();
  const r = await w.dispatch(id, { action_id: actionId });
  assertEquals([r.status, err(r).code, w.store.actions.has(actionId)], [500, 'delivery_config_invalid', false]);
  w.db.rows('restaurants')[0].timezone = 'America/New_York';
  assertEquals(ok<DispatchBody>(await w.dispatch(id, { action_id: actionId })).result, 'applied');
});
