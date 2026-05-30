import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";
// M9c: Uber Direct cancel cascade. For uber_direct orders we release the
// Uber delivery BEFORE refunding Stripe (ordering is load-bearing — see
// _shared/uberCancel.ts). In-process import, no function-to-function hop.
import { cancelUberDelivery } from "../_shared/uberCancel.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if admin or tablet user
    const { data: adminUser } = await supabase
      .from("admin_users")
      .select("email")
      .eq("email", user.email)
      .single();

    const { data: tabletRestaurant } = await supabase
      .from("restaurants")
      .select("id")
      .eq("tablet_email", user.email)
      .single();

    if (!adminUser && !tabletRestaurant) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { order_id, amount, type } = await req.json();
    // type: "full" or "partial"
    // amount: in dollars, only required for partial

    if (!order_id) {
      return new Response(
        JSON.stringify({ error: "order_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch order
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*")
      .eq("id", order_id)
      .single();

    if (orderErr || !order) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Tablet users can only refund their own restaurant's orders
    if (!adminUser && tabletRestaurant && order.restaurant_id !== tabletRestaurant.id) {
      return new Response(
        JSON.stringify({ error: "Access denied — not your restaurant's order" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
      return new Response(
        JSON.stringify({ success: true, idempotent: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Already delivered / completed: the customer received the order.
    //    Do not refund. For uber_direct this also means the courier already
    //    dropped off, so there is no delivery to cancel either.
    if (order.uber_status === "delivered" || order.status === "complete") {
      return new Response(
        JSON.stringify({ error: "already_delivered" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!order.stripe_payment_intent_id) {
      return new Response(
        JSON.stringify({ error: "No payment intent found for this order" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up connected account for direct charge refund. M9c: also pull the
    // Uber fields cancelUberDelivery needs (id, customer_id, environment) so
    // we don't issue a second restaurants query in the uber_direct branch.
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select("id, stripe_account_id, uber_customer_id, uber_environment")
      .eq("id", order.restaurant_id)
      .single();

    if (!restaurant?.stripe_account_id) {
      return new Response(
        JSON.stringify({ error: "Restaurant has no connected Stripe account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
    let cancelResult: Awaited<ReturnType<typeof cancelUberDelivery>> | null = null;
    if (order.delivery_fulfillment_method === "uber_direct") {
      cancelResult = await cancelUberDelivery(supabase, order, restaurant);
      if (!cancelResult.success) {
        // No Stripe refund. Surface the cancel error verbatim so the tablet
        // can show the operator a window-specific message (uber_cancel_failed
        // → "past cancellation window / already picked up; NOT refunded").
        return new Response(
          JSON.stringify({
            success: false,
            error: cancelResult.error,
            detail: cancelResult.detail,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
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
        { stripeAccount: restaurant.stripe_account_id }
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

      return new Response(
        JSON.stringify({ error: stripeErr.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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

    console.log(`Refund processed: ${refund.id} for order #${order.order_number} (${type})`);

    // M9c: when the order was uber_direct, the Uber delivery was already
    // released above (cancelUberDelivery returned success). Surface that in
    // the response so callers/audit can see the full cascade fired.
    const responseBody: any = { success: true, refund_id: refund.id };
    if (order.delivery_fulfillment_method === "uber_direct") {
      responseBody.uber_canceled = true;
      // Migration 038: surface the actual Uber cancellation fee (cents) so the
      // tablet can show it in the post-cancel alert. Only when Uber charged one.
      if (
        cancelResult &&
        cancelResult.success &&
        typeof cancelResult.uberFee === "number" &&
        cancelResult.uberFee > 0
      ) {
        responseBody.uber_cancellation_fee_cents = cancelResult.uberFee;
      }
    }

    return new Response(
      JSON.stringify(responseBody),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("admin-refund error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
