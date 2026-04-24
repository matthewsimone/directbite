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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { restaurant_id, amount, order_data, payment_intent_id, idempotency_key } = await req.json();

    if (!restaurant_id || !amount) {
      return new Response(
        JSON.stringify({ error: "restaurant_id and amount are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up restaurant's Stripe Connect account
    const { data: restaurant, error: restErr } = await supabase
      .from("restaurants")
      .select("stripe_account_id, name")
      .eq("id", restaurant_id)
      .single();

    if (restErr || !restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurant not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!restaurant.stripe_account_id) {
      return new Response(
        JSON.stringify({ error: "Restaurant has not connected Stripe" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Store order data in pending_orders table to avoid Stripe metadata size limits
    let pending_order_id: string;

    if (payment_intent_id) {
      // Update: look up existing pending order from the payment intent metadata
      const existing = await stripe.paymentIntents.retrieve(
        payment_intent_id,
        { stripeAccount: restaurant.stripe_account_id }
      );
      pending_order_id = existing.metadata?.pending_order_id || "";

      if (pending_order_id && order_data) {
        await supabase
          .from("pending_orders")
          .update({ order_data })
          .eq("id", pending_order_id);
      }

      const updated = await stripe.paymentIntents.update(
        payment_intent_id,
        {
          amount,
          metadata: {
            restaurant_id,
            restaurant_name: restaurant.name,
            pending_order_id,
          },
        },
        { stripeAccount: restaurant.stripe_account_id }
      );

      return new Response(
        JSON.stringify({
          clientSecret: updated.client_secret,
          paymentIntentId: updated.id,
          stripeAccount: restaurant.stripe_account_id,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a pending order row
    const { data: pendingOrder, error: poErr } = await supabase
      .from("pending_orders")
      .insert({ restaurant_id, order_data: order_data || {} })
      .select("id")
      .single();

    if (poErr || !pendingOrder) {
      throw new Error("Failed to create pending order");
    }

    pending_order_id = pendingOrder.id;

    // Create PaymentIntent directly on the connected account (direct charges)
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount, // already in cents from frontend
        currency: "usd",
        payment_method_types: ["card"],
        application_fee_amount: 150, // $1.50 DirectBite fee
        metadata: {
          restaurant_id,
          restaurant_name: restaurant.name,
          pending_order_id,
        },
      },
      {
        stripeAccount: restaurant.stripe_account_id,
        ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
      }
    );

    return new Response(
      JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        stripeAccount: restaurant.stripe_account_id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("create-payment-intent error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
