import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";

const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatMoney(amount: number): string {
  return `$${Number(amount).toFixed(2)}`;
}

function buildConfirmationHtml(order: any, restaurant: any, items: any[]): string {
  let itemsHtml = "";
  for (const item of items) {
    const toppingsSum = (item.order_item_toppings || []).reduce((s: number, t: any) => s + Number(t.price_charged || 0), 0);
    const lineTotal = (Number(item.base_price) + toppingsSum) * (item.quantity || 1);
    itemsHtml += `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
          <strong>${item.quantity}x ${item.item_name}${item.size_name ? ` (${item.size_name})` : ""}</strong>
          <span style="float:right;font-weight:bold;">${formatMoney(lineTotal)}</span>
    `;

    const qty = item.quantity || 1;
    for (const t of item.order_item_toppings || []) {
      if (t.placement_type === "addon") {
        const priceStr = Number(t.price_charged) === 0 ? "Free" : `+${formatMoney(t.price_charged)}${qty > 1 ? " ea" : ""}`;
        itemsHtml += `<br><span style="padding-left:16px;color:#6b7280;font-weight:normal;">${t.topping_name} ${priceStr}</span>`;
      } else {
        const placement = t.placement.toUpperCase();
        const priceStr = Number(t.price_charged) === 0 ? "Free" : `+${formatMoney(t.price_charged)}${qty > 1 ? " ea" : ""}`;
        itemsHtml += `<br><span style="padding-left:16px;color:#6b7280;font-weight:normal;">${placement}: ${t.topping_name} ${priceStr}</span>`;
      }
    }

    if (item.special_instructions) {
      itemsHtml += `<br><span style="padding-left:16px;color:#9ca3af;font-style:italic;font-weight:normal;">${item.special_instructions}</span>`;
    }

    itemsHtml += `
        </td>
      </tr>
    `;
  }

  if (order.include_utensils) {
    itemsHtml += `<tr><td style="padding:8px 0;color:#16a34a;font-weight:500;">✓ Include napkins & utensils</td></tr>`;
  }

  const estimatedTime = order.order_type === "delivery"
    ? `${restaurant.estimated_delivery_minutes || 60} minutes`
    : `${restaurant.estimated_pickup_minutes || 30} minutes`;

  let pricingHtml = `
    <tr><td style="padding:4px 0;color:#6b7280;">Subtotal</td><td style="text-align:right;padding:4px 0;">${formatMoney(order.subtotal)}</td></tr>
  `;

  if (Number(order.discount_amount) > 0) {
    pricingHtml += `<tr><td style="padding:4px 0;color:#16a34a;">Discount (${order.discount_percentage}%)</td><td style="text-align:right;padding:4px 0;color:#16a34a;">-${formatMoney(order.discount_amount)}</td></tr>`;
  }

  if (order.order_type === "delivery" && Number(order.delivery_fee) > 0) {
    pricingHtml += `<tr><td style="padding:4px 0;color:#6b7280;">Delivery Fee</td><td style="text-align:right;padding:4px 0;">${formatMoney(order.delivery_fee)}</td></tr>`;
  }

  pricingHtml += `
    <tr><td style="padding:4px 0;color:#6b7280;">Tax</td><td style="text-align:right;padding:4px 0;">${formatMoney(order.tax_amount)}</td></tr>
  `;

  if (Number(order.tip_amount) > 0) {
    pricingHtml += `<tr><td style="padding:4px 0;color:#6b7280;">Tip</td><td style="text-align:right;padding:4px 0;">${formatMoney(order.tip_amount)}</td></tr>`;
  }

  pricingHtml += `
    <tr><td style="padding:4px 0;color:#6b7280;">Service Fee</td><td style="text-align:right;padding:4px 0;">${formatMoney(order.service_fee)}</td></tr>
    <tr><td style="padding:8px 0;font-weight:bold;font-size:16px;border-top:2px solid #e5e7eb;">Total</td><td style="text-align:right;padding:8px 0;font-weight:bold;font-size:16px;border-top:2px solid #e5e7eb;">${formatMoney(order.total_amount)}</td></tr>
  `;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>@media (prefers-color-scheme: dark) { .logo-dark { filter: none !important; } }</style></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px;">
    <!-- Header -->
    <div style="text-align:center;padding:24px 0;">
      <img src="https://directbite.co/directbite-logo-lockup.png" alt="DirectBite" style="height:28px;filter:brightness(0) invert(0.24);" class="logo-dark" />
    </div>

    <!-- Card -->
    <div style="background:white;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <!-- Heading -->
      <h1 style="color:#16a34a;font-size:24px;margin:0 0 8px 0;text-align:center;">Order Confirmed!</h1>
      <p style="color:#6b7280;text-align:center;margin:0 0 24px 0;">Thank you, ${order.customer_name}!</p>

      <!-- Order info -->
      <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Order Number</td>
            <td style="text-align:right;font-weight:bold;">#${order.order_number}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Restaurant</td>
            <td style="text-align:right;font-weight:bold;">${restaurant.name}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Order Type</td>
            <td style="text-align:right;font-weight:bold;">${order.order_type === "delivery" ? "Delivery" : "Pickup"}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Estimated Time</td>
            <td style="text-align:right;font-weight:bold;">${estimatedTime}</td>
          </tr>
        </table>
      </div>

      ${order.delivery_address ? `
      <div style="background:#eff6ff;border-radius:8px;padding:12px 16px;margin-bottom:24px;">
        <p style="margin:0;color:#1e40af;font-size:14px;"><strong>Delivery to:</strong> ${order.delivery_address}</p>
      </div>
      ` : ""}

      <!-- Items -->
      <h3 style="margin:0 0 12px 0;font-size:16px;color:#111827;">Your Order</h3>
      <table style="width:100%;border-collapse:collapse;">
        ${itemsHtml}
      </table>

      <!-- Pricing -->
      <div style="margin-top:16px;">
        <table style="width:100%;border-collapse:collapse;">
          ${pricingHtml}
        </table>
      </div>

      ${restaurant.phone ? `
      <!-- Contact -->
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;">
        <p style="color:#6b7280;font-size:14px;margin:0;">Questions? Call <a href="tel:${restaurant.phone}" style="color:#16a34a;text-decoration:none;font-weight:bold;">${restaurant.phone}</a></p>
      </div>
      ` : ""}
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:24px 0;">
      <p style="color:#9ca3af;font-size:12px;margin:0;">Powered by <span style="font-weight:bold;">DirectBite</span></p>
    </div>
  </div>
</body>
</html>
  `;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { order_id } = await req.json();

    if (!order_id) {
      return new Response(
        JSON.stringify({ error: "order_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!resendApiKey) {
      console.error("RESEND_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

    // Fetch restaurant
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select("*")
      .eq("id", order.restaurant_id)
      .single();

    if (!restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurant not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch order items with toppings
    const { data: items } = await supabase
      .from("order_items")
      .select("*, order_item_toppings(*)")
      .eq("order_id", order_id)
      .order("created_at");

    // Build email
    const html = buildConfirmationHtml(order, restaurant, items || []);

    // Send via Resend
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "DirectBite <orders@directbite.co>",
        to: [order.customer_email],
        subject: `Your order at ${restaurant.name} is confirmed! 🍕`,
        html,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Resend error:", errText);
      return new Response(
        JSON.stringify({ error: `Email send failed: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await response.json();
    console.log(`Confirmation email sent to ${order.customer_email} — Resend ID: ${result.id}`);

    return new Response(
      JSON.stringify({ success: true, resend_id: result.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("send-confirmation-email error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
