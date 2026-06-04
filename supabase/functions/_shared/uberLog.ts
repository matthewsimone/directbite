// ============================================================================
// uberLog — one-line structured logging for every Uber Direct interaction
// ============================================================================
//
// Single, additive logging helper shared by the Uber edge functions and
// helpers. Emits exactly one JSON object per call via console.log so logs are
// greppable by fn / event / outcome and carry timing + the routing ids.
//
// PII-SAFE BY CONSTRUCTION: this function accepts ONLY the whitelisted fields
// below. It is intentionally impossible to pass — and therefore impossible to
// log — secrets (client_id/secret, signing secret), access tokens,
// Authorization headers, customer/courier PII, raw Uber payloads, or
// tracking_url. The three id fields (order_id, restaurant_id,
// uber_delivery_id) are internal/Uber identifiers, not personal data.
//
// No new dependencies (console + Date + JSON.stringify are built-in). No
// behavior change at call sites — callers add one logUber() line each.
//
// Field semantics:
//   fn               — the function emitting the line ("getUberToken",
//                      "uber-quote", "createUberDelivery",
//                      "cancelUberDelivery", "uber-webhook")
//   event            — the interaction ("token_mint", "quote", "cancel",
//                      "create_delivery", "webhook_status", ...)
//   uber_http_status — Uber's HTTP response code; null for inbound events or
//                      when no Uber call was made
//   outcome          — "ok" | "http_error" | "network_error" | "rate_limited"
//                      | "skipped" | "db_error"
//   ms               — wall time of the timed Uber call (Date.now() delta);
//                      null where nothing was timed
// ============================================================================

export function logUber(f: {
  fn: string;
  event: string;
  order_id?: string | null;
  restaurant_id?: string | null;
  uber_delivery_id?: string | null;
  uber_http_status?: number | null;
  outcome: string;
  ms?: number | null;
}): void {
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      fn: f.fn,
      event: f.event,
      order_id: f.order_id ?? null,
      restaurant_id: f.restaurant_id ?? null,
      uber_delivery_id: f.uber_delivery_id ?? null,
      uber_http_status: f.uber_http_status ?? null,
      outcome: f.outcome,
      ms: f.ms ?? null,
    })
  );
}
