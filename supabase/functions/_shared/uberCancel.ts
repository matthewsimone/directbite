// ============================================================================
// uberCancel — Cancel an in-flight Uber Direct delivery (M9c)
// ============================================================================
//
// Milestone 9c of the Uber Direct integration. Shared library (not an edge
// function) — the single source of truth for releasing an Uber Direct
// delivery when an operator cancels & refunds an order. Imported in-process
// by admin-refund, mirroring the _shared/uberToken.ts pattern (no
// function-to-function HTTP hop, no re-auth dance).
//
// Why a shared lib and not a standalone function (D1): admin-refund must
// cancel the Uber delivery BEFORE issuing the Stripe refund, atomically and
// without leaving the cancel reachable by anything that bypasses the refund
// guard. Co-locating the logic in-process keeps the cancel+refund cascade a
// single server-side transaction-of-intent. A standalone uber-cancel-delivery
// function was deferred (D1).
//
// Ordering is load-bearing: the caller cancels Uber FIRST, refunds Stripe
// SECOND. If Uber cancel fails (past the cancellation window / already
// picked up), the caller MUST NOT refund — refunding there would mean paying
// Uber for the delivery AND refunding the customer who still receives the
// food. Uber-first means any failure leaves us in a retryable state.
//
// Financial note (D2): the customer always receives a full refund (the
// caller's concern). Uber may assess a cancellation fee, returned in the
// cancel response. We LOG that fee for reconciliation but do NOT persist it
// (D2) — DirectBite/the restaurant absorbs it per the locked decision.
//
// Spelling trap: order.status uses 'cancelled' (two L's, order lifecycle);
// uber_status uses 'canceled' (one L, matches Uber's API + the uber-webhook
// handler + OrdersTab display). This file only ever touches uber_status, so
// it writes/compares 'canceled'.
//
// Uber endpoint:
//   POST {apiBase}/v1/customers/{customer_id}/deliveries/{delivery_id}/cancel
//   - 200 → canceled (Uber returns 200 on re-cancellation too → idempotent)
//   - 4xx → outside the cancellation window / already picked up / not found
//
// Returns a discriminated union; the caller branches on `success`.
//   - { success: true, alreadyCanceled?: boolean, uberFee?: number }
//   - { success: false, error, detail?, status? }
//
// Idempotency:
//   - order.uber_status === 'canceled'  → short-circuit success, no API call
//   - !order.uber_delivery_id           → never dispatched, nothing to
//                                          cancel → short-circuit success
//     (covers cancel-before-dispatch: caller proceeds straight to refund)
// ============================================================================

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "./uberToken.ts";
import { getUberApiBase } from "./uberConfig.ts";
import { resolveUrlCreds } from "./uberCreds.ts";
import { logUber } from "./uberLog.ts";

// Minimal shapes — callers pass the already-fetched order + restaurant rows.
// Only the fields this function reads are declared; both rows carry more.
interface CancelOrder {
  id: string;
  uber_status?: string | null;
  uber_delivery_id?: string | null;
}

interface CancelRestaurant {
  id: string;
  uber_customer_id?: string | null;
  uber_environment?: string | null;
  uber_billing_mode?: string | null;
}

export type UberCancelResult =
  | {
      success: true;
      // True when no Uber API call was made (already canceled, or never
      // dispatched). The caller treats both as "safe to refund".
      alreadyCanceled?: boolean;
      // Uber cancellation fee in cents, when Uber reports one. Logged for
      // reconciliation only; never persisted (D2).
      uberFee?: number;
    }
  | {
      success: false;
      error:
        | "uber_cancel_failed"
        | "credentials_not_set"
        | "platform_creds_not_configured"
        | "invalid_credentials"
        | "rate_limited"
        | "uber_unavailable"
        | "db_error";
      detail?: string;
      status?: number;
      retry_after?: number;
    };

export async function cancelUberDelivery(
  supabase: SupabaseClient,
  order: CancelOrder,
  restaurant: CancelRestaurant
): Promise<UberCancelResult> {
  // -------- Idempotency / never-dispatched short-circuits --------
  // Either case means there is no live Uber delivery to release, so the
  // caller is safe to proceed to the Stripe refund. We do NOT touch the
  // orders row here: if it was already 'canceled' the state is correct, and
  // if it was never dispatched uber_status is null (leaving it null is
  // correct — there's no delivery to mark canceled).
  if (order.uber_status === "canceled") {
    console.log(
      "[uberCancel] order already canceled — skipping Uber call",
      { order_id: order.id }
    );
    return { success: true, alreadyCanceled: true };
  }
  if (!order.uber_delivery_id) {
    console.log(
      "[uberCancel] no uber_delivery_id — never dispatched, nothing to cancel",
      { order_id: order.id }
    );
    return { success: true, alreadyCanceled: true };
  }

  // -------- Mint or fetch Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant.id);
  if (!tokenResult.success) {
    console.error("[uberCancel] token mint failed", {
      order_id: order.id,
      error: tokenResult.error,
    });
    return {
      success: false,
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    };
  }

  // -------- POST to Uber's cancel endpoint --------
  // Resolve creds via billing mode so platform restaurants cancel on the DirectBite account.
  // (Replaces the former restaurant.uber_customer_id null-guard — the resolver returns
  // credentials_not_set for self mode with missing creds, and uses env creds for platform mode.)
  const credsResult = resolveUrlCreds(restaurant);
  if (!credsResult.success) {
    return {
      success: false,
      error: credsResult.error,
      detail: credsResult.detail,
    };
  }
  const apiBase = getUberApiBase(credsResult.creds.environment);
  const cancelUrl =
    `${apiBase}/v1/customers/${credsResult.creds.customer_id}` +
    `/deliveries/${order.uber_delivery_id}/cancel`;

  let cancelResp: Response;
  const t0 = Date.now();
  try {
    cancelResp = await fetch(cancelUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("[uberCancel] network failure to Uber", {
      order_id: order.id,
      err: String(err),
    });
    return {
      success: false,
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    };
  }

  if (cancelResp.status === 429) {
    logUber({
      fn: "cancelUberDelivery",
      event: "cancel",
      order_id: order.id,
      uber_delivery_id: order.uber_delivery_id,
      uber_http_status: 429,
      outcome: "rate_limited",
      ms: Date.now() - t0,
    });
    const retryAfter = Number(cancelResp.headers.get("retry-after")) || 60;
    return { success: false, error: "rate_limited", retry_after: retryAfter };
  }
  logUber({
    fn: "cancelUberDelivery",
    event: "cancel",
    order_id: order.id,
    uber_delivery_id: order.uber_delivery_id,
    uber_http_status: cancelResp.status,
    outcome: cancelResp.ok ? "ok" : "http_error",
    ms: Date.now() - t0,
  });

  // Any non-2xx here is an Uber-side refusal to cancel — most commonly the
  // delivery is past its cancellation window or already picked up. This is
  // the case the caller MUST NOT refund on. We map all of these to
  // 'uber_cancel_failed' so the operator sees one clear message, and capture
  // the body detail for the log/audit trail.
  if (!cancelResp.ok) {
    let detail = "";
    try {
      detail = (await cancelResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    console.error("[uberCancel] Uber refused cancellation", {
      order_id: order.id,
      delivery_id: order.uber_delivery_id,
      status: cancelResp.status,
      detail,
    });
    return {
      success: false,
      error: "uber_cancel_failed",
      status: cancelResp.status,
      detail,
    };
  }

  // -------- Parse response (best-effort; success doesn't depend on it) --------
  // Uber returns 200 on cancellation (and on re-cancellation → idempotent).
  // The body may carry a cancellation fee; parse defensively. A malformed or
  // empty body does NOT downgrade the result — the cancellation itself
  // succeeded (HTTP 200) and that's what matters for releasing the courier.
  let uberFee: number | undefined;
  try {
    const body = await cancelResp.json();
    // Uber has historically surfaced cancellation fees under a few keys
    // depending on the delivery state; read defensively without persisting.
    // NOTE: body.fee is the DELIVERY fee, not a cancel charge. Uber's
    // cancel/Delivery response has no reliable cancellation-fee field, and a
    // pending-state cancel costs $0 — so we do NOT read body.fee here.
    // uber_cancellation_fee_cents stays NULL (=$0) unless Uber returns a real
    // cancellation_fee field.
    const feeRaw =
      body?.cancellation_fee ?? body?.dropoff?.cancellation_fee;
    if (typeof feeRaw === "number") {
      uberFee = feeRaw;
    }
  } catch {
    // Empty / non-JSON body on a 200 — fine. No fee info available.
  }

  if (typeof uberFee === "number" && uberFee > 0) {
    // D2: log only. DirectBite/the restaurant absorbs the fee; the customer
    // still receives a full refund. Persisting is intentionally out of scope.
    console.log("[uberCancel] Uber assessed a cancellation fee (absorbed)", {
      order_id: order.id,
      delivery_id: order.uber_delivery_id,
      uber_fee_cents: uberFee,
    });
  }

  // -------- Persist cancellation on our side --------
  // Mark uber_status='canceled' so the tablet reflects the released delivery
  // immediately and the double-tap short-circuit above fires on any retry.
  // Uber will also send an event.delivery_status webhook with
  // status='canceled' shortly after; that's last-write-wins and harmless.
  const cancelUpdate: Record<string, unknown> = {
    uber_status: "canceled",
    uber_status_updated_at: new Date().toISOString(),
  };
  // Migration 038: persist the cancellation fee Uber assessed (cents) so the
  // operator alert + audit reflect what the restaurant absorbed. Only write a
  // real positive fee; leave NULL when Uber charged nothing or reported none.
  if (typeof uberFee === "number" && uberFee > 0) {
    cancelUpdate.uber_cancellation_fee_cents = uberFee;
  }
  const { error: updateErr } = await supabase
    .from("orders")
    .update(cancelUpdate)
    .eq("id", order.id);

  if (updateErr) {
    // The Uber delivery IS canceled (the courier is released) but we failed
    // to record it. Surface as db_error so the caller can decide — but note
    // this is the LESS dangerous failure direction: re-running will
    // short-circuit at the API (Uber returns 200 on re-cancel) and retry the
    // write. The caller's own idempotency guards handle the refund side.
    console.error("[uberCancel] orders update failed after Uber cancel", {
      order_id: order.id,
      error: updateErr.message,
    });
    return {
      success: false,
      error: "db_error",
      detail: updateErr.message,
    };
  }

  console.log("[uberCancel] delivery canceled", {
    order_id: order.id,
    delivery_id: order.uber_delivery_id,
  });
  return { success: true, uberFee };
}
