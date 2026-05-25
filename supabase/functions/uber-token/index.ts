// ============================================================================
// uber-token — Verify Uber Direct credentials + mint OAuth token
// ============================================================================
//
// Milestone 3 of the Uber Direct integration. First post-M1 edge function
// deployment.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Handler validates auth manually, matching admin-refund's pattern.
// Accepts EITHER:
//   - Tablet user JWT (validated via supabase.auth.getUser; user must own
//     the requested restaurant by tablet_email match)
//   - SUPABASE_SERVICE_ROLE_KEY in Authorization header (for future
//     internal callers — uber-quote etc. though those will primarily
//     import _shared/uberToken.ts directly)
//
// Flow:
//   1. CORS preflight + method check
//   2. Parse body: { restaurant_id: string }
//   3. Authorize (service-role match OR tablet-user-owns-restaurant)
//   4. Step 1 of D6 verify: getUberToken() — mint or cache
//   5. Step 2 of D6 verify: GET /v1/customers/{uber_customer_id} — confirm
//      merchant active (any 200 = active per D3 decision)
//   6. Stamp restaurants.uber_credentials_verified_at
//   7. Return { success: true, verified_at, organization_name? }
//
// All Uber-side failures return HTTP 200 with success=false and a
// structured error reason, so the tablet UI can show specific messages.
// Auth and request-shape failures return 4xx because those mean the
// caller did something wrong.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "../_shared/uberToken.ts";
import {
  getUberApiBase,
  UberEnvironment,
} from "../_shared/uberConfig.ts";

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

  // Path A: service-role caller
  let authorized = false;
  if (token === SERVICE_ROLE_KEY) {
    authorized = true;
  } else {
    // Path B: tablet user JWT — must own the requested restaurant
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
    authorized = true;
  }

  if (!authorized) {
    // Defensive — should be unreachable
    return jsonResponse({ error: "forbidden" }, 403);
  }

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

  // -------- Step 2: D6 two-step verify (Get Organization Details) --------
  // ALWAYS run this even on cache hit. The cached token might be valid by
  // Uber's expiry clock but the merchant could have been revoked since
  // the token was minted — that's exactly the situation the Verify
  // Credentials button exists to catch.
  const { data: restaurant, error: restReadErr } = await supabase
    .from("restaurants")
    .select("uber_customer_id, uber_environment")
    .eq("id", restaurantId)
    .single();

  if (restReadErr || !restaurant?.uber_customer_id) {
    return jsonResponse({
      success: false,
      step: "verify_org",
      error: "missing_customer_id",
    });
  }

  const apiBase = getUberApiBase(
    (restaurant.uber_environment as UberEnvironment | null) ?? "production"
  );
  // Field name from Uber docs is best-guess; confirm against sandbox during
  // M4 testing and update if Uber returns a different path / response shape.
  const orgUrl = `${apiBase}/v1/customers/${restaurant.uber_customer_id}`;

  let orgResp: Response;
  try {
    orgResp = await fetch(orgUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    return jsonResponse({
      success: false,
      step: "verify_org",
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    });
  }

  if (orgResp.status === 401) {
    // Token was just minted but Uber rejects it — credentials likely
    // revoked between mint and use. Clear cache + verified_at.
    await supabase
      .from("uber_oauth_tokens")
      .delete()
      .eq("restaurant_id", restaurantId);
    await supabase
      .from("restaurants")
      .update({ uber_credentials_verified_at: null })
      .eq("id", restaurantId);
    return jsonResponse({
      success: false,
      step: "verify_org",
      error: "invalid_credentials",
      status: 401,
    });
  }

  if (!orgResp.ok) {
    let bodyText = "";
    try {
      bodyText = (await orgResp.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    return jsonResponse({
      success: false,
      step: "verify_org",
      error: "uber_unavailable",
      status: orgResp.status,
      detail: bodyText,
    });
  }

  // Any 200 is "merchant active" per D3. Optionally parse body for
  // organization_name display; non-JSON or missing field is still success.
  let orgName: string | null = null;
  try {
    const orgBody = await orgResp.json();
    // Field name guess — refine during M4 sandbox testing.
    orgName =
      orgBody?.name ??
      orgBody?.organization_name ??
      orgBody?.customer_name ??
      null;
  } catch {
    /* non-JSON 200 still succeeds */
  }

  // -------- Stamp verified_at --------
  const verifiedAt = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("restaurants")
    .update({ uber_credentials_verified_at: verifiedAt })
    .eq("id", restaurantId);

  if (stampErr) {
    console.error("[uber-token] stamp verified_at failed", stampErr);
    // Verification succeeded; only the DB stamp failed. Surface as
    // success=true but warn so the UI can show "verified, but the
    // timestamp didn't persist — try again."
    return jsonResponse({
      success: true,
      verified_at: null,
      organization_name: orgName,
      warning: "verified_at_stamp_failed",
      token_from_cache: tokenResult.from_cache,
    });
  }

  return jsonResponse({
    success: true,
    verified_at: verifiedAt,
    organization_name: orgName,
    token_from_cache: tokenResult.from_cache,
  });
});
