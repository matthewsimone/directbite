import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-12-18.acacia",
});

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ---------- Placeholder: PrintNode ----------
async function triggerPrintJob(orderId: string, restaurantId: string) {
  // TODO: Implement PrintNode integration in Prompt 6
  console.log(`[PrintNode] Placeholder: would print order ${orderId} for restaurant ${restaurantId}`);
}

// ---------- Placeholder: Email ----------
async function sendConfirmationEmail(orderData: any) {
  // TODO: Implement Resend email in Prompt 6
  console.log(`[Email] Placeholder: would send confirmation to ${orderData.customer_email}`);
}

// ---------- Write order to database ----------
async function writeOrder(orderData: any, paymentIntentId: string, chargeId: string | null) {
  const {
    restaurant_id,
    order_type,
    customer_name,
    customer_phone,
    customer_email,
    delivery_address,
    subtotal,
    discount_amount,
    discount_percentage,
    delivery_fee,
    tax_amount,
    tip_amount,
    service_fee,
    total_amount,
    special_instructions,
    items,
  } = orderData;

  // Insert order
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      restaurant_id,
      status: "new",
      order_type,
      customer_name,
      customer_phone,
      customer_email,
      delivery_address: delivery_address || null,
      subtotal,
      discount_amount: discount_amount || 0,
      discount_percentage: discount_percentage || 0,
      delivery_fee: delivery_fee || 0,
      tax_amount,
      tip_amount: tip_amount || 0,
      service_fee: service_fee || 1.5,
      total_amount,
      stripe_payment_intent_id: paymentIntentId,
      stripe_charge_id: chargeId,
      special_instructions: special_instructions || null,
    })
    .select()
    .single();

  if (orderErr) {
    console.error("Failed to insert order:", orderErr);
    throw orderErr;
  }

  // Insert order items
  for (const item of items || []) {
    const { data: orderItem, error: oiErr } = await supabase
      .from("order_items")
      .insert({
        order_id: order.id,
        menu_item_id: item.menu_item_id,
        item_size_id: item.item_size_id || null,
        item_name: item.item_name,
        size_name: item.size_name || null,
        base_price: item.base_price,
        quantity: item.quantity || 1,
        special_instructions: item.special_instructions || null,
      })
      .select()
      .single();

    if (oiErr) {
      console.error("Failed to insert order item:", oiErr);
      throw oiErr;
    }

    // Insert toppings for this item
    if (item.toppings && item.toppings.length > 0) {
      const toppingRows = item.toppings.map((t: any) => ({
        order_item_id: orderItem.id,
        topping_id: t.topping_id,
        topping_name: t.topping_name,
        placement: t.placement,
        price_charged: t.price_charged,
      }));

      const { error: tErr } = await supabase
        .from("order_item_toppings")
        .insert(toppingRows);

      if (tErr) {
        console.error("Failed to insert toppings:", tErr);
        throw tErr;
      }
    }
  }

  return order;
}

serve(async (req: Request) => {
  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return new Response("Missing stripe-signature header", { status: 400 });
    }

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return new Response(`Webhook Error: ${err.message}`, { status: 400 });
    }

    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`Payment succeeded: ${paymentIntent.id}`);

        // Retrieve order data from pending_orders table
        const pendingOrderId = paymentIntent.metadata?.pending_order_id;
        if (!pendingOrderId) {
          console.error("No pending_order_id in payment intent metadata");
          break;
        }

        const { data: pendingOrder, error: poErr } = await supabase
          .from("pending_orders")
          .select("order_data")
          .eq("id", pendingOrderId)
          .single();

        if (poErr || !pendingOrder) {
          console.error("Failed to fetch pending order:", poErr?.message);
          break;
        }

        const orderData = pendingOrder.order_data;

        // Get charge ID from the latest charge
        const chargeId = paymentIntent.latest_charge
          ? (typeof paymentIntent.latest_charge === "string"
              ? paymentIntent.latest_charge
              : paymentIntent.latest_charge.id)
          : null;

        // Write order to database
        const order = await writeOrder(orderData, paymentIntent.id, chargeId);
        console.log(`Order created: ${order.id} (#${order.order_number})`);

        // Clean up pending order
        await supabase.from("pending_orders").delete().eq("id", pendingOrderId);

        // Trigger print job (placeholder)
        await triggerPrintJob(order.id, orderData.restaurant_id);

        // Send confirmation email (placeholder)
        await sendConfirmationEmail(orderData);

        break;
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const failureMessage = paymentIntent.last_payment_error?.message || "Unknown error";
        console.error(
          `Payment failed: ${paymentIntent.id} — ${failureMessage}`
        );
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Webhook handler error:", err.message);
    return new Response(`Server Error: ${err.message}`, { status: 500 });
  }
});
