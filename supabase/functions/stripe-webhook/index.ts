import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const connectWebhookSecret = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET") || "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ---------- Printing is handled client-side via Epson ePOS SDK on the tablet ----------


// Printing is handled client-side via Epson ePOS SDK on the tablet

// ---------- Send confirmation email ----------
async function sendConfirmationEmail(orderId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/send-confirmation-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ order_id: orderId }),
    });

    if (!response.ok) {
      console.error("Confirmation email failed:", await response.text());
    } else {
      console.log(`Confirmation email sent for order ${orderId}`);
    }
  } catch (err: any) {
    console.error("Confirmation email error:", err.message);
  }
}

// ---------- Send SMS order alert ----------
async function sendOrderSms(orderId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/send-order-sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ order_id: orderId }),
    });

    if (!response.ok) {
      console.error("SMS alert failed:", await response.text());
    } else {
      const result = await response.json();
      if (result.skipped) {
        console.log("SMS alerts not enabled, skipped");
      } else if (result.success) {
        console.log(`SMS alert sent for order ${orderId}`);
      }
    }
  } catch (err: any) {
    console.error("SMS alert error:", err.message);
  }
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
    include_utensils,
    items,
  } = orderData;

  // Idempotency check — prevent duplicate orders from webhook retries
  // Only skip if the order AND its items are fully written
  const { data: existingOrder } = await supabase
    .from("orders")
    .select("id")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .single();

  if (existingOrder) {
    const { count } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", existingOrder.id);

    if (count && count >= (items || []).length) {
      console.log(`Order already exists with all ${count} items for payment intent ${paymentIntentId}, skipping`);
      return existingOrder;
    }

    // Partial write detected — clean up and re-insert
    console.log(`Partial order detected (${count} of ${(items || []).length} items), cleaning up and re-inserting`);
    await supabase.from("order_items").delete().eq("order_id", existingOrder.id);
    await supabase.from("orders").delete().eq("id", existingOrder.id);
  }

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
      include_utensils: include_utensils || false,
    })
    .select()
    .single();

  if (orderErr) {
    console.error("Failed to insert order:", orderErr);
    throw orderErr;
  }

  // Insert all order items
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
      console.error(`Failed to insert order item "${item.item_name}":`, oiErr);
      continue; // Skip this item but continue inserting the rest
    }

    // Insert toppings for this item
    if (item.toppings && item.toppings.length > 0) {
      const toppingRows = item.toppings.map((t: any) => ({
        order_item_id: orderItem.id,
        topping_id: t.topping_id,
        topping_name: t.topping_name,
        placement: t.placement,
        price_charged: t.price_charged,
        placement_type: t.placement_type || "pizza",
      }));

      const { error: tErr } = await supabase
        .from("order_item_toppings")
        .insert(toppingRows);

      if (tErr) {
        console.error(`Failed to insert toppings for "${item.item_name}":`, tErr);
        // Continue — item is saved, just without toppings
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

    // Verify webhook signature — try Connect webhook first, fall back to platform
    let event: Stripe.Event;
    let verified = false;

    if (connectWebhookSecret) {
      try {
        event = await stripe.webhooks.constructEventAsync(body, signature, connectWebhookSecret);
        verified = true;
        console.log("Verified via Connect webhook secret");
      } catch {
        // Fall through to platform secret
      }
    }

    if (!verified) {
      try {
        event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
        verified = true;
        console.log("Verified via platform webhook secret");
      } catch (err: any) {
        console.error("Webhook signature verification failed with both secrets:", err.message);
        return new Response(`Webhook Error: ${err.message}`, { status: 400 });
      }
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

        // Printing handled by tablet via Epson ePOS SDK (auto-prints on new order detection)

        // Send confirmation email
        await sendConfirmationEmail(order.id);

        // Send SMS alert to restaurant (if enabled)
        await sendOrderSms(order.id);

        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        console.log(`Charge refunded: ${charge.id}`);

        // Find order by charge ID or payment intent
        const { data: refundedOrder } = await supabase
          .from("orders")
          .select("id, order_number, total_amount")
          .or(`stripe_charge_id.eq.${charge.id},stripe_payment_intent_id.eq.${charge.payment_intent}`)
          .single();

        if (refundedOrder) {
          const totalPaidCents = Math.round(Number(refundedOrder.total_amount) * 100);
          const refundedCents = charge.amount_refunded;
          const isPartial = refundedCents < totalPaidCents;

          await supabase
            .from("orders")
            .update({
              refund_status: isPartial ? "partial" : "completed",
              refund_amount: refundedCents,
              refunded_at: new Date().toISOString(),
              refund_reason: "Refunded via Stripe dashboard",
            })
            .eq("id", refundedOrder.id);

          console.log(`Order #${refundedOrder.order_number} refund tracked: ${refundedCents} cents (${isPartial ? "partial" : "full"})`);
        } else {
          console.warn(`No order found for refunded charge ${charge.id}`);
        }
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
