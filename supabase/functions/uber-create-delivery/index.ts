// ============================================================================
// uber-create-delivery — Dispatch an Uber Direct delivery for a paid order
// ============================================================================
//
// Milestone 9a of the Uber Direct integration. Called from the tablet
// OrdersTab when the operator taps Accept on an uber_direct order. Posts
// to Uber's POST /v1/customers/{customer_id}/deliveries endpoint to
// create a real Uber Direct delivery, populates the orders row with the
// returned delivery_id + tracking_url + status, and transitions the
// order status to 'in_progress'.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Handler validates auth manually, matching uber-token's pattern:
//   - Authorization: Bearer <tablet user JWT>
//   - getUser() → email; restaurants.tablet_email must match
// All DB access via SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
//
// Flow:
//   1. CORS preflight + method check
//   2. Parse body: { order_id, pickup_ready_minutes, pickup_deadline_minutes?,
//                    accepted_quote_id? }
//   3. Authorize tablet user owns the order's restaurant
//   4. Fetch order + restaurant (FK join)
//   5. Validate order.delivery_fulfillment_method === 'uber_direct'
//   6. Idempotency: if order.uber_delivery_id is set, return existing
//   7. Status check: 'new' or 'scheduled' acceptable
//   8. Load cached quote (by accepted_quote_id if present, else by
//      order.uber_quote_id)
//   9. Quote freshness check (60s buffer matching create-payment-intent):
//      - Valid → use it directly
//      - Expired + accepted_quote_id → 'accepted_quote_expired' (operator
//        must restart)
//      - Expired + no accepted_quote_id → refresh path (step 10)
//      - Cache miss → 'quote_not_found'
//  10. Quote refresh (when expired):
//      - Requires order.dropoff_lat + order.dropoff_lng; otherwise return
//        'quote_expired_no_dropoff_coords' (pre-M9a orders won't have these)
//      - Re-call Uber's delivery_quotes endpoint
//      - Apply current passthrough policy
//      - Cache the new quote (insert into uber_quotes)
//      - Compare new customer_delivery_fee_cents vs old
//      - |delta| >= 200 cents (Decision #1) → 'quote_price_changed' with
//        new_quote_id; operator's modal calls back with accepted_quote_id
//      - Otherwise: silent proceed with new quote
//  11. Build manifest from order_items (Decision #5: "{quantity}x {name}",
//      size 'small', price = base_price_cents)
//  12. POST to Uber deliveries endpoint
//      - Sandbox gate (confirmed): inject
//        test_specifications.robo_courier_specification.mode='auto' only
//        when restaurant.uber_environment === 'sandbox'. Production MUST
//        NEVER receive this field.
//  13. Handle response:
//      - 200/201 → success
//      - 400/404 → 'bad_address' with detail
//      - 429 → 'rate_limited' with retry_after
//      - other → 'uber_unavailable'
//  14. DB writes (single UPDATE on orders):
//      - uber_delivery_id, uber_tracking_url, uber_status,
//        uber_status_updated_at, uber_dispatched_at, status='in_progress',
//        accepted_at (if first transition from 'new')
//      - If quote refreshed: also update uber_quote_id + uber_quoted_fee
//        so the audit trail reflects what we dispatched against
//  15. Return { success: true, delivery_id, tracking_url, status,
//      refreshed_quote }
//
// Error response shapes (all HTTP 200 unless noted; 4xx for auth /
// request-shape errors):
//   - { error: 'invalid_inputs', detail }                              [400]
//   - { error: 'missing_auth' | 'invalid_auth' }                       [401]
//   - { error: 'forbidden' }                                           [403]
//   - { error: 'order_not_found' | 'restaurant_not_found' }            [404]
//   - { error: 'not_uber_direct', detail }                             [200]
//   - { success: true, idempotent: true, ...existing fields }          [200]
//   - { error: 'invalid_status', detail }                              [200]
//   - { error: 'missing_quote_id' | 'quote_not_found' |
//       'wrong_restaurant' | 'accepted_quote_expired' |
//       'quote_expired_no_dropoff_coords' }                            [200]
//   - { error: 'quote_price_changed', new_fee_cents, original_fee_cents,
//       delta_cents, new_quote_id }                                    [200]
//   - { error: 'no_uber_available', status }                           [200]
//   - { error: 'bad_address', status, detail }                         [200]
//   - { error: 'rate_limited', retry_after }                           [200]
//   - { error: 'uber_unavailable', status?, detail }                   [200]
//   - { error: 'db_error', detail, ... }                          [200/500]
//
// Risk to 8 production restaurants: zero. All in_house — code returns
// 'not_uber_direct' at step 5 if any non-uber_direct order_id is passed.
// The tablet only opens the prep-time modal for uber_direct orders, so
// this function is never called for in_house orders in practice.
//
// Schema dependency: requires migration 034 (uber_dispatched_at column
// + dropoff_lat/lng + uber_webhook_events). Function will 500 on the
// orders UPDATE if migration 034 hasn't been applied (uber_dispatched_at
// column missing).
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "../_shared/uberToken.ts";
import { getUberApiBase, UberEnvironment } from "../_shared/uberConfig.ts";
import { applyPassthrough } from "../_shared/uberPassthrough.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Threshold for surfacing the quote_price_changed modal to the operator
// (Decision #1). Absolute delta in customer-facing cents. Below this:
// silent proceed with new quote. At or above: return error to tablet so
// the operator can review and decide Accept Anyway / Cancel & Refund.
const PRICE_CHANGE_THRESHOLD_CENTS = 200;

// Default pickup_deadline_dt window (Decision #2). pickup_ready_dt is
// operator-chosen via pickup_ready_minutes; deadline is +30 min from ready.
const DEFAULT_PICKUP_DEADLINE_MINUTES = 30;

// Default dropoff_deadline_dt window (Uber's typical SLA after pickup_ready).
// Uber requires both dropoff_ready_dt and dropoff_deadline_dt; we use
// pickup_ready as dropoff_ready and pickup_ready + 60 min as the deadline.
const DEFAULT_DROPOFF_DEADLINE_AFTER_READY_MINUTES = 60;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  // -------- Parse body --------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "invalid_body" }, 400);
  }

  const {
    order_id,
    pickup_ready_minutes,
    pickup_deadline_minutes,
    accepted_quote_id,
  } = body || {};

  if (typeof order_id !== "string" || !order_id) {
    return jsonResponse(
      { success: false, error: "invalid_inputs", detail: "order_id_required" },
      400
    );
  }
  if (
    typeof pickup_ready_minutes !== "number" ||
    pickup_ready_minutes < 1 ||
    pickup_ready_minutes > 240
  ) {
    return jsonResponse(
      {
        success: false,
        error: "invalid_inputs",
        detail: "pickup_ready_minutes_required_1_to_240",
      },
      400
    );
  }

  // -------- Authorize --------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "missing_auth" }, 401);
  }
  const tokenStr = authHeader.slice("Bearer ".length).trim();

  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    tokenStr
  );
  if (authErr || !user || !user.email) {
    return jsonResponse({ success: false, error: "invalid_auth" }, 401);
  }

  // -------- Fetch order + restaurant (FK join) --------
  // Service-role select bypasses RLS; ownership verified after fetch via
  // restaurants.tablet_email match (same pattern as uber-token).
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id, order_number, status, delivery_fulfillment_method,
      uber_quote_id, uber_delivery_id, uber_tracking_url, uber_status,
      accepted_at, restaurant_id, customer_name, customer_phone,
      delivery_address, special_instructions,
      dropoff_lat, dropoff_lng,
      subtotal, tip_amount,
      restaurants:restaurant_id (
        id, name, address, phone, latitude, longitude,
        uber_customer_id, uber_environment,
        uber_passthrough_mode, uber_passthrough_value,
        tablet_email
      )
    `)
    .eq("id", order_id)
    .maybeSingle();

  if (orderErr) {
    console.error("[uber-create-delivery] order fetch failed", orderErr);
    return jsonResponse(
      { success: false, error: "db_error", detail: orderErr.message },
      500
    );
  }
  if (!order) {
    return jsonResponse({ success: false, error: "order_not_found" }, 404);
  }

  const restaurant = (order as any).restaurants;
  if (!restaurant) {
    console.error("[uber-create-delivery] restaurant join failed", { order_id });
    return jsonResponse({ success: false, error: "restaurant_not_found" }, 404);
  }

  if (restaurant.tablet_email !== user.email) {
    return jsonResponse({ success: false, error: "forbidden" }, 403);
  }
  // Past this point, caller is authorized.

  // -------- Validate fulfillment mode --------
  if (order.delivery_fulfillment_method !== "uber_direct") {
    return jsonResponse({
      success: false,
      error: "not_uber_direct",
      detail: `order is ${order.delivery_fulfillment_method}; uber-create-delivery only handles uber_direct`,
    });
  }

  // -------- Idempotency --------
  // If this order has already been dispatched, return the existing
  // delivery info. Prevents double-dispatch on accidental double-tap.
  if (order.uber_delivery_id) {
    return jsonResponse({
      success: true,
      idempotent: true,
      delivery_id: order.uber_delivery_id,
      tracking_url: order.uber_tracking_url,
      status: order.uber_status,
    });
  }

  // -------- Status check --------
  // Only 'new' or 'scheduled' orders can be dispatched. 'in_progress'
  // means already accepted (bug if uber_delivery_id is null); 'complete'
  // and 'cancelled' are terminal.
  if (order.status !== "new" && order.status !== "scheduled") {
    return jsonResponse({
      success: false,
      error: "invalid_status",
      detail: `order status is ${order.status}; expected 'new' or 'scheduled'`,
    });
  }

  // -------- Load cached quote --------
  // If accepted_quote_id was passed, the operator has already acknowledged
  // a price change in a previous round-trip — use that quote_id. Otherwise
  // use the order's original quote_id.
  const lookupQuoteId = accepted_quote_id || order.uber_quote_id;
  if (!lookupQuoteId) {
    return jsonResponse({ success: false, error: "missing_quote_id" });
  }

  const { data: cachedQuote, error: cacheReadErr } = await supabase
    .from("uber_quotes")
    .select("*")
    .eq("quote_id", lookupQuoteId)
    .maybeSingle();

  if (cacheReadErr) {
    return jsonResponse(
      { success: false, error: "db_error", detail: cacheReadErr.message },
      500
    );
  }
  if (!cachedQuote) {
    return jsonResponse({ success: false, error: "quote_not_found" });
  }

  // Cross-restaurant attack defense (same check as M6 create-payment-intent).
  if (cachedQuote.restaurant_id !== restaurant.id) {
    return jsonResponse({ success: false, error: "wrong_restaurant" });
  }

  // -------- Quote freshness + refresh --------
  // 60-second buffer matches create-payment-intent's freshness gate so
  // we don't lock a quote that's seconds from expiring.
  const expiresAtMs = new Date(cachedQuote.expires_at).getTime();
  const stillValid = expiresAtMs > Date.now() + 60 * 1000;

  let finalQuoteId: string = cachedQuote.quote_id;
  let finalUberFeeCents: number = cachedQuote.uber_quoted_fee_cents;

  if (!stillValid) {
    if (accepted_quote_id) {
      // The operator-accepted quote has now also expired. Force restart
      // — operator must reload the order to get a fresh price-change
      // round-trip. Rare case (operator walked away from tablet).
      return jsonResponse({
        success: false,
        error: "accepted_quote_expired",
        detail:
          "the operator-accepted quote has expired; reload the order and re-Accept",
      });
    }

    if (!order.dropoff_lat || !order.dropoff_lng) {
      // Pre-M9a uber_direct orders won't have dropoff coordinates.
      // Operator must handle manually (cancel + refund + ask customer
      // to redo, or wait for the quote to come back valid which won't
      // happen — expired quotes are gone).
      return jsonResponse({
        success: false,
        error: "quote_expired_no_dropoff_coords",
        detail:
          "expired quote but order is missing dropoff coordinates; cannot refresh automatically",
      });
    }

    const tokenResult = await getUberToken(supabase, restaurant.id);
    if (!tokenResult.success) {
      return jsonResponse({
        success: false,
        step: "mint_token",
        error: tokenResult.error,
        detail: tokenResult.detail,
        status: tokenResult.status,
        retry_after: tokenResult.retry_after,
      });
    }

    const refreshEnv =
      (restaurant.uber_environment as UberEnvironment | null) ?? "production";
    const refreshApiBase = getUberApiBase(refreshEnv);
    const refreshUrl = `${refreshApiBase}/v1/customers/${restaurant.uber_customer_id}/delivery_quotes`;

    // Mirror uber-quote/index.ts payload structure so behavior at refresh
    // matches behavior at initial quote.
    const refreshPayload = {
      pickup_address: JSON.stringify({
        street_address: [restaurant.address || ""],
        country: "US",
      }),
      pickup_latitude: Number(restaurant.latitude),
      pickup_longitude: Number(restaurant.longitude),
      pickup_phone_number: restaurant.phone || "",
      dropoff_address: JSON.stringify({
        street_address: [order.delivery_address || ""],
        country: "US",
      }),
      dropoff_latitude: Number(order.dropoff_lat),
      dropoff_longitude: Number(order.dropoff_lng),
      dropoff_phone_number: order.customer_phone || "",
    };

    let refreshResp: Response;
    try {
      refreshResp = await fetch(refreshUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenResult.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(refreshPayload),
      });
    } catch (err) {
      console.error("[uber-create-delivery] refresh network failure", err);
      return jsonResponse({
        success: false,
        step: "refresh_quote",
        error: "uber_unavailable",
        detail: `network: ${String(err)}`,
      });
    }

    if (refreshResp.status === 400 || refreshResp.status === 404) {
      // Uber rejected the address — surface 'no_uber_available' so the
      // tablet shows the "Switch to in-house?" toast.
      return jsonResponse({
        success: false,
        step: "refresh_quote",
        error: "no_uber_available",
        status: refreshResp.status,
      });
    }
    if (!refreshResp.ok) {
      return jsonResponse({
        success: false,
        step: "refresh_quote",
        error: "uber_unavailable",
        status: refreshResp.status,
      });
    }

    let refreshBody: any;
    try {
      refreshBody = await refreshResp.json();
    } catch {
      return jsonResponse({
        success: false,
        step: "refresh_quote",
        error: "uber_unavailable",
        detail: "malformed Uber refresh response",
      });
    }

    const newQuoteId: string | undefined =
      refreshBody.id || refreshBody.quote_id;
    const newUberFeeCents: number | undefined = refreshBody.fee;
    const newExpires: string | undefined = refreshBody.expires;

    if (!newQuoteId || typeof newUberFeeCents !== "number") {
      return jsonResponse({
        success: false,
        step: "refresh_quote",
        error: "uber_unavailable",
        detail: "missing id/fee in refresh response",
      });
    }

    const recomputed = applyPassthrough(
      newUberFeeCents,
      restaurant.uber_passthrough_mode,
      Number(restaurant.uber_passthrough_value || 0)
    );
    const newCustomerFeeCents = recomputed.customer_cents;
    const newRestaurantCents = recomputed.restaurant_cents;
    const newExpiresIso = newExpires
      ? new Date(newExpires).toISOString()
      : new Date(Date.now() + 5 * 60 * 1000).toISOString();

    // Cache the refreshed quote so the operator's "Accept Anyway"
    // round-trip can look it up by accepted_quote_id.
    const { error: cacheWriteErr } = await supabase
      .from("uber_quotes")
      .insert({
        quote_id: newQuoteId,
        restaurant_id: restaurant.id,
        uber_quoted_fee_cents: newUberFeeCents,
        customer_delivery_fee_cents: newCustomerFeeCents,
        restaurant_absorbs_cents: newRestaurantCents,
        uber_environment: refreshEnv,
        passthrough_mode: restaurant.uber_passthrough_mode,
        passthrough_value: Number(restaurant.uber_passthrough_value || 0),
        expires_at: newExpiresIso,
      });
    if (cacheWriteErr) {
      console.error(
        "[uber-create-delivery] refresh cache write failed",
        cacheWriteErr
      );
      // Non-fatal here — the in-memory quote is still usable for the
      // current dispatch. The "Accept Anyway" round-trip would re-fetch
      // and find nothing, but that only matters in the price-change
      // branch below.
    }

    // Price-change check (Decision #1). Absolute delta in customer-facing
    // cents. At or above threshold → bounce to operator. Below: proceed.
    const deltaCents =
      newCustomerFeeCents - cachedQuote.customer_delivery_fee_cents;
    if (Math.abs(deltaCents) >= PRICE_CHANGE_THRESHOLD_CENTS) {
      return jsonResponse({
        success: false,
        error: "quote_price_changed",
        new_fee_cents: newCustomerFeeCents,
        original_fee_cents: cachedQuote.customer_delivery_fee_cents,
        delta_cents: deltaCents,
        new_quote_id: newQuoteId,
      });
    }

    // Within tolerance: silent proceed with new quote.
    finalQuoteId = newQuoteId;
    finalUberFeeCents = newUberFeeCents;
  }
  // -------- End quote freshness/refresh block --------

  // -------- Mint or fetch Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant.id);
  if (!tokenResult.success) {
    return jsonResponse({
      success: false,
      step: "mint_token",
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    });
  }

  // -------- Fetch order items for manifest --------
  const { data: orderItems, error: itemsErr } = await supabase
    .from("order_items")
    .select("item_name, quantity, base_price")
    .eq("order_id", order_id);

  if (itemsErr) {
    console.error("[uber-create-delivery] order_items fetch failed", itemsErr);
    return jsonResponse(
      { success: false, error: "db_error", detail: itemsErr.message },
      500
    );
  }

  // Build manifest per Decision #5: name "{quantity}x {item_name}",
  // size 'small', price in cents from base_price (numeric dollars in DB).
  // base_price is per-unit; manifest_total_value is order.subtotal (cents).
  const manifestItems = (orderItems || []).map((it: any) => ({
    name: `${it.quantity}x ${it.item_name}`,
    quantity: it.quantity,
    size: "small",
    price: Math.round(Number(it.base_price || 0) * 100),
  }));

  const manifestTotalCents = Math.round(Number(order.subtotal || 0) * 100);
  const tipCents = Math.round(Number(order.tip_amount || 0) * 100);

  // -------- Compute ready/deadline timestamps --------
  const nowMs = Date.now();
  const pickupReadyMs = nowMs + pickup_ready_minutes * 60 * 1000;
  const pickupDeadlineOffsetMinutes =
    typeof pickup_deadline_minutes === "number" && pickup_deadline_minutes > 0
      ? pickup_deadline_minutes
      : DEFAULT_PICKUP_DEADLINE_MINUTES;
  const pickupDeadlineMs =
    pickupReadyMs + pickupDeadlineOffsetMinutes * 60 * 1000;
  const dropoffReadyMs = pickupReadyMs;
  const dropoffDeadlineMs =
    pickupReadyMs + DEFAULT_DROPOFF_DEADLINE_AFTER_READY_MINUTES * 60 * 1000;

  // -------- Construct Uber create-delivery payload --------
  const env =
    (restaurant.uber_environment as UberEnvironment | null) ?? "production";
  // [diag] M9b smoke test — TEMP: remove after Robocourier activation verified
  console.log("[diag] env value:", env);
  const apiBase = getUberApiBase(env);
  const deliveryUrl = `${apiBase}/v1/customers/${restaurant.uber_customer_id}/deliveries`;

  const deliveryPayload: any = {
    quote_id: finalQuoteId,
    pickup_name: restaurant.name,
    pickup_business_name: restaurant.name,
    pickup_address: JSON.stringify({
      street_address: [restaurant.address || ""],
      country: "US",
    }),
    pickup_latitude: Number(restaurant.latitude),
    pickup_longitude: Number(restaurant.longitude),
    pickup_phone_number: restaurant.phone || "",
    pickup_notes: `Order #${order.order_number}`,
    pickup_ready_dt: new Date(pickupReadyMs).toISOString(),
    pickup_deadline_dt: new Date(pickupDeadlineMs).toISOString(),
    dropoff_name: order.customer_name,
    dropoff_address: JSON.stringify({
      street_address: [order.delivery_address || ""],
      country: "US",
    }),
    dropoff_phone_number: order.customer_phone || "",
    dropoff_notes: order.special_instructions || "",
    dropoff_ready_dt: new Date(dropoffReadyMs).toISOString(),
    dropoff_deadline_dt: new Date(dropoffDeadlineMs).toISOString(),
    manifest_items: manifestItems,
    manifest_total_value: manifestTotalCents,
    tip: tipCents,
  };

  // Only attach dropoff coordinates when we have them. JSON.stringify
  // drops undefined fields, but for valid orders post-M9a these will
  // always be set. When missing (pre-M9a uber_direct orders), Uber
  // falls back to geocoding the address.
  if (order.dropoff_lat != null) {
    deliveryPayload.dropoff_latitude = Number(order.dropoff_lat);
  }
  if (order.dropoff_lng != null) {
    deliveryPayload.dropoff_longitude = Number(order.dropoff_lng);
  }

  // Sandbox gate (confirmed in M9a decisions): inject Robocourier auto-
  // mode ONLY when uber_environment === 'sandbox'. Production MUST NEVER
  // receive test_specifications — would dispatch a fake courier on a
  // real merchant account.
  if (env === "sandbox") {
    deliveryPayload.test_specifications = {
      robo_courier_specification: { mode: "auto" },
    };
  }
  // [diag] M9b smoke test — TEMP: remove after Robocourier activation verified
  console.log("[diag] test_specifications in payload:", "test_specifications" in deliveryPayload);

  // -------- POST to Uber --------
  // [diag] M9b smoke test — TEMP: remove after Robocourier activation verified
  console.log("[diag] outgoing payload:", JSON.stringify(deliveryPayload));
  let createResp: Response;
  try {
    createResp = await fetch(deliveryUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(deliveryPayload),
    });
  } catch (err) {
    console.error("[uber-create-delivery] network failure to Uber", err);
    return jsonResponse({
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    });
  }

  if (createResp.status === 429) {
    const retryAfter = Number(createResp.headers.get("retry-after")) || 60;
    return jsonResponse({
      success: false,
      step: "create_delivery",
      error: "rate_limited",
      retry_after: retryAfter,
    });
  }

  if (createResp.status === 400 || createResp.status === 404) {
    let detail = "";
    try {
      detail = (await createResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return jsonResponse({
      success: false,
      step: "create_delivery",
      error: "bad_address",
      status: createResp.status,
      detail,
    });
  }

  if (!createResp.ok) {
    let detail = "";
    try {
      detail = (await createResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return jsonResponse({
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      status: createResp.status,
      detail,
    });
  }

  let createBody: any;
  try {
    createBody = await createResp.json();
  } catch {
    return jsonResponse({
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: "malformed Uber create response",
    });
  }

  const deliveryId: string | undefined =
    createBody.id || createBody.delivery_id;
  const trackingUrl: string | undefined = createBody.tracking_url;
  const uberStatusOut: string = createBody.status || "pending";

  if (!deliveryId) {
    console.error(
      "[uber-create-delivery] missing delivery id in Uber response",
      createBody
    );
    return jsonResponse({
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: "missing delivery id in response",
    });
  }

  // -------- DB writes --------
  // Single UPDATE: stamps Uber tracking fields + transitions order status
  // to 'in_progress' + accepted_at (if first transition). If we refreshed
  // the quote, persist the new quote_id and fee so the audit trail
  // reflects what we actually dispatched against.
  //
  // uber_dispatched_at column added by migration 034.
  const nowIso = new Date().toISOString();
  const updates: any = {
    uber_delivery_id: deliveryId,
    uber_tracking_url: trackingUrl || null,
    uber_status: uberStatusOut,
    uber_status_updated_at: nowIso,
    uber_dispatched_at: nowIso,
    // M10: Persist the pickup commitment time so the tablet tile can show
    // "scheduled for X:XX" without re-deriving from pickupReadyMs. Column
    // added in migration 035.
    uber_pickup_ready_dt: new Date(pickupReadyMs).toISOString(),
    status: "in_progress",
  };
  if (!order.accepted_at) {
    updates.accepted_at = nowIso;
  }
  const refreshed = finalQuoteId !== order.uber_quote_id;
  if (refreshed) {
    updates.uber_quote_id = finalQuoteId;
    // orders.uber_quoted_fee is numeric dollars per M5d.
    updates.uber_quoted_fee = finalUberFeeCents / 100;
  }

  const { error: updateErr } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", order_id);

  if (updateErr) {
    console.error("[uber-create-delivery] orders update failed", updateErr);
    // Uber delivery was created successfully but we couldn't persist it
    // on our side. Surface the delivery_id so the operator could be told
    // what happened and manual reconciliation is possible.
    return jsonResponse(
      {
        success: false,
        step: "persist",
        error: "db_error",
        detail: updateErr.message,
        delivery_id: deliveryId,
        tracking_url: trackingUrl,
      },
      500
    );
  }

  return jsonResponse({
    success: true,
    delivery_id: deliveryId,
    tracking_url: trackingUrl || null,
    status: uberStatusOut,
    refreshed_quote: refreshed,
  });
});
