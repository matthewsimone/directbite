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
import { createUberDelivery } from "../_shared/uberCreateDelivery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
    pickup_ready_dt,
    pickup_deadline_minutes,
    accepted_quote_id,
  } = body || {};

  if (typeof order_id !== "string" || !order_id) {
    return jsonResponse(
      { success: false, error: "invalid_inputs", detail: "order_id_required" },
      400
    );
  }

  // Timing input: require EXACTLY ONE of pickup_ready_dt (absolute ISO —
  // book-at-accept for scheduled orders) or pickup_ready_minutes (relative —
  // ASAP). The minutes branch below is unchanged from before; the dt branch is
  // purely additive.
  const hasPickupDt =
    pickup_ready_dt !== undefined && pickup_ready_dt !== null;
  const hasPickupMinutes =
    pickup_ready_minutes !== undefined && pickup_ready_minutes !== null;

  if (hasPickupDt === hasPickupMinutes) {
    // Both supplied, or neither.
    return jsonResponse(
      {
        success: false,
        error: "invalid_inputs",
        detail: "exactly_one_pickup_timing",
      },
      400
    );
  }

  if (hasPickupDt) {
    const parsedDt =
      typeof pickup_ready_dt === "string" ? Date.parse(pickup_ready_dt) : NaN;
    if (Number.isNaN(parsedDt) || parsedDt <= Date.now()) {
      return jsonResponse(
        {
          success: false,
          error: "invalid_inputs",
          detail: "pickup_ready_dt_invalid",
        },
        400
      );
    }
  } else if (
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

  // -------- Delegate to shared core --------
  // All Uber business logic (fulfillment-mode check, idempotency, quote
  // resolve/refresh, price guard, manifest, POST, DB write) lives in
  // _shared/uberCreateDelivery.ts so stripe-webhook can reuse it in-process
  // for scheduled-order booking (step 2). The handler owns transport only:
  // auth, input validation, order/restaurant fetch + ownership. The ASAP/
  // tablet path passes relative minutes and transitions to 'in_progress',
  // exactly as before — the helper's { status, body } is relayed verbatim.
  const result = await createUberDelivery(
    supabase,
    order,
    restaurant,
    hasPickupDt
      ? {
          pickupReadyDt: pickup_ready_dt,
          pickupDeadlineMinutes: pickup_deadline_minutes,
          acceptedQuoteId: accepted_quote_id,
          postWriteStatus: "scheduled",
        }
      : {
          pickupReadyMinutes: pickup_ready_minutes,
          pickupDeadlineMinutes: pickup_deadline_minutes,
          acceptedQuoteId: accepted_quote_id,
          postWriteStatus: "in_progress",
        }
  );
  return jsonResponse(result.body, result.status);
});
