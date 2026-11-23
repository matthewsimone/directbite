// ============================================================================
// create-payment-intent UPDATE path — Stripe status gate + error mapping (W3)
// ============================================================================
//
// Pure helpers (no Deno / Supabase / Stripe imports) so they test without
// network. Used only by create-payment-intent's update path.
//
// Background (CP8c): ~200/day 500s "application_fee_amount cannot be updated
// on a PaymentIntent after a capture has already been made" — an update that
// reaches Stripe after the customer's PI was already confirmed/captured. The
// status gate refuses those before calling Stripe; when the PI changes state
// between our retrieve and our update (a race), the update's error is mapped
// by re-reading the PI: no longer updatable → 409 payment_locked (the same
// shape the gate returns), never a 500.
// ============================================================================

/** PI statuses whose amount / application fee / metadata we may still change. */
export const UPDATABLE_PI_STATUSES: ReadonlySet<string> = new Set([
  "requires_payment_method",
  "requires_confirmation",
]);

export function isUpdatableStatus(status: unknown): boolean {
  return typeof status === "string" && UPDATABLE_PI_STATUSES.has(status);
}

export interface UpdateFailure {
  status: number;
  body: Record<string, unknown>;
}

export const lockedResponse = (status: string): UpdateFailure => ({
  status: 409,
  body: { error: "payment_locked", status },
});

// deno-lint-ignore no-explicit-any
type StripeLikeError = { type?: string; code?: string; message?: string } & Record<string, any>;

/**
 * Map a Stripe error from the update path (retrieve or update) to a non-500
 * response. `refetchStatus` re-reads the PI status (null if that fails too);
 * a PI that is no longer updatable → 409 payment_locked. Returns null for an
 * error that is NOT a Stripe API error (the caller keeps its existing 500).
 */
export async function classifyUpdateError(
  err: unknown,
  refetchStatus: (() => Promise<string | null>) | null,
): Promise<UpdateFailure | null> {
  const e = (err ?? {}) as StripeLikeError;
  const type = typeof e.type === "string" ? e.type : "";
  if (!type.startsWith("Stripe")) return null;

  if (refetchStatus) {
    let current: string | null = null;
    try {
      current = await refetchStatus();
    } catch {
      current = null;
    }
    if (current !== null && !isUpdatableStatus(current)) return lockedResponse(current);
  }

  switch (type) {
    case "StripeRateLimitError":
    case "StripeConnectionError":
    case "StripeAPIError":
      return { status: 503, body: { error: "stripe_unavailable" } };
    case "StripeAuthenticationError":
    case "StripePermissionError":
      return { status: 503, body: { error: "restaurant_payments_unavailable" } };
    case "StripeIdempotencyError":
      return { status: 409, body: { error: "idempotency_conflict" } };
    case "StripeInvalidRequestError":
      if (e.code === "resource_missing") return { status: 409, body: { error: "payment_intent_stale" } };
      return { status: 400, body: { error: "payment_update_failed", code: e.code ?? null } };
    default:
      return { status: 400, body: { error: "payment_update_failed", code: e.code ?? null } };
  }
}
