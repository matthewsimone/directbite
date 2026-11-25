/**
 * Cancel & Refund from a register = admin-refund {type: 'full'} — its logic UNCHANGED (Matt, CP19).
 *
 * COPIED from supabase/functions/admin-refund/index.ts :102-254 (the handler glue after auth + the order fetch),
 * pinned by hash: sha256 e4a85d24b5822a5bc52a6609c991985ccb61d8b129307d552120b42cc80cd114
 * (_shared/pos-online/adminRefundPin.json; scripts/check-ordr-core.mjs fails if those web lines change —
 * then re-copy, re-review, re-pin). The shared modules are IMPORTED UNCHANGED by the caller and passed in:
 * _shared/uberCancel.ts cancelUberDelivery, _shared/refundUberAppFee.ts refundUberAppFee (the entry point binds
 * the real ones; tests pass fakes).
 *
 * The copy differs from the web lines ONLY in:
 *   1. every `return new Response(…)` → a typed result (the POS handler maps it to the §3c wire, handlers.ts);
 *      the success response body (refund_id, uber_canceled, uber_cancellation_fee_cents) is returned as fields;
 *   2. `type` is the constant 'full' and `amount` is undefined (admin-refund's request fields; the POS only
 *      cancels in full — the 'partial' branches are kept verbatim and never taken);
 *   3. refunds.create gets `idempotencyKey: pos-cancel-refund-<action_id>` next to `stripeAccount` — the refund
 *      parameters are identical. It makes a re-run of the same POS action (a crash between Stripe and the orders
 *      update; handlers.ts re-runs a stale pending action) return the SAME Stripe refund, never a second one;
 *   4. console.log → the injected log (same facts).
 * Same guards (idempotent double-tap, already_delivered), same Uber-cancel-before-Stripe order, same orders writes
 * (refund_status, refund_amount (dollars), refunded_at, status cancelled, cancelled_by restaurant_refund; on a Stripe
 * failure refund_status failed + refund_reason), loyalty reversal by the existing trigger on refund_status
 * (081_loyalty_refund_reversal.sql), the fronted application fee walked back (refundUberAppFee, never throws).
 */

// deno-lint-ignore-file no-explicit-any

/** _shared/uberCancel.ts UberCancelResult (structural — keeps this module free of the remote imports). */
export type UberCancelResultLike =
  | { success: true; alreadyCanceled?: boolean; uberFee?: number }
  | { success: false; error: string; detail?: unknown; status?: number; retry_after?: unknown };

export interface AdminRefundGlueDeps {
  /** Service-role supabase-js client — the same client admin-refund uses. */
  supabase: any;
  /** The platform Stripe client (STRIPE_SECRET_KEY), as admin-refund constructs it. */
  stripe: any;
  cancelUberDelivery: (supabase: any, order: any, restaurant: any) => Promise<UberCancelResultLike>;
  refundUberAppFee: (stripe: any, order: any, restaurant: any, uberCancellationFeeCents?: number) => Promise<unknown>;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export type AdminRefundResult =
  /** admin-refund :112-120 — { success: true, idempotent: true } */
  | { kind: 'idempotent' }
  /** :125-130 — { error: "already_delivered" } */
  | { kind: 'already_delivered' }
  /** :132-137 / :148-153 — 400 */
  | { kind: 'no_payment_intent' | 'no_stripe_account'; message: string }
  /** :168-180 — { success: false, error, detail }: NOTHING refunded */
  | { kind: 'uber_cancel_failed'; error: string; detail: unknown }
  /** :198-211 — refund_status failed + refund_reason written; 400 { error } */
  | { kind: 'stripe_failed'; message: string }
  /** :217-254 + :259-271 — the orders row updated, the app fee walked back */
  | { kind: 'refunded'; refund_id: string; uber_canceled: boolean; uber_cancellation_fee_cents: number | null };

/** `order` = the orders row (select *), already checked to be the principal's restaurant's. */
export async function adminRefundFull(d: AdminRefundGlueDeps, order: any, actionId: string): Promise<AdminRefundResult> {
  const { supabase, stripe, cancelUberDelivery, refundUberAppFee } = d;
  const order_id = order.id;
  const type: string = 'full';
  const amount: string | undefined = undefined;

  // ---- admin-refund/index.ts :102-254 (adaptations 1–4 above) ----

  // M9c: Terminal-state guards (D4 — applies to ALL orders, in_house and
  // uber_direct). These run before any refund attempt or Uber cancel.
  //
  // 1. Idempotent double-tap: a full cancel already refunded this order.
  //    The operator tapped "Yes, Cancel" twice, or two tablets raced.
  //    Short-circuit success so the second request is a no-op rather than
  //    a Stripe "already refunded" error. Partial refunds also count —
  //    re-cancelling a partially-refunded order shouldn't double-refund.
  //    (Note: order.status uses 'cancelled' (two L's); uber_status below
  //    uses 'canceled' (one L). Distinct fields, distinct spellings.)
  if (
    order.status === "cancelled" &&
    (order.refund_status === "completed" || order.refund_status === "partial")
  ) {
    return { kind: 'idempotent' };
  }

  // 2. Already delivered / completed: the customer received the order.
  //    Do not refund. For uber_direct this also means the courier already
  //    dropped off, so there is no delivery to cancel either.
  if (order.uber_status === "delivered" || order.status === "complete") {
    return { kind: 'already_delivered' };
  }

  if (!order.stripe_payment_intent_id) {
    return { kind: 'no_payment_intent', message: "No payment intent found for this order" };
  }

  // Look up connected account for direct charge refund. M9c: also pull the
  // Uber fields cancelUberDelivery needs (id, customer_id, environment) so
  // we don't issue a second restaurants query in the uber_direct branch.
  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("id, stripe_account_id, uber_customer_id, uber_environment, uber_billing_mode")
    .eq("id", order.restaurant_id)
    .single();

  if (!restaurant?.stripe_account_id) {
    return { kind: 'no_stripe_account', message: "Restaurant has no connected Stripe account" };
  }

  // M9c: Uber Direct cancel cascade. Release the Uber delivery BEFORE
  // refunding Stripe. Ordering is load-bearing (see _shared/uberCancel.ts):
  // if Uber refuses the cancellation (past the window / already picked up)
  // we must NOT refund — otherwise we pay Uber for the delivery AND refund
  // a customer who still receives the food. cancelUberDelivery
  // short-circuits to success for orders that were never dispatched
  // (no uber_delivery_id) or are already canceled, so those fall straight
  // through to the Stripe refund below. in_house orders skip this entirely.
  // Hoisted (D4) so the captured cancellation fee is in scope when we build
  // the success response below.
  let cancelResult: UberCancelResultLike | null = null;
  if (order.delivery_fulfillment_method === "uber_direct") {
    cancelResult = await cancelUberDelivery(supabase, order, restaurant);
    if (!cancelResult.success) {
      // No Stripe refund. Surface the cancel error verbatim so the tablet
      // can show the operator a window-specific message (uber_cancel_failed
      // → "past cancellation window / already picked up; NOT refunded").
      return { kind: 'uber_cancel_failed', error: cancelResult.error, detail: cancelResult.detail };
    }
  }

  // Process refund on connected account (direct charges)
  const refundParams: any = {
    payment_intent: order.stripe_payment_intent_id,
  };

  if (type === "partial" && amount) {
    refundParams.amount = Math.round(parseFloat(amount) * 100);
  }

  let refund;
  try {
    refund = await stripe.refunds.create(
      refundParams,
      { stripeAccount: restaurant.stripe_account_id, idempotencyKey: `pos-cancel-refund-${actionId}` }
    );
  } catch (stripeErr: any) {
    // Record failed refund attempt
    await supabase
      .from("orders")
      .update({
        refund_status: "failed",
        refund_reason: stripeErr.message,
      })
      .eq("id", order_id);

    return { kind: 'stripe_failed', message: String(stripeErr?.message ?? 'the card refund did not go through') };
  }

  // Update order with refund tracking. Migration 041: refund_amount is now
  // numeric DOLLARS (matching total_amount/subtotal). Stripe's refund.amount
  // is cents, so divide by 100 before storing.
  const refundAmountDollars = refund.amount / 100;
  const isPartial = type === "partial";

  const updateData: any = {
    refund_status: isPartial ? "partial" : "completed",
    refund_amount: refundAmountDollars,
    refunded_at: new Date().toISOString(),
  };

  if (type === "full") {
    updateData.status = "cancelled";
    // Migration 042: attribute the cancellation. Set only on a full cancel
    // (the moment status → cancelled). Distinguishes this restaurant-driven
    // refund cancel from an Uber-initiated one in the tablet UI.
    updateData.cancelled_by = "restaurant_refund";
  }

  await supabase
    .from("orders")
    .update(updateData)
    .eq("id", order_id);

  d.log('online_refund_processed', { refund_id: refund.id, order_number: order.order_number, type });

  // Platform billing: the Uber delivery was released above, so DirectBite
  // owes Uber nothing beyond any cancellation fee. Walk the fronted portion
  // of the application fee back to the connected account. Deliberately AFTER
  // the orders update and NOT gated to the response: this helper never
  // throws, and a failure here must not turn an already-completed customer
  // refund into a 500. Self mode / in_house no-op inside the helper.
  // `cancelResult?.success &&` is required for narrowing — cancelResult is
  // the union type again outside the uber_direct block above.
  await refundUberAppFee(
    stripe,
    order,
    restaurant,
    cancelResult?.success ? cancelResult.uberFee : undefined
  );

  // ---- end of the copy; the success response fields (admin-refund :259-271) ----
  const uberDirect = order.delivery_fulfillment_method === "uber_direct";
  const fee = cancelResult && cancelResult.success && typeof cancelResult.uberFee === "number" && cancelResult.uberFee > 0 ? cancelResult.uberFee : null;
  return { kind: 'refunded', refund_id: refund.id, uber_canceled: uberDirect, uber_cancellation_fee_cents: uberDirect ? fee : null };
}
