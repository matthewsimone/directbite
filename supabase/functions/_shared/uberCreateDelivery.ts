// ============================================================================
// uberCreateDelivery — Dispatch an Uber Direct delivery for a paid order
// ============================================================================
//
// Shared library (not an edge function) — the single source of truth for the
// Uber Direct create-delivery core. Imported in-process by:
//   - uber-create-delivery/index.ts  (tablet ASAP path; auth in the handler)
//   - stripe-webhook/index.ts          (scheduled-order upfront booking; later)
// Mirrors the _shared/uberCancel.ts precedent (no function-to-function HTTP
// hop, no re-auth dance). All DB access via the service-role client the caller
// passes in.
//
// The handler owns transport (auth, input validation, order/restaurant fetch
// + ownership) and passes the already-fetched rows. This module owns the
// business logic:
//   - fulfillment-mode validation, idempotency, status check
//   - cached-quote load → freshness/refresh → price-change guard
//   - manifest build from order_items
//   - Uber POST (sandbox robocourier gate)
//   - single orders UPDATE (status set from opts.postWriteStatus)
//
// Timing input is EITHER absolute (pickupReadyDt, ISO — scheduled path) OR
// relative (pickupReadyMinutes — ASAP path). The relative branch is
// byte-identical to the pre-extraction code (Date.now() + minutes*60000).
//
// Return shape: { status, body } — the exact HTTP status + JSON body the
// HTTP handler should send. Reusing callers (webhook) branch on body.success.
// This 1:1 relay is what keeps the tablet path's responses byte-identical.
// ============================================================================

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "./uberToken.ts";
import { getUberApiBase, UberEnvironment } from "./uberConfig.ts";
import { applyPassthrough } from "./uberPassthrough.ts";
import { logUber } from "./uberLog.ts";

// Threshold for surfacing the quote_price_changed modal to the operator
// (Decision #1). Absolute delta in customer-facing cents. Below this:
// silent proceed with new quote. At or above: return error so the caller can
// review and decide Accept Anyway / Cancel & Refund.
const PRICE_CHANGE_THRESHOLD_CENTS = 200;

// Default pickup_deadline_dt window (Decision #2). pickup_ready_dt is
// operator-chosen via pickupReadyMinutes; deadline is +30 min from ready.
const DEFAULT_PICKUP_DEADLINE_MINUTES = 30;

// Default dropoff_deadline_dt window (Uber's typical SLA after pickup_ready).
// Uber requires both dropoff_ready_dt and dropoff_deadline_dt; we use
// pickup_ready as dropoff_ready and pickup_ready + 60 min as the deadline.
const DEFAULT_DROPOFF_DEADLINE_AFTER_READY_MINUTES = 60;

// Minimal shapes — callers pass the already-fetched order + restaurant rows.
// Only the fields this function reads are declared; both rows carry more.
interface CreateDeliveryOrder {
  id: string;
  order_number: number | string;
  status: string;
  delivery_fulfillment_method: string | null;
  uber_quote_id: string | null;
  uber_delivery_id: string | null;
  uber_tracking_url: string | null;
  uber_status: string | null;
  accepted_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  special_instructions: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  subtotal: number | null;
  tip_amount: number | null;
}

interface CreateDeliveryRestaurant {
  id: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  uber_customer_id: string | null;
  uber_environment: string | null;
  uber_passthrough_mode: string | null;
  uber_passthrough_value: number | null;
}

export interface CreateDeliveryOptions {
  // Provide exactly one of the two timing inputs.
  pickupReadyMinutes?: number; // relative (ASAP/tablet path)
  pickupReadyDt?: string;      // absolute ISO (scheduled path)
  pickupDeadlineMinutes?: number; // optional override; defaults to 30
  acceptedQuoteId?: string | null;
  postWriteStatus: string; // order status after a successful booking
  // When false, do NOT stamp accepted_at at booking. Used by the book-at-
  // placement path (status stays 'new') so accepted_at keeps its meaning
  // "operator first acted on the order" — set later by the tablet's
  // updateStatus on real accept. Defaults to true (ASAP/tablet path
  // stamps accepted_at on first transition, byte-identical to before).
  stampAcceptedAt?: boolean;
}

export interface UberCreateDeliveryResult {
  status: number;
  body: Record<string, unknown>;
}

function make(
  body: Record<string, unknown>,
  status = 200
): UberCreateDeliveryResult {
  return { status, body };
}

export async function createUberDelivery(
  supabase: SupabaseClient,
  order: CreateDeliveryOrder,
  restaurant: CreateDeliveryRestaurant,
  opts: CreateDeliveryOptions
): Promise<UberCreateDeliveryResult> {
  // -------- Validate fulfillment mode --------
  if (order.delivery_fulfillment_method !== "uber_direct") {
    return make({
      success: false,
      error: "not_uber_direct",
      detail: `order is ${order.delivery_fulfillment_method}; uber-create-delivery only handles uber_direct`,
    });
  }

  // -------- Idempotency --------
  // If this order has already been dispatched, return the existing
  // delivery info. Prevents double-dispatch on accidental double-tap.
  if (order.uber_delivery_id) {
    return make({
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
    return make({
      success: false,
      error: "invalid_status",
      detail: `order status is ${order.status}; expected 'new' or 'scheduled'`,
    });
  }

  // -------- Load cached quote --------
  // If acceptedQuoteId was passed, the operator has already acknowledged
  // a price change in a previous round-trip — use that quote_id. Otherwise
  // use the order's original quote_id.
  const lookupQuoteId = opts.acceptedQuoteId || order.uber_quote_id;
  if (!lookupQuoteId) {
    return make({ success: false, error: "missing_quote_id" });
  }

  const { data: cachedQuote, error: cacheReadErr } = await supabase
    .from("uber_quotes")
    .select("*")
    .eq("quote_id", lookupQuoteId)
    .maybeSingle();

  if (cacheReadErr) {
    return make(
      { success: false, error: "db_error", detail: cacheReadErr.message },
      500
    );
  }
  if (!cachedQuote) {
    return make({ success: false, error: "quote_not_found" });
  }

  // Cross-restaurant attack defense (same check as M6 create-payment-intent).
  if (cachedQuote.restaurant_id !== restaurant.id) {
    return make({ success: false, error: "wrong_restaurant" });
  }

  // -------- Quote freshness + refresh --------
  // 60-second buffer matches create-payment-intent's freshness gate so
  // we don't lock a quote that's seconds from expiring.
  const expiresAtMs = new Date(cachedQuote.expires_at).getTime();
  const stillValid = expiresAtMs > Date.now() + 60 * 1000;

  let finalQuoteId: string = cachedQuote.quote_id;
  let finalUberFeeCents: number = cachedQuote.uber_quoted_fee_cents;

  if (!stillValid) {
    if (opts.acceptedQuoteId) {
      // The operator-accepted quote has now also expired. Force restart
      // — operator must reload the order to get a fresh price-change
      // round-trip. Rare case (operator walked away from tablet).
      return make({
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
      return make({
        success: false,
        error: "quote_expired_no_dropoff_coords",
        detail:
          "expired quote but order is missing dropoff coordinates; cannot refresh automatically",
      });
    }

    const tokenResult = await getUberToken(supabase, restaurant.id);
    if (!tokenResult.success) {
      return make({
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
    const tRefresh0 = Date.now();
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
      return make({
        success: false,
        step: "refresh_quote",
        error: "uber_unavailable",
        detail: `network: ${String(err)}`,
      });
    }
    logUber({
      fn: "createUberDelivery",
      event: "quote_refresh",
      order_id: order.id,
      restaurant_id: restaurant.id,
      uber_http_status: refreshResp.status,
      outcome: refreshResp.ok ? "ok" : "http_error",
      ms: Date.now() - tRefresh0,
    });

    if (refreshResp.status === 400 || refreshResp.status === 404) {
      // Uber rejected the address — surface 'no_uber_available' so the
      // tablet shows the "Switch to in-house?" toast.
      return make({
        success: false,
        step: "refresh_quote",
        error: "no_uber_available",
        status: refreshResp.status,
      });
    }
    if (!refreshResp.ok) {
      return make({
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
      return make({
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
      return make({
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
      return make({
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
    return make({
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
    .eq("order_id", order.id);

  if (itemsErr) {
    console.error("[uber-create-delivery] order_items fetch failed", itemsErr);
    return make(
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
  // Timing input is EITHER absolute (pickupReadyDt, scheduled path) OR
  // relative (pickupReadyMinutes, ASAP/tablet path). The relative branch is
  // byte-identical to the pre-extraction behavior (Date.now() + minutes).
  const pickupReadyMs = opts.pickupReadyDt
    ? Date.parse(opts.pickupReadyDt)
    : Date.now() + (opts.pickupReadyMinutes as number) * 60 * 1000;
  const pickupDeadlineOffsetMinutes =
    typeof opts.pickupDeadlineMinutes === "number" &&
    opts.pickupDeadlineMinutes > 0
      ? opts.pickupDeadlineMinutes
      : DEFAULT_PICKUP_DEADLINE_MINUTES;
  const pickupDeadlineMs =
    pickupReadyMs + pickupDeadlineOffsetMinutes * 60 * 1000;
  const dropoffReadyMs = pickupReadyMs;
  const dropoffDeadlineMs =
    pickupReadyMs + DEFAULT_DROPOFF_DEADLINE_AFTER_READY_MINUTES * 60 * 1000;

  // -------- Construct Uber create-delivery payload --------
  const env =
    (restaurant.uber_environment as UberEnvironment | null) ?? "production";
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

  // -------- FIX②: final coord guard before dispatch --------
  // The expired-quote refresh path guards earlier (it needs coords to
  // re-quote). This covers the VALID-quote path, which otherwise dispatches
  // without dropoff coordinates (they're only attached conditionally above) —
  // letting Uber geocode the address itself, which mismatches the quote's
  // location and produces a "delivery location changed" rejection (the
  // #1000436 bug). Refuse to dispatch coordless regardless of quote freshness.
  if (order.dropoff_lat == null || order.dropoff_lng == null) {
    return make({
      success: false,
      error: "missing_dropoff_coords",
      detail: "order is missing dropoff coordinates; cannot dispatch to Uber",
    });
  }

  // -------- POST to Uber --------
  let createResp: Response;
  const tCreate0 = Date.now();
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
    return make({
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    });
  }
  logUber({
    fn: "createUberDelivery",
    event: "create_delivery",
    order_id: order.id,
    restaurant_id: restaurant.id,
    uber_http_status: createResp.status,
    outcome: createResp.ok ? "ok" : "http_error",
    ms: Date.now() - tCreate0,
  });

  if (createResp.status === 429) {
    const retryAfter = Number(createResp.headers.get("retry-after")) || 60;
    return make({
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
    return make({
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
    return make({
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
    return make({
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
    return make({
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: "missing delivery id in response",
    });
  }

  // -------- DB writes --------
  // Single UPDATE: stamps Uber tracking fields + transitions order status
  // to opts.postWriteStatus + accepted_at (if first transition). If we
  // refreshed the quote, persist the new quote_id and fee so the audit
  // trail reflects what we actually dispatched against.
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
    status: opts.postWriteStatus,
  };
  if (opts.stampAcceptedAt !== false && !order.accepted_at) {
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
    .eq("id", order.id);

  logUber({
    fn: "createUberDelivery",
    event: "create_persist",
    order_id: order.id,
    restaurant_id: restaurant.id,
    uber_delivery_id: deliveryId,
    outcome: updateErr ? "db_error" : "ok",
  });

  if (updateErr) {
    console.error("[uber-create-delivery] orders update failed", updateErr);
    // Uber delivery was created successfully but we couldn't persist it
    // on our side. Surface the delivery_id so the operator could be told
    // what happened and manual reconciliation is possible.
    return make(
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

  return make({
    success: true,
    delivery_id: deliveryId,
    tracking_url: trackingUrl || null,
    status: uberStatusOut,
    refreshed_quote: refreshed,
  });
}
