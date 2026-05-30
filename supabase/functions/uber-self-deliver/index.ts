// ============================================================================
// uber-self-deliver — Cancel the Uber dispatch and self-deliver (no refund)
// ============================================================================
//
// Called from the tablet when an operator taps "Deliver Yourself" on a stuck
// uber_direct order (no courier found yet). Releases the Uber delivery via the
// shared cancel lib, then transitions the order to 'self_delivering' so the
// restaurant fulfills it with their own driver.
//
// Distinct from admin-refund (Cancel & Refund): this path does NOT refund the
// customer. The customer paid for delivery and is still getting it — just from
// the restaurant instead of Uber. The restaurant keeps the delivery fee; Uber
// charges $0 because the cancel happens at 'pending' (no courier assigned yet).
//
// Flow:
//   1. CORS preflight + POST-only.
//   2. Parse { order_id }.
//   3. Authorize tablet user (Bearer JWT → email → restaurants.tablet_email),
//      mirroring uber-create-delivery.
//   4. Fetch order + restaurant (FK join).
//   5. cancelUberDelivery(): release the Uber delivery.
//      - On failure → return the error, make NO status change (spec: abort).
//      - On success (incl. already-canceled / never-dispatched short-circuits)
//        → UPDATE orders SET status='self_delivering',
//          cancelled_by='restaurant_self_deliver'.
//   6. Return { success: true }.
//
// JWT setting: verify_jwt = false (declared in config.toml). Handler validates
// auth manually. All DB access via SUPABASE_SERVICE_ROLE_KEY.
//
// Risk to in_house restaurants: none — gated on uber_direct via the cancel lib
// and the order's own state; in_house orders never reach this function.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { cancelUberDelivery } from "../_shared/uberCancel.ts";

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
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id, status, delivery_fulfillment_method, uber_status, uber_delivery_id,
      restaurant_id,
      restaurants:restaurant_id (
        id, uber_customer_id, uber_environment, tablet_email
      )
    `)
    .eq("id", order_id)
    .maybeSingle();

  if (orderErr) {
    console.error("[uber-self-deliver] order fetch failed", orderErr);
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
    return jsonResponse({ success: false, error: "restaurant_not_found" }, 404);
  }
  if (restaurant.tablet_email !== user.email) {
    return jsonResponse({ success: false, error: "forbidden" }, 403);
  }
  // Past this point, caller is authorized.

  // -------- Release the Uber delivery --------
  // cancelUberDelivery handles the pending → Uber /cancel call ($0 fee at
  // pending), and short-circuits success if the order was never dispatched or
  // is already canceled. It sets uber_status='canceled' on success.
  const cancel = await cancelUberDelivery(supabase, order, restaurant);
  if (!cancel.success) {
    // Spec: abort, no status change. Surface the error so the tablet can tell
    // the operator the Uber delivery couldn't be released.
    return jsonResponse({
      success: false,
      error: cancel.error,
      detail: cancel.detail,
    });
  }

  // -------- Transition to self-delivering (NO refund) --------
  const { error: updateErr } = await supabase
    .from("orders")
    .update({
      status: "self_delivering",
      cancelled_by: "restaurant_self_deliver",
    })
    .eq("id", order_id);

  if (updateErr) {
    console.error("[uber-self-deliver] orders update failed", {
      order_id,
      error: updateErr.message,
    });
    return jsonResponse(
      { success: false, error: "db_error", detail: updateErr.message },
      500
    );
  }

  console.log("[uber-self-deliver] order set to self_delivering", { order_id });
  return jsonResponse({ success: true });
});
