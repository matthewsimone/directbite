import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";

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
    const { payment_intent_id } = await req.json();

    if (!payment_intent_id) {
      return new Response(
        JSON.stringify({ error: "payment_intent_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up the order by its Stripe payment intent. service_role bypasses
    // RLS; we scope the response to ONLY this one order and a whitelist of
    // non-PII fields the confirmation page consumes (no customer_phone /
    // customer_email / delivery_address / stripe_charge_id).
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select(
        "id, restaurant_id, order_number, order_type, scheduled_for, subtotal, discount_amount, discount_percentage, delivery_fee, tax_amount, tip_amount, service_fee, total_amount, include_utensils, special_instructions, customer_name, delivery_fulfillment_method, uber_status, uber_tracking_url, uber_courier_info, loyalty_discount_amount, loyalty_points_spent"
      )
      .eq("stripe_payment_intent_id", payment_intent_id)
      .single();

    if (orderErr || !order) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Order items + their toppings (whitelisted display fields only).
    const { data: items } = await supabase
      .from("order_items")
      .select(
        "id, item_name, size_name, base_price, quantity, special_instructions, loyalty_redemption_id, order_item_toppings(topping_name, placement, price_charged, placement_type)"
      )
      .eq("order_id", order.id)
      .order("created_at");

    // Restaurant display fields (all public via anon_read_restaurants). The
    // loyalty_* columns let the page preview an earn when the customer lands
    // before the accrual trigger has written the ledger row.
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select(
        "name, phone, estimated_pickup_minutes, estimated_delivery_minutes, loyalty_enabled, loyalty_points_per_dollar, loyalty_earn_basis"
      )
      .eq("id", order.restaurant_id)
      .single();

    // What the ledger actually awarded for this order. Null covers both "no
    // points earned" and "the accrual hasn't landed yet" — the page cannot
    // tell them apart, and a failure here must never break the confirmation.
    let loyaltyPointsEarned: number | null = null;
    const { data: earnRow, error: earnErr } = await supabase
      .from("loyalty_transactions")
      .select("points_delta")
      .eq("order_id", order.id)
      .gt("points_delta", 0)
      .maybeSingle();

    if (earnErr) {
      console.error("get-order-by-pi loyalty read failed:", earnErr.message);
    } else if (earnRow) {
      loyaltyPointsEarned = Number(earnRow.points_delta);
    }

    // Strip internal-only ids before returning.
    const { id: _id, restaurant_id: _restaurantId, ...safeOrder } = order;

    return new Response(
      JSON.stringify({
        order: safeOrder,
        items: items || [],
        restaurant,
        loyalty_points_earned: loyaltyPointsEarned,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("get-order-by-pi error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
