// ============================================================================
// uber-quote — Resolve fulfillment mode + fetch Uber Direct quote
// ============================================================================
//
// Milestone 5a of the Uber Direct integration. Called from CheckoutPage
// when a delivery address resolves. Single responsibility: tell the
// customer's checkout flow which fulfillment mode applies and (if Uber)
// what the customer-facing delivery fee should be.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Anonymous customer auth pattern, identical to create-payment-intent:
//   - Authorization: Bearer ${supabaseAnonKey}
//   - No handler-side auth check — Supabase platform validates the anon
//     key at the gateway layer
//   - All DB access via SUPABASE_SERVICE_ROLE_KEY (bypasses RLS)
//
// Flow:
//   1. CORS preflight + method check
//   2. Parse and validate body
//   3. Fetch restaurant row (single select, service-role)
//   4. resolveMode() from _shared/uberMode.ts
//   5. If resolved 'in_house' → short-circuit return; checkout uses
//      existing haversine fee
//   6. If resolved 'uber_direct':
//      a. getUberToken() — mint or cache via _shared/uberToken.ts
//      b. POST to Uber's delivery_quotes endpoint
//      c. Parse response: extract quote_id, fee, expires_at, dropoff_eta
//      d. Apply passthrough policy → customer_cents, restaurant_cents
//      e. Return structured success
//   7. Any Uber-side failure → structured error with HTTP 200 + success: false
//
// CheckoutPage caller pattern (M5c, not in this milestone):
//   - On address validation, call this endpoint
//   - On success: store uber_quote_id, customer_delivery_fee, expires_at
//   - On in_house resolution: use existing haversine
//   - On error: display generic "Delivery unavailable" per D7 decision
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "../_shared/uberToken.ts";
import { getUberApiBase, UberEnvironment } from "../_shared/uberConfig.ts";
import { resolveMode, RestaurantForMode } from "../_shared/uberMode.ts";

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

/**
 * Apply passthrough policy to convert Uber's quoted fee into customer-paid
 * and restaurant-absorbed portions. All values in integer cents to avoid
 * float drift; the caller is responsible for cents → dollars conversion.
 *
 * Defensive: unknown mode value falls back to customer_full (customer pays
 * all). Negative passthrough_value clamped to 0.
 */
function applyPassthrough(
  uberFeeCents: number,
  mode: string,
  value: number
): { customer_cents: number; restaurant_cents: number } {
  const v = Math.max(0, Number(value) || 0);

  switch (mode) {
    case "customer_full":
      return { customer_cents: uberFeeCents, restaurant_cents: 0 };

    case "split": {
      // value is percentage 0-100 representing customer's share
      const customerPct = Math.min(100, v) / 100;
      const customer = Math.round(uberFeeCents * customerPct);
      return { customer_cents: customer, restaurant_cents: uberFeeCents - customer };
    }

    case "restaurant_cap": {
      // value is dollars cap on what restaurant absorbs
      const capCents = Math.round(v * 100);
      const restaurant = Math.min(uberFeeCents, capCents);
      return { customer_cents: uberFeeCents - restaurant, restaurant_cents: restaurant };
    }

    case "customer_cap": {
      // value is dollars cap on what customer pays
      const capCents = Math.round(v * 100);
      const customer = Math.min(uberFeeCents, capCents);
      return { customer_cents: customer, restaurant_cents: uberFeeCents - customer };
    }

    case "restaurant_full":
      return { customer_cents: 0, restaurant_cents: uberFeeCents };

    default:
      console.warn(`[uber-quote] unknown passthrough mode: ${mode}; defaulting to customer_full`);
      return { customer_cents: uberFeeCents, restaurant_cents: 0 };
  }
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
    restaurant_id,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
    dropoff_phone,
    // cart_subtotal_cents accepted but unused in M5a — accepted for forward
    // compat (future: validate against delivery minimum server-side)
  } = body || {};

  if (typeof restaurant_id !== "string" || !restaurant_id) {
    return jsonResponse({ success: false, error: "invalid_inputs", detail: "restaurant_id_required" });
  }

  // -------- Fetch restaurant (mode resolution + Uber metadata) --------
  const { data: restaurant, error: restErr } = await supabase
    .from("restaurants")
    .select(
      `id, name, latitude, longitude, address, phone,
       delivery_fulfillment, uber_credentials_verified_at,
       uber_direct_active, uber_schedule,
       uber_passthrough_mode, uber_passthrough_value,
       uber_customer_id, uber_environment`
    )
    .eq("id", restaurant_id)
    .single();

  if (restErr || !restaurant) {
    console.error("[uber-quote] restaurant fetch failed", restErr);
    return jsonResponse({ success: false, error: "restaurant_not_found" });
  }

  // -------- Mode resolution --------
  const resolution = resolveMode(restaurant as RestaurantForMode);

  // Short-circuit: in_house. No Uber call needed; checkout uses haversine.
  if (resolution.resolved_mode === "in_house") {
    return jsonResponse({
      success: true,
      resolved_mode: "in_house",
      requires_quote: false,
      reason: resolution.reason,
    });
  }

  // -------- Uber path: validate dropoff inputs --------
  if (typeof dropoff_lat !== "number" || typeof dropoff_lng !== "number") {
    return jsonResponse({ success: false, error: "invalid_inputs", detail: "dropoff_lat_lng_required" });
  }
  if (typeof dropoff_address !== "string" || !dropoff_address) {
    return jsonResponse({ success: false, error: "invalid_inputs", detail: "dropoff_address_required" });
  }

  // -------- Mint or fetch cached Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant_id);
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

  // -------- Construct + send Uber quote request --------
  // NOTE: Uber's exact request/response shapes are best-guess based on Uber
  // Direct API patterns. Field names (pickup_address structure, fee unit,
  // expires field name, id field name) should be verified against sandbox
  // responses during initial smoke testing and adjusted if necessary.
  const env = (restaurant.uber_environment as UberEnvironment | null) ?? "production";
  const apiBase = getUberApiBase(env);
  const quoteUrl = `${apiBase}/v1/customers/${restaurant.uber_customer_id}/delivery_quotes`;

  const quotePayload = {
    pickup_address: JSON.stringify({
      street_address: [restaurant.address || ""],
      country: "US",
    }),
    pickup_latitude: Number(restaurant.latitude),
    pickup_longitude: Number(restaurant.longitude),
    pickup_phone_number: restaurant.phone || "",
    dropoff_address: JSON.stringify({
      street_address: [dropoff_address],
      country: "US",
    }),
    dropoff_latitude: dropoff_lat,
    dropoff_longitude: dropoff_lng,
    dropoff_phone_number: dropoff_phone || "",
  };

  let quoteResp: Response;
  try {
    quoteResp = await fetch(quoteUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(quotePayload),
    });
  } catch (err) {
    console.error("[uber-quote] network failure to Uber", err);
    return jsonResponse({
      success: false,
      step: "quote",
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    });
  }

  if (quoteResp.status === 429) {
    const retryAfter = Number(quoteResp.headers.get("retry-after")) || 60;
    return jsonResponse({
      success: false,
      step: "quote",
      error: "rate_limited",
      retry_after: retryAfter,
    });
  }

  // 400 typically = invalid address / out of zone. 404 = customer not found.
  if (quoteResp.status === 400 || quoteResp.status === 404) {
    let detail = "";
    try {
      detail = (await quoteResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return jsonResponse({
      success: false,
      step: "quote",
      error: "delivery_unavailable",
      status: quoteResp.status,
      detail,
    });
  }

  if (!quoteResp.ok) {
    let detail = "";
    try {
      detail = (await quoteResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return jsonResponse({
      success: false,
      step: "quote",
      error: "uber_unavailable",
      status: quoteResp.status,
      detail,
    });
  }

  let quoteBody: any;
  try {
    quoteBody = await quoteResp.json();
  } catch {
    return jsonResponse({
      success: false,
      step: "quote",
      error: "uber_unavailable",
      detail: "malformed Uber quote response",
    });
  }

  // Field extraction — guesses, refine during sandbox testing if needed
  const uberQuoteId: string | undefined = quoteBody.id || quoteBody.quote_id;
  const uberFeeCents: number | undefined = quoteBody.fee; // Uber convention: integer cents
  const expiresAt: string | undefined = quoteBody.expires;
  const dropoffEta: string | undefined = quoteBody.dropoff_eta;

  if (!uberQuoteId || typeof uberFeeCents !== "number") {
    console.error("[uber-quote] missing required fields in Uber response", quoteBody);
    return jsonResponse({
      success: false,
      step: "quote",
      error: "uber_unavailable",
      detail: "missing required fields in Uber response (id, fee)",
    });
  }

  // -------- Apply passthrough policy --------
  const { customer_cents, restaurant_cents } = applyPassthrough(
    uberFeeCents,
    restaurant.uber_passthrough_mode,
    Number(restaurant.uber_passthrough_value || 0)
  );

  // -------- Success --------
  return jsonResponse({
    success: true,
    resolved_mode: "uber_direct",
    requires_quote: true,
    reason: resolution.reason,
    uber_quote_id: uberQuoteId,
    uber_quoted_fee_cents: uberFeeCents,
    customer_delivery_fee_cents: customer_cents,
    restaurant_absorbs_cents: restaurant_cents,
    expires_at: expiresAt || null,
    dropoff_eta: dropoffEta || null,
    uber_environment: env,
  });
});
