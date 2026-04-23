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

    if (!order.stripe_payment_intent_id) {
      return new Response(
        JSON.stringify({ error: "No payment intent found for this order" }),
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

    // Process refund on connected account (direct charges)
    const refundParams: any = {
      payment_intent: order.stripe_payment_intent_id,
    };

    if (type === "partial" && amount) {
      refundParams.amount = Math.round(parseFloat(amount) * 100);
    }

    const refund = await stripe.refunds.create(
      refundParams,
      { stripeAccount: restaurant.stripe_account_id }
    );

    // Update order status if full refund
    if (type === "full") {
      await supabase
        .from("orders")
        .update({ status: "cancelled" })
        .eq("id", order_id);
    }

    console.log(`Refund processed: ${refund.id} for order #${order.order_number} (${type})`);

    return new Response(
      JSON.stringify({ success: true, refund_id: refund.id }),
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
