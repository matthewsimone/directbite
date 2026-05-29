// ============================================================================
// uber-token — Verify Uber Direct credentials + mint OAuth token
// ============================================================================
//
// Milestone 3 of the Uber Direct integration. First post-M1 edge function
// deployment.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Handler validates auth manually, matching admin-refund's pattern.
// Accepts:
//   - Tablet user JWT only (validated via supabase.auth.getUser; user must
//     own the requested restaurant by tablet_email match)
//   Internal callers in M5+ should import _shared/uberToken.ts directly
//   rather than calling this HTTP endpoint.
//
// Flow:
//   1. CORS preflight + method check
//   2. Parse body: { restaurant_id: string }
//   3. Authorize (tablet user owns the requested restaurant)
//   4. Verify by minting an OAuth token via getUberToken(). A successful
//      mint is treated as proof Uber accepted the credentials.
//   5. Sanity-check uber_customer_id is set (needed by downstream
//      uber-quote URL construction; not enforced by getUberToken).
//   6. Stamp restaurants.uber_credentials_verified_at
//   7. Return { success: true, verified_at, organization_name: null }
//
// Originally M3 included a "Step 2" Get Organization Details call (GET
// /v1/customers/{uber_customer_id}) to confirm the merchant was active.
// That URL returned 404 in production — the endpoint doesn't exist in
// Uber's public API. The original M3 code itself flagged the path as
// best-guess. Removed; the implicit revocation check via token mint
// covers the same case (revoked merchant → 401 on the next token mint →
// getUberToken() auto-clears uber_credentials_verified_at). Downstream
// uber-quote then falls back to in_house mode silently. TODO: if Uber
// ever publishes a working merchant-status GET endpoint, re-add the
// active-merchant check between the customer_id guard and the stamp.
//
// All Uber-side failures return HTTP 200 with success=false and a
// structured error reason, so the tablet UI can show specific messages.
// Auth and request-shape failures return 4xx because those mean the
// caller did something wrong.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "../_shared/uberToken.ts";

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
  let body: { restaurant_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400);
  }

  const restaurantId = body?.restaurant_id;
  if (typeof restaurantId !== "string" || !restaurantId) {
    return jsonResponse({ error: "restaurant_id_required" }, 400);
  }

  // -------- Authorize --------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "missing_auth" }, 401);
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // Tablet user JWT — must own the requested restaurant
  const { data: { user }, error: authErr } = await supabase.auth.getUser(
    token
  );
  if (authErr || !user || !user.email) {
    return jsonResponse({ error: "invalid_auth" }, 401);
  }

  const { data: ownsRow, error: ownsErr } = await supabase
    .from("restaurants")
    .select("id")
    .eq("id", restaurantId)
    .eq("tablet_email", user.email)
    .maybeSingle();

  if (ownsErr) {
    console.error("[uber-token] ownership check failed", ownsErr);
    return jsonResponse({ error: "auth_check_failed" }, 500);
  }
  if (!ownsRow) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  // Past this point, caller is authorized

  // -------- Step 1: mint or cache token --------
  const tokenResult = await getUberToken(supabase, restaurantId);

  if (!tokenResult.success) {
    // Uber-side failure — surface as 200 + structured error so the UI
    // can render the right message. The auth call to OUR function
    // succeeded, so HTTP 401 would be misleading.
    return jsonResponse({
      success: false,
      step: "mint_token",
      error: tokenResult.error,
      detail: tokenResult.detail,
      retry_after: tokenResult.retry_after,
      status: tokenResult.status,
    });
  }

  // -------- Credentials sanity check --------
  // getUberToken() validates uber_client_id + uber_client_secret but does
  // NOT check uber_customer_id (it's not needed for OAuth, only for
  // subsequent quote / delivery API calls). Guard here so we don't stamp
  // verified_at on a half-configured restaurant; downstream uber-quote
  // would fail at URL construction without it.
  const { data: restaurant, error: restReadErr } = await supabase
    .from("restaurants")
    .select("uber_customer_id")
    .eq("id", restaurantId)
    .single();

  if (restReadErr || !restaurant?.uber_customer_id) {
    return jsonResponse({
      success: false,
      step: "verify_org",
      error: "missing_customer_id",
    });
  }

  // -------- Stamp verified_at --------
  // Successful token mint above is treated as proof Uber accepted the
  // credentials. The original M3 "Get Organization Details" call was
  // removed (see file header) because GET /v1/customers/{id} returned
  // 404 — the endpoint doesn't exist in Uber's public API. Implicit
  // revocation handling remains: if a merchant is revoked, getUberToken()
  // gets a 401 on its next mint, clears uber_credentials_verified_at,
  // and downstream uber-quote falls back to in_house silently.
  //
  // TODO: if Uber ever publishes a working merchant-status GET endpoint,
  // re-add the explicit active-merchant check between the customer_id
  // guard above and the stamp below. The original M3 implementation
  // (visible in git history around commit f99facd) shows the previous
  // structure to copy back in.
  const verifiedAt = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("restaurants")
    .update({ uber_credentials_verified_at: verifiedAt })
    .eq("id", restaurantId);

  if (stampErr) {
    console.error("[uber-token] stamp verified_at failed", stampErr);
    // Token mint succeeded; only the DB stamp failed. Surface as
    // success=true but warn so the UI can show "verified, but the
    // timestamp didn't persist — try again."
    return jsonResponse({
      success: true,
      verified_at: null,
      organization_name: null,
      warning: "verified_at_stamp_failed",
      token_from_cache: tokenResult.from_cache,
    });
  }

  return jsonResponse({
    success: true,
    verified_at: verifiedAt,
    organization_name: null,
    token_from_cache: tokenResult.from_cache,
  });
});
