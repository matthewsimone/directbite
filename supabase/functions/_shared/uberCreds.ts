// _shared/uberCreds.ts
// Phase 1 platform-billing: resolves which Uber Direct credentials a restaurant uses.
//
//   uber_billing_mode === 'platform' -> the single DirectBite account creds (env vars), env forced 'production'
//   otherwise ('self' / null / anything) -> the restaurant's OWN row creds (byte-identical to pre-Phase-1 behavior)
//
// Pure function: takes an already-fetched restaurant row, returns creds. No DB calls.
// Callers must include `uber_billing_mode` in the row they pass.

export type UberEnvironment = "sandbox" | "production";

export interface ResolvedUberCreds {
  client_id: string;
  client_secret: string;
  customer_id: string;
  environment: UberEnvironment;
}

// Minimal shape the resolver reads. Real restaurant rows carry more fields; that's fine.
export interface UberCredsRestaurantRow {
  uber_billing_mode?: string | null;
  uber_client_id?: string | null;
  uber_client_secret?: string | null;
  uber_customer_id?: string | null;
  uber_environment?: string | null;
}

export type ResolveUberCredsResult =
  | { success: true; creds: ResolvedUberCreds }
  | {
      success: false;
      error: "platform_creds_not_configured" | "credentials_not_set";
      detail?: string;
    };

export function resolveUberCreds(
  restaurant: UberCredsRestaurantRow,
): ResolveUberCredsResult {
  const mode = restaurant.uber_billing_mode ?? "self";

  if (mode === "platform") {
    const client_id = Deno.env.get("UBER_PLATFORM_CLIENT_ID");
    const client_secret = Deno.env.get("UBER_PLATFORM_CLIENT_SECRET");
    const customer_id = Deno.env.get("UBER_PLATFORM_CUSTOMER_ID");

    const missing: string[] = [];
    if (!client_id) missing.push("UBER_PLATFORM_CLIENT_ID");
    if (!client_secret) missing.push("UBER_PLATFORM_CLIENT_SECRET");
    if (!customer_id) missing.push("UBER_PLATFORM_CUSTOMER_ID");
    if (missing.length > 0) {
      return {
        success: false,
        error: "platform_creds_not_configured",
        detail: `Missing env: ${missing.join(", ")}`,
      };
    }

    // Platform account is production by definition.
    return {
      success: true,
      creds: {
        client_id: client_id!,
        client_secret: client_secret!,
        customer_id: customer_id!,
        environment: "production",
      },
    };
  }

  // Self mode: the restaurant's own credentials (unchanged from pre-Phase-1).
  if (
    !restaurant.uber_client_id ||
    !restaurant.uber_client_secret ||
    !restaurant.uber_customer_id
  ) {
    return {
      success: false,
      error: "credentials_not_set",
      detail: "self mode: restaurant is missing one or more Uber credential fields",
    };
  }

  const env: UberEnvironment =
    restaurant.uber_environment === "sandbox" ? "sandbox" : "production";

  return {
    success: true,
    creds: {
      client_id: restaurant.uber_client_id,
      client_secret: restaurant.uber_client_secret,
      customer_id: restaurant.uber_customer_id,
      environment: env,
    },
  };
}

// ============================================================================
// Strategy B — split resolvers by consumer need.
//
// The resolveUberCreds callers partition into two DISJOINT needs:
//   - token mint (uberToken):                  client_id + client_secret only
//   - URL build (uber-quote / uber-get-delivery / uberCreateDelivery /
//                uberCancel):                   customer_id + environment only
//
// The combined resolver above demands the UNION of both, so a caller whose
// SELECT only fetches the fields it actually uses fails the over-strict gate.
// These split resolvers validate/return only the fields each consumer needs,
// so self mode works without any caller adding columns to its SELECT.
// Platform/self branching semantics are identical to resolveUberCreds.
// ============================================================================

export interface ResolvedTokenCreds {
  client_id: string;
  client_secret: string;
}

export type ResolveTokenCredsResult =
  | { success: true; creds: ResolvedTokenCreds }
  | {
      success: false;
      error: "platform_creds_not_configured" | "credentials_not_set";
      detail?: string;
    };

// Credentials to MINT an Uber OAuth token. OAuth uses only the client
// credentials — customer_id is intentionally NOT required or returned here.
export function resolveTokenCreds(
  restaurant: UberCredsRestaurantRow,
): ResolveTokenCredsResult {
  const mode = restaurant.uber_billing_mode ?? "self";

  if (mode === "platform") {
    const client_id = Deno.env.get("UBER_PLATFORM_CLIENT_ID");
    const client_secret = Deno.env.get("UBER_PLATFORM_CLIENT_SECRET");

    const missing: string[] = [];
    if (!client_id) missing.push("UBER_PLATFORM_CLIENT_ID");
    if (!client_secret) missing.push("UBER_PLATFORM_CLIENT_SECRET");
    if (missing.length > 0) {
      return {
        success: false,
        error: "platform_creds_not_configured",
        detail: `Missing env: ${missing.join(", ")}`,
      };
    }

    return {
      success: true,
      creds: { client_id: client_id!, client_secret: client_secret! },
    };
  }

  // Self mode: the restaurant's own client credentials.
  if (!restaurant.uber_client_id || !restaurant.uber_client_secret) {
    return {
      success: false,
      error: "credentials_not_set",
      detail: "self mode: restaurant is missing uber_client_id or uber_client_secret",
    };
  }

  return {
    success: true,
    creds: {
      client_id: restaurant.uber_client_id,
      client_secret: restaurant.uber_client_secret,
    },
  };
}

export interface ResolvedUrlCreds {
  customer_id: string;
  environment: UberEnvironment;
}

export type ResolveUrlCredsResult =
  | { success: true; creds: ResolvedUrlCreds }
  | {
      success: false;
      error: "platform_creds_not_configured" | "credentials_not_set";
      detail?: string;
    };

// Credentials to BUILD the Uber API URL: customer_id + environment. The OAuth
// token (from resolveTokenCreds via getUberToken) carries auth — the client
// secret is intentionally NOT required or returned here.
export function resolveUrlCreds(
  restaurant: UberCredsRestaurantRow,
): ResolveUrlCredsResult {
  const mode = restaurant.uber_billing_mode ?? "self";

  if (mode === "platform") {
    const customer_id = Deno.env.get("UBER_PLATFORM_CUSTOMER_ID");
    if (!customer_id) {
      return {
        success: false,
        error: "platform_creds_not_configured",
        detail: "Missing env: UBER_PLATFORM_CUSTOMER_ID",
      };
    }
    // Platform account is production by definition.
    return {
      success: true,
      creds: { customer_id, environment: "production" },
    };
  }

  // Self mode: the restaurant's own customer_id + environment.
  if (!restaurant.uber_customer_id) {
    return {
      success: false,
      error: "credentials_not_set",
      detail: "self mode: restaurant is missing uber_customer_id",
    };
  }

  const env: UberEnvironment =
    restaurant.uber_environment === "sandbox" ? "sandbox" : "production";

  return {
    success: true,
    creds: { customer_id: restaurant.uber_customer_id, environment: env },
  };
}
