import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";

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
  console.log('=== admin-approve-adjustment invoked ===');
  console.log('Method:', req.method);
  console.log('Has Authorization header:', !!req.headers.get('Authorization'));
  console.log('Auth prefix:', req.headers.get('Authorization')?.substring(0, 20) + '...');
  console.log('Content-Type:', req.headers.get('Content-Type'));

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.log('REJECTED: No Authorization header');
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    console.log('Token length:', token?.length);
    console.log('Token first 20:', token?.substring(0, 20));

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    console.log('getUser result:', { hasUser: !!user, hasError: !!authErr, errorMessage: authErr?.message });

    if (authErr || !user) {
      console.log('REJECTED: getUser failed');
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: adminUser, error: adminError } = await supabase
      .from("admin_users")
      .select("email")
      .eq("email", user.email)
      .single();

    console.log('admin lookup:', { email: user?.email, found: !!adminUser, error: adminError?.message });

    if (!adminUser) {
      console.log('REJECTED: Not in admin_users');
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { adjustment_id, action } = await req.json();
    // action: "approve" or "deny"

    if (!adjustment_id || !action) {
      return new Response(
        JSON.stringify({ error: "adjustment_id and action are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch adjustment
    const { data: adjustment, error: adjErr } = await supabase
      .from("adjustment_requests")
      .select("*")
      .eq("id", adjustment_id)
      .single();

    if (adjErr || !adjustment) {
      return new Response(
        JSON.stringify({ error: "Adjustment not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (adjustment.status !== "pending") {
      return new Response(
        JSON.stringify({ error: "Adjustment already processed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "deny") {
      await supabase
        .from("adjustment_requests")
        .update({ status: "denied" })
        .eq("id", adjustment_id);

      return new Response(
        JSON.stringify({ success: true, status: "denied" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Approve — process via Stripe
    const { data: order } = await supabase
      .from("orders")
      .select("stripe_payment_intent_id, order_number, restaurant_id")
      .eq("id", adjustment.order_id)
      .single();

    if (!order?.stripe_payment_intent_id) {
      return new Response(
        JSON.stringify({ error: "No payment intent for this order" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up connected account for direct charge refund
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select("stripe_account_id")
      .eq("id", order.restaurant_id)
      .single();

    if (!restaurant?.stripe_account_id) {
      return new Response(
        JSON.stringify({ error: "Restaurant has no connected Stripe account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let stripeRefundId = null;

    if (adjustment.type === "refund") {
      try {
        const refund = await stripe.refunds.create(
          {
            payment_intent: order.stripe_payment_intent_id,
            amount: Math.round(adjustment.amount * 100),
          },
          { stripeAccount: restaurant.stripe_account_id }
        );
        stripeRefundId = refund.id;

        // Track refund on the order
        await supabase
          .from("orders")
          .update({
            refund_status: "partial",
            refund_amount: refund.amount,
            refunded_at: new Date().toISOString(),
            refund_reason: adjustment.note || null,
          })
          .eq("id", adjustment.order_id);
      } catch (stripeErr: any) {
        // Record failed refund
        await supabase
          .from("orders")
          .update({
            refund_status: "failed",
            refund_reason: stripeErr.message,
          })
          .eq("id", adjustment.order_id);

        return new Response(
          JSON.stringify({ error: stripeErr.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    await supabase
      .from("adjustment_requests")
      .update({
        status: "approved",
        approved_at: new Date().toISOString(),
        stripe_refund_id: stripeRefundId,
      })
      .eq("id", adjustment_id);

    console.log(`Adjustment ${adjustment_id} approved for order #${order.order_number}`);

    return new Response(
      JSON.stringify({ success: true, status: "approved", stripe_refund_id: stripeRefundId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("admin-approve-adjustment error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
