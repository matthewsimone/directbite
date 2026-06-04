// ============================================================================
// Uber Direct OAuth token mint + cache library
// ============================================================================
//
// Single source of truth for fetching a valid Uber Direct OAuth token for a
// given restaurant. Used by:
//   - supabase/functions/uber-token/index.ts (verify-credentials handler)
//   - future M5+ functions (uber-quote, uber-create-delivery, etc.)
//
// Strategy:
//   1. Try uber_oauth_tokens cache (PK = restaurant_id, one row per rest).
//      If row exists and expires_at > now() + 60s buffer → return cached.
//   2. Otherwise: read uber_client_id + uber_client_secret from restaurants
//      row, POST to Uber auth URL, upsert cached row, return fresh token.
//   3. On 401 from Uber: clear cache row AND clear
//      restaurants.uber_credentials_verified_at (forces re-verify in UI).
//   4. On 429: surface retry_after; do NOT retry in-function (function
//      timeout risk; caller decides).
//   5. On 5xx or network failure: surface uber_unavailable; caller decides.
//
// Result is a discriminated union; callers branch on `success`.
// ============================================================================

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import {
  getUberAuthUrl,
  UBER_OAUTH_SCOPE,
  UBER_GRANT_TYPE,
  UberEnvironment,
} from "./uberConfig.ts";
import { logUber } from "./uberLog.ts";

const TOKEN_BUFFER_SECONDS = 60;

export type UberTokenResult =
  | {
      success: true;
      access_token: string;
      expires_at: string; // ISO timestamp
      from_cache: boolean;
    }
  | {
      success: false;
      error:
        | "credentials_not_set"
        | "invalid_credentials"
        | "rate_limited"
        | "uber_unavailable"
        | "db_error";
      detail?: string;
      status?: number;
      retry_after?: number; // seconds, only set when error === 'rate_limited'
    };

export async function getUberToken(
  supabase: SupabaseClient,
  restaurantId: string
): Promise<UberTokenResult> {
  // 1. Check cache
  const { data: cached, error: cacheReadErr } = await supabase
    .from("uber_oauth_tokens")
    .select("access_token, expires_at")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (cacheReadErr) {
    return { success: false, error: "db_error", detail: cacheReadErr.message };
  }

  if (cached) {
    const expiresAtMs = new Date(cached.expires_at).getTime();
    if (expiresAtMs > Date.now() + TOKEN_BUFFER_SECONDS * 1000) {
      return {
        success: true,
        access_token: cached.access_token,
        expires_at: cached.expires_at,
        from_cache: true,
      };
    }
    // Cache stale — fall through to mint. The expired row will be
    // overwritten by the upsert below.
  }

  // 2. Read per-restaurant credentials + environment
  const { data: restaurant, error: restReadErr } = await supabase
    .from("restaurants")
    .select("uber_client_id, uber_client_secret, uber_environment")
    .eq("id", restaurantId)
    .single();

  if (restReadErr) {
    return { success: false, error: "db_error", detail: restReadErr.message };
  }

  if (!restaurant.uber_client_id || !restaurant.uber_client_secret) {
    return { success: false, error: "credentials_not_set" };
  }

  // 3. Mint from Uber
  const authUrl = getUberAuthUrl(
    (restaurant.uber_environment as UberEnvironment | null) ?? "production"
  );

  const body = new URLSearchParams({
    client_id: restaurant.uber_client_id,
    client_secret: restaurant.uber_client_secret,
    grant_type: UBER_GRANT_TYPE,
    scope: UBER_OAUTH_SCOPE,
  });

  let mintResp: Response;
  const t0 = Date.now();
  try {
    mintResp = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    logUber({
      fn: "getUberToken",
      event: "token_mint",
      restaurant_id: restaurantId,
      outcome: "network_error",
      ms: Date.now() - t0,
    });
    return {
      success: false,
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    };
  }
  logUber({
    fn: "getUberToken",
    event: "token_mint",
    restaurant_id: restaurantId,
    uber_http_status: mintResp.status,
    outcome: mintResp.ok ? "ok" : "http_error",
    ms: Date.now() - t0,
  });

  if (mintResp.status === 401) {
    // Credentials revoked or wrong. Clear cache + verified_at so UI
    // re-prompts the operator to re-verify.
    await supabase
      .from("uber_oauth_tokens")
      .delete()
      .eq("restaurant_id", restaurantId);
    await supabase
      .from("restaurants")
      .update({ uber_credentials_verified_at: null })
      .eq("id", restaurantId);
    return { success: false, error: "invalid_credentials", status: 401 };
  }

  if (mintResp.status === 429) {
    const retryAfter = Number(mintResp.headers.get("retry-after")) || 60;
    return { success: false, error: "rate_limited", retry_after: retryAfter };
  }

  if (!mintResp.ok) {
    let bodyText = "";
    try {
      bodyText = (await mintResp.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    return {
      success: false,
      error: "uber_unavailable",
      status: mintResp.status,
      detail: bodyText,
    };
  }

  let mintBody: { access_token?: string; expires_in?: number };
  try {
    mintBody = await mintResp.json();
  } catch {
    return {
      success: false,
      error: "uber_unavailable",
      detail: "malformed Uber auth response",
    };
  }

  if (!mintBody.access_token || typeof mintBody.expires_in !== "number") {
    return {
      success: false,
      error: "uber_unavailable",
      detail: "missing access_token or expires_in in Uber auth response",
    };
  }

  // 4. Upsert cache. PK is restaurant_id so this is last-write-wins.
  // Concurrent mints from two callers both succeed; both Uber tokens are
  // valid until their individual expiry (Uber does not auto-revoke older
  // tokens on new mints under the 100/hour limit).
  const expiresAt = new Date(
    Date.now() + mintBody.expires_in * 1000
  ).toISOString();

  const { error: upsertErr } = await supabase
    .from("uber_oauth_tokens")
    .upsert({
      restaurant_id: restaurantId,
      access_token: mintBody.access_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

  if (upsertErr) {
    // Token is good but we couldn't cache it. Surface as db_error so caller
    // knows the next call will pay the mint cost again.
    return { success: false, error: "db_error", detail: upsertErr.message };
  }

  return {
    success: true,
    access_token: mintBody.access_token,
    expires_at: expiresAt,
    from_cache: false,
  };
}
