// ============================================================================
// uber-get-delivery — Read current Uber Direct delivery state (M9d)
// ============================================================================
//
// Milestone 9d of the Uber Direct integration. Called from the tablet
// OrdersTab the moment an operator taps "Cancel & Refund Order", BEFORE the
// confirmation modal is shown. Fetches the live delivery state from Uber so
// the modal can tell the operator — in plain language — whether cancelling
// will incur an Uber cancellation fee (which DirectBite/the restaurant
// absorbs) or, worse, is no longer possible because the courier has the food.
//
// This function is READ-ONLY. It does NOT cancel anything, does NOT refund,
// and writes nothing to the database. The actual cancel+refund cascade
// remains M9c's admin-refund → uberCancel.ts path, fired only if the operator
// confirms. M9d is purely an informational pre-step.
//
// Why no cancellation-fee number (M9d D1/D2): Uber's GET delivery response
// (the Delivery object) exposes `fee` = the DELIVERY fee, not a
// cancellation-specific charge. There is no documented "cancellation fee
// estimate" field, and the real cancel cost is policy/state-derived (no
// courier → free; during pickup → a pickup fee; during delivery → a fee).
// So we do NOT return a dollar figure. We return the delivery STATE
// (uber_status + whether a courier is assigned) and the tablet maps that to
// policy-derived messaging. Honest UX over a fabricated number.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Handler validates auth manually, matching uber-create-delivery:
//   - Authorization: Bearer <tablet user JWT>
//   - getUser() → email; restaurants.tablet_email must match
// All DB access via SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
//
// Flow:
//   1. CORS preflight + POST-only.
//   2. Parse body: { order_id }.
//   3. Authorize tablet user (Bearer JWT → email).
//   4. Fetch order + restaurant (FK join), verify tablet_email ownership.
//   5. Short-circuit: non-uber_direct OR no uber_delivery_id → there is no
//      live Uber delivery to inspect → { success: true, dispatched: false,
//      uber_status: null }. The tablet treats this as "regular refund, no
//      Uber fee" — identical to the in_house path.
//   6. Mint/fetch Uber OAuth token (getUberToken).
//   7. GET /v1/customers/{customer_id}/deliveries/{delivery_id}.
//   8. Parse: uber_status (status), courier_assigned (courier present &&
//      not unassigned), dropoff_eta. Best-effort — a malformed body still
//      yields a graceful response so the operator is never blocked from
//      cancelling.
//   9. Return { success: true, dispatched: true, uber_status,
//      courier_assigned, dropoff_eta }.
//
// Error response shapes (all HTTP 200 unless noted):
//   - { success: false, error: 'invalid_body' }                       [400]
//   - { success: false, error: 'invalid_inputs', detail }             [400]
//   - { success: false, error: 'missing_auth' | 'invalid_auth' }      [401]
//   - { success: false, error: 'forbidden' }                          [403]
//   - { success: false, error: 'order_not_found' |
//       'restaurant_not_found' }                                      [404]
//   - { success: false, error: 'db_error', detail }                   [500]
//   - { success: false, error: <token error> }                        [200]
//   - { success: false, error: 'uber_unavailable', status?, detail }  [200]
//   - { success: true, dispatched: false, uber_status: null }         [200]
//   - { success: true, dispatched: true, uber_status, courier_assigned,
//       dropoff_eta }                                                 [200]
//
// Graceful degradation: the tablet is built to proceed even when this call
// fails (it shows "Couldn't fetch current delivery state. Proceed anyway?").
// So a failure here NEVER blocks a cancel+refund — it just degrades the
// pre-cancel messaging. That informs the defensive parsing below.
//
// Risk to 8 production restaurants (all in_house): zero. Step 5 short-
// circuits any non-uber_direct order before a single Uber call. Read-only;
// no writes regardless of path.
//
// Spelling note: uber_status uses Uber's 'canceled' (one L), distinct from
// orders.status 'cancelled' (two L's). This file only reads uber_status.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "../_shared/uberToken.ts";
import { getUberApiBase } from "../_shared/uberConfig.ts";
import { resolveUberCreds } from "../_shared/uberCreds.ts";

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
    return jsonResponse({ success: false, error: "method_not_allowed" }, 405);
  }

  // -------- Parse body --------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "invalid_body" }, 400);
  }

  const { order_id } = body || {};
  if (typeof order_id !== "string" || !order_id) {
    return jsonResponse(
      { success: false, error: "invalid_inputs", detail: "order_id_required" },
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
  // restaurants.tablet_email match (same pattern as uber-create-delivery).
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id, delivery_fulfillment_method, uber_delivery_id, uber_status,
      restaurant_id,
      restaurants:restaurant_id (
        id, uber_customer_id, uber_environment, uber_billing_mode, tablet_email
      )
    `)
    .eq("id", order_id)
    .maybeSingle();

  if (orderErr) {
    console.error("[uber-get-delivery] order fetch failed", orderErr);
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
    console.error("[uber-get-delivery] restaurant join failed", { order_id });
    return jsonResponse(
      { success: false, error: "restaurant_not_found" },
      404
    );
  }

  if (restaurant.tablet_email !== user.email) {
    return jsonResponse({ success: false, error: "forbidden" }, 403);
  }
  // Past this point, caller is authorized.

  // -------- Short-circuit: nothing dispatched to inspect --------
  // Non-uber_direct orders never touch Uber. uber_direct orders that haven't
  // been dispatched yet (status 'new', no uber_delivery_id) have no live
  // delivery either. In both cases there is no Uber cancellation fee — the
  // cancel is a plain Stripe refund — so we tell the tablet dispatched:false
  // and it shows the regular confirmation copy.
  if (
    order.delivery_fulfillment_method !== "uber_direct" ||
    !order.uber_delivery_id
  ) {
    return jsonResponse({
      success: true,
      dispatched: false,
      uber_status: null,
    });
  }

  // -------- Mint or fetch Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant.id);
  if (!tokenResult.success) {
    console.error("[uber-get-delivery] token mint failed", {
      order_id,
      error: tokenResult.error,
    });
    return jsonResponse({
      success: false,
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    });
  }

  // -------- GET the delivery from Uber --------
  // Resolve creds via billing mode so platform restaurants use the DirectBite account customer_id + env.
  const credsResult = resolveUberCreds(restaurant);
  if (!credsResult.success) {
    console.error("[uber-get-delivery] creds resolution failed", credsResult.error, credsResult.detail);
    return jsonResponse({ success: false, error: credsResult.error }, 400);
  }
  const apiBase = getUberApiBase(credsResult.creds.environment);
  const getUrl =
    `${apiBase}/v1/customers/${credsResult.creds.customer_id}` +
    `/deliveries/${order.uber_delivery_id}`;

  let getResp: Response;
  try {
    getResp = await fetch(getUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("[uber-get-delivery] network failure to Uber", {
      order_id,
      err: String(err),
    });
    return jsonResponse({
      success: false,
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    });
  }

  if (getResp.status === 429) {
    const retryAfter = Number(getResp.headers.get("retry-after")) || 60;
    return jsonResponse({
      success: false,
      error: "rate_limited",
      retry_after: retryAfter,
    });
  }

  if (!getResp.ok) {
    let detail = "";
    try {
      detail = (await getResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    console.error("[uber-get-delivery] Uber GET failed", {
      order_id,
      delivery_id: order.uber_delivery_id,
      status: getResp.status,
      detail,
    });
    return jsonResponse({
      success: false,
      error: "uber_unavailable",
      status: getResp.status,
      detail,
    });
  }

  // -------- Parse delivery state (best-effort) --------
  // A malformed body should NOT block the operator from cancelling — fall
  // back to a usable response. The tablet degrades to "Couldn't fetch current
  // delivery state. Proceed anyway?" when uber_status is null.
  let deliveryBody: any;
  try {
    deliveryBody = await getResp.json();
  } catch {
    console.warn("[uber-get-delivery] malformed delivery body — degrading", {
      order_id,
    });
    return jsonResponse({
      success: true,
      dispatched: true,
      uber_status: null,
      courier_assigned: false,
      dropoff_eta: null,
    });
  }

  const uberStatus: string | null =
    typeof deliveryBody?.status === "string" ? deliveryBody.status : null;

  // courier_assigned: Uber populates a `courier` object once a Delivery
  // Partner accepts. Treat a present, non-empty courier object as assigned.
  // This is what flips the tablet from "no fee" to "fee may apply" messaging.
  const courier = deliveryBody?.courier;
  const courierAssigned =
    !!courier && typeof courier === "object" && Object.keys(courier).length > 0;

  const dropoffEta: string | null =
    typeof deliveryBody?.dropoff_eta === "string"
      ? deliveryBody.dropoff_eta
      : null;

  return jsonResponse({
    success: true,
    dispatched: true,
    uber_status: uberStatus,
    courier_assigned: courierAssigned,
    dropoff_eta: dropoffEta,
  });
});
