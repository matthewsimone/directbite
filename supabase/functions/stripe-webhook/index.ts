import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";
import { encode as base64Encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const printNodeApiKey = Deno.env.get("PRINTNODE_API_KEY") || "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ---------- Receipt formatting ----------
function formatReceiptLine(left: string, right: string, width = 32): string {
  const gap = width - left.length - right.length;
  return left + (gap > 0 ? " ".repeat(gap) : " ") + right;
}

function formatMoney(amount: number): string {
  return `$${Number(amount).toFixed(2)}`;
}

function formatReceipt(order: any, restaurant: any, items: any[]): string {
  const lines: string[] = [];
  const sep = "=".repeat(32);
  const date = new Date(order.created_at);
  const dateStr = date.toLocaleDateString("en-US");
  const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  lines.push(sep);
  lines.push("        DIRECTBITE ORDER");
  lines.push(`        Order #${order.order_number}`);
  lines.push(`  ${restaurant.name}`);
  lines.push(`  ${dateStr} ${timeStr}`);
  lines.push(`  ORDER TYPE: ${order.order_type.toUpperCase()}`);
  lines.push(`  Customer: ${order.customer_name}`);
  lines.push(`  Phone: ${order.customer_phone}`);
  if (order.order_type === "delivery" && order.delivery_address) {
    lines.push(`  ${order.delivery_address}`);
  }
  lines.push(sep);

  for (const item of items) {
    const itemLine = `${item.quantity}x ${item.item_name}${item.size_name ? " " + item.size_name : ""}`;
    lines.push(formatReceiptLine(itemLine, formatMoney(item.base_price * item.quantity)));

    for (const t of item.order_item_toppings || []) {
      if (t.placement_type === "addon") {
        const priceStr = Number(t.price_charged) === 0 ? "Free" : `+${formatMoney(t.price_charged)}`;
        lines.push(formatReceiptLine(`  ${t.topping_name}`, priceStr));
      } else {
        const placement = t.placement === "whole" ? "WHOLE" : t.placement.toUpperCase();
        lines.push(`  ${placement}: ${t.topping_name}     +${formatMoney(t.price_charged)}`);
      }
    }

    if (item.special_instructions) {
      lines.push(`  Special: ${item.special_instructions}`);
    }
  }

  if (order.include_utensils) {
    lines.push("");
    lines.push("*** NAPKINS & UTENSILS REQUESTED ***");
    lines.push("");
  }
  lines.push(sep);
  lines.push(formatReceiptLine("Subtotal:", formatMoney(order.subtotal)));
  lines.push(formatReceiptLine("Tax:", formatMoney(order.tax_amount)));
  lines.push(formatReceiptLine("Service Fee:", formatMoney(order.service_fee)));

  if (order.order_type === "delivery" && Number(order.delivery_fee) > 0) {
    lines.push(formatReceiptLine("Delivery Fee:", formatMoney(order.delivery_fee)));
  }
  if (Number(order.discount_amount) > 0) {
    lines.push(formatReceiptLine(`Discount (${order.discount_percentage}%):`, `-${formatMoney(order.discount_amount)}`));
  }
  if (Number(order.tip_amount) > 0) {
    lines.push(formatReceiptLine("Tip:", formatMoney(order.tip_amount)));
  }

  lines.push(formatReceiptLine("TOTAL:", formatMoney(order.total_amount)));
  lines.push("");
  lines.push("    Powered by DirectBite.co");
  lines.push("");

  return lines.join("\n");
}

// ---------- PrintNode integration ----------
async function triggerPrint(orderId: string, restaurantId: string) {
  // Fetch restaurant printer ID
  const { data: restaurant, error: restErr } = await supabase
    .from("restaurants")
    .select("printnode_printer_id, name, phone, address")
    .eq("id", restaurantId)
    .single();

  if (restErr || !restaurant?.printnode_printer_id) {
    console.error("No printer configured for restaurant:", restaurantId);
    await supabase
      .from("orders")
      .update({ print_status: "failed", print_attempts: 1 })
      .eq("id", orderId);

    await supabase.from("print_logs").insert({
      order_id: orderId,
      restaurant_id: restaurantId,
      attempt_number: 1,
      status: "failed",
      error_message: "No printer configured",
    });
    return;
  }

  // Fetch order with items and toppings
  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (!order) {
    console.error("Order not found:", orderId);
    return;
  }

  const { data: items } = await supabase
    .from("order_items")
    .select("*, order_item_toppings(*)")
    .eq("order_id", orderId)
    .order("created_at");

  // Format receipt
  const receiptText = formatReceipt(order, restaurant, items || []);
  const receiptBase64 = base64Encode(new TextEncoder().encode(receiptText));

  // Send to PrintNode
  const attemptNumber = (order.print_attempts || 0) + 1;

  try {
    const response = await fetch("https://api.printnode.com/printjobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + base64Encode(new TextEncoder().encode(printNodeApiKey + ":")),
      },
      body: JSON.stringify({
        printerId: parseInt(restaurant.printnode_printer_id),
        title: `DirectBite Order #${order.order_number}`,
        contentType: "raw_base64",
        content: receiptBase64,
        source: "DirectBite",
      }),
    });

    if (response.ok) {
      console.log(`Print job sent for order #${order.order_number}`);

      await supabase
        .from("orders")
        .update({ print_status: "printed", print_attempts: attemptNumber })
        .eq("id", orderId);

      await supabase.from("print_logs").insert({
        order_id: orderId,
        order_number: order.order_number,
        restaurant_id: restaurantId,
        attempt_number: attemptNumber,
        status: "success",
      });
    } else {
      const errorText = await response.text();
      console.error(`PrintNode error: ${response.status} — ${errorText}`);

      await supabase
        .from("orders")
        .update({ print_status: "failed", print_attempts: attemptNumber, last_print_attempt: new Date().toISOString() })
        .eq("id", orderId);

      await supabase.from("print_logs").insert({
        order_id: orderId,
        order_number: order.order_number,
        restaurant_id: restaurantId,
        attempt_number: attemptNumber,
        status: "failed",
        error_message: `PrintNode ${response.status}: ${errorText.slice(0, 200)}`,
      });
    }
  } catch (err: any) {
    console.error("PrintNode request failed:", err.message);

    await supabase
      .from("orders")
      .update({ print_status: "failed", print_attempts: attemptNumber, last_print_attempt: new Date().toISOString() })
      .eq("id", orderId);

    await supabase.from("print_logs").insert({
      order_id: orderId,
      order_number: order.order_number,
      restaurant_id: restaurantId,
      attempt_number: attemptNumber,
      status: "failed",
      error_message: err.message,
    });
  }
}

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

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
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

        // Trigger print job
        await triggerPrint(order.id, orderData.restaurant_id);

        // Send confirmation email
        await sendConfirmationEmail(order.id);

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
