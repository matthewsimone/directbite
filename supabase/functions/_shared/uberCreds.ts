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
