// ============================================================================
// refundUberAppFee — Walk back the platform application fee after an Uber
// leg is cancelled
// ============================================================================
//
// Under uber_billing_mode='platform', DirectBite fronts the Uber Direct
// delivery fee AND the upfront courier tip on its own account, then recoups
// both through the Stripe application fee on the customer's direct charge:
//
//   application_fee_amount = 150 + uber_quoted_fee_cents + min(tipCents, 500)
//     (create-payment-intent/index.ts:354-355)
//
// The 150¢ is DirectBite's flat service fee — earned regardless. The other two
// components are pure passthrough: money collected ONLY because DirectBite was
// about to pay Uber.
//
// When the Uber leg is then cancelled — Cancel & Refund (admin-refund) or
// Deliver In-House (uber-self-deliver) — Uber charges $0 (cancel at 'pending')
// or a small cancellation fee. But the application fee was captured at charge
// time and is never walked back, so DirectBite keeps passthrough money it
// never spent, out of the restaurant's balance. Measured: $370.87 across 31
// orders before this fix.
//
// This module refunds the passthrough portion back to the connected account:
//
//   refund = fee.amount - 150 - uberCancellationFee - fee.amount_refunded
//
// Derived from fee.amount, NEVER reconstructed from the order row. The
// PaymentIntent can be updated mid-checkout (create-payment-intent:457
// re-asserts application_fee_amount on the update path), so the captured fee
// object is the only truth about what was actually taken.
//
// -------- Account topology (get this wrong and every call 404s) --------
// The charge lives on the CONNECTED account (direct charge) → retrieve it WITH
// the stripeAccount header. The ApplicationFee lives on the PLATFORM → retrieve
// and refund it with NO stripeAccount header. STRIPE_SECRET_KEY in the calling
// functions is the platform key (proven by create-payment-intent:586 setting
// application_fee_amount on a direct charge — only the platform may do that).
//
// -------- This function MUST NEVER THROW --------
// admin-refund calls it AFTER refunds.create has already succeeded. A throw
// there would escape to the outer catch, return a 500, and leave the customer
// refunded on Stripe with refund_status never written to the orders row — a
// strictly worse state than the overcharge this fixes. Every path is wrapped;
// failures are logged and swallowed. The application fee is recoverable by
// hand from the Stripe dashboard; a desynced refund_status is not.
//
// Self-mode restaurants (uber_billing_mode !== 'platform') and non-uber_direct
// orders return before any Stripe call — byte-identical to pre-fix behavior.
// ============================================================================

// Type-only import: erased at runtime, so this module pulls in no new
// dependency of its own. Callers supply their already-constructed client.
import type Stripe from "https://esm.sh/stripe@17.7.0";

// DirectBite's flat service fee in cents — the one component of the
// application fee that is EARNED, not fronted. Must stay in sync with the
// literal 150 in create-payment-intent/index.ts:186,355.
const PLATFORM_SERVICE_FEE_CENTS = 150;

// Minimal shapes — callers pass already-fetched rows. Only fields read here
// are declared; both rows carry more. (Mirrors _shared/uberCancel.ts.)
interface AppFeeOrder {
  id: string;
  delivery_fulfillment_method?: string | null;
  stripe_charge_id?: string | null;
}

interface AppFeeRestaurant {
  stripe_account_id?: string | null;
  uber_billing_mode?: string | null;
}

export interface AppFeeRefundResult {
  // Cents actually refunded to the connected account. 0 when skipped.
  refunded_cents: number;
  // Why nothing was refunded, for log correlation. Absent on a real refund.
  skipped_reason?:
    | "not_platform_mode"
    | "not_uber_direct"
    | "no_charge_id"
    | "no_connected_account"
    | "no_application_fee"
    | "nothing_to_refund"
    | "error";
}

/**
 * Refund the fronted (non-earned) portion of the platform application fee
 * after an Uber Direct delivery has been cancelled.
 *
 * Callers may ignore the return value — it exists for logging. This function
 * never throws.
 *
 * @param stripe        Stripe client built from the PLATFORM secret key.
 * @param order         Order row (id, delivery_fulfillment_method,
 *                      stripe_charge_id).
 * @param restaurant    Restaurant row (stripe_account_id, uber_billing_mode).
 * @param uberFeeCents  Uber's cancellation charge in cents, from
 *                      cancelUberDelivery's `uberFee`. Undefined/null when
 *                      Uber charged nothing (the common pending-cancel case).
 */
export async function refundUberAppFee(
  stripe: Stripe,
  order: AppFeeOrder,
  restaurant: AppFeeRestaurant,
  uberFeeCents?: number | null
): Promise<AppFeeRefundResult> {
  try {
    // -------- Scope guards: platform-billed uber_direct orders only --------
    // Self mode never had a passthrough application fee to walk back, so it
    // must not make a single Stripe call here.
    if ((restaurant?.uber_billing_mode ?? "self") !== "platform") {
      return { refunded_cents: 0, skipped_reason: "not_platform_mode" };
    }
    if (order?.delivery_fulfillment_method !== "uber_direct") {
      return { refunded_cents: 0, skipped_reason: "not_uber_direct" };
    }

    if (!order.stripe_charge_id) {
      // Set by stripe-webhook at order insert; NULL means the webhook hadn't
      // landed yet or this is a legacy row. Nothing to look up — surface it
      // loudly so it can be reconciled by hand.
      console.error("[refundUberAppFee] no stripe_charge_id — cannot locate fee", {
        order_id: order.id,
      });
      return { refunded_cents: 0, skipped_reason: "no_charge_id" };
    }
    if (!restaurant.stripe_account_id) {
      console.error("[refundUberAppFee] restaurant has no connected account", {
        order_id: order.id,
      });
      return { refunded_cents: 0, skipped_reason: "no_connected_account" };
    }

    // -------- 1. Charge lives on the CONNECTED account --------
    const charge = await stripe.charges.retrieve(
      order.stripe_charge_id,
      { stripeAccount: restaurant.stripe_account_id }
    );

    // charge.application_fee is expandable: a `fee_...` string when
    // unexpanded (our case), an object if it ever is. Normalize both.
    const rawFee = (charge as any)?.application_fee;
    const feeId: string | undefined =
      typeof rawFee === "string" ? rawFee : rawFee?.id;

    if (!feeId) {
      // No application fee on this charge. Expected for orders created before
      // platform billing was enabled, or if the PI was built without one.
      console.log("[refundUberAppFee] charge carries no application fee", {
        order_id: order.id,
        charge_id: order.stripe_charge_id,
      });
      return { refunded_cents: 0, skipped_reason: "no_application_fee" };
    }

    // -------- 2. ApplicationFee lives on the PLATFORM (no header) --------
    const fee = await stripe.applicationFees.retrieve(feeId);

    // -------- 3. Compute the walk-back --------
    // fee.amount is the ONLY truth about what was captured — do not
    // reconstruct from uber_quoted_fee/tip_amount on the order row.
    const capturedCents = Number(fee?.amount ?? 0);
    // Subtracting amount_refunded makes this idempotent across paths: if
    // uber-self-deliver already walked the fee down and the order is later
    // cancelled & refunded, the second call computes <= 0 and no-ops rather
    // than double-refunding.
    const alreadyRefundedCents = Number(fee?.amount_refunded ?? 0);
    const uberCharged = typeof uberFeeCents === "number" && uberFeeCents > 0
      ? uberFeeCents
      : 0;

    const refundCents =
      capturedCents -
      PLATFORM_SERVICE_FEE_CENTS -
      uberCharged -
      alreadyRefundedCents;

    if (refundCents <= 0) {
      console.log("[refundUberAppFee] nothing to refund", {
        order_id: order.id,
        fee_id: feeId,
        captured_cents: capturedCents,
        already_refunded_cents: alreadyRefundedCents,
        uber_cancellation_fee_cents: uberCharged,
        computed_cents: refundCents,
      });
      return { refunded_cents: 0, skipped_reason: "nothing_to_refund" };
    }

    // -------- 4. Refund on the PLATFORM (no stripeAccount header) --------
    // Keyed on order.id so a retried cancel can't stack refunds. Note the
    // amount_refunded subtraction above normally makes a repeat call no-op
    // before reaching here; the key is belt-and-braces for true concurrency.
    const feeRefund = await stripe.applicationFees.createRefund(
      feeId,
      { amount: refundCents },
      { idempotencyKey: `appfee-refund-${order.id}` }
    );

    console.log("[refundUberAppFee] application fee walked back", {
      order_id: order.id,
      fee_id: feeId,
      fee_refund_id: feeRefund.id,
      captured_cents: capturedCents,
      refunded_cents: refundCents,
      uber_cancellation_fee_cents: uberCharged,
      retained_cents: PLATFORM_SERVICE_FEE_CENTS + uberCharged,
    });

    return { refunded_cents: refundCents };
  } catch (err: any) {
    // Swallow everything. See the header: a throw here is worse than the bug.
    console.error("[refundUberAppFee] failed — fee NOT walked back", {
      order_id: order?.id,
      charge_id: order?.stripe_charge_id,
      error: err?.message ?? String(err),
    });
    return { refunded_cents: 0, skipped_reason: "error" };
  }
}
