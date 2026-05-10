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

function formatScheduledShort(isoString: string): string {
  const d = new Date(isoString);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (isToday) return `Today ${time}`;
  const dayAbbr = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${dayAbbr} ${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function buildRestaurantHtml(order: any, restaurant: any, items: any[]): string {
  const isScheduled = !!order.scheduled_for;
  const isDelivery = order.order_type === "delivery";
  const orderTypeUpper = isDelivery ? "DELIVERY" : "PICKUP";
  const headingPrefix = isScheduled ? `New SCHEDULED ${orderTypeUpper}` : `New ${orderTypeUpper}`;
  const scheduledTimeLabel = isScheduled ? formatScheduledShort(order.scheduled_for) : null;
  const tabletUrl = `https://directbite.co/${restaurant.slug}/tablet`;

  let itemsHtml = "";
  for (const item of items) {
    const toppingsSum = (item.order_item_toppings || []).reduce(
      (s: number, t: any) => s + Number(t.price_charged || 0), 0
    );
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

  const scheduledRow = isScheduled ? `
    <tr>
      <td style="padding:4px 0;color:#6b7280;font-size:14px;">${isDelivery ? "Delivery" : "Pickup"} Time</td>
      <td style="text-align:right;font-weight:bold;color:#92400e;">${scheduledTimeLabel}</td>
    </tr>
  ` : "";

  const addressRow = isDelivery && order.delivery_address ? `
    <tr>
      <td style="padding:4px 0;color:#6b7280;font-size:14px;">Address</td>
      <td style="text-align:right;font-weight:bold;">${order.delivery_address.replace(/,\s*(USA|United States)\s*$/i, '')}</td>
    </tr>
  ` : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px;">
    <!-- Header -->
    <div style="text-align:center;padding:24px;">
      <img src="https://directbite.co/directbite-logo-lockup.png" alt="DirectBite" style="height:28px;display:block;margin:0 auto;" />
    </div>

    <!-- Card -->
    <div style="background:white;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <h1 style="color:#16a34a;font-size:24px;margin:0 0 4px 0;text-align:center;">${headingPrefix} Order</h1>
      <p style="color:#6b7280;text-align:center;margin:0 0 24px 0;">${restaurant.name}</p>

      ${isScheduled ? `
      <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:24px;text-align:center;">
        <p style="margin:0;color:#92400e;font-size:16px;font-weight:bold;">${isDelivery ? "Delivery" : "Pickup"} Time: ${scheduledTimeLabel}</p>
      </div>
      ` : ""}

      <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Order Number</td>
            <td style="text-align:right;font-weight:bold;">#${order.order_number}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Customer</td>
            <td style="text-align:right;font-weight:bold;">${order.customer_name}, ${order.customer_phone}</td>
          </tr>
          ${addressRow}
          ${scheduledRow}
          <tr>
            <td style="padding:4px 0;color:#6b7280;font-size:14px;">Total</td>
            <td style="text-align:right;font-weight:bold;">${formatMoney(order.total_amount)}</td>
          </tr>
        </table>
      </div>

      ${order.special_instructions ? `
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:24px;">
        <p style="margin:0;color:#92400e;font-size:14px;"><strong>Instructions:</strong> ${order.special_instructions}</p>
      </div>
      ` : ""}

      <h3 style="margin:0 0 12px 0;font-size:16px;color:#111827;">Items</h3>
      <table style="width:100%;border-collapse:collapse;">
        ${itemsHtml}
      </table>

      <div style="margin-top:24px;text-align:center;">
        <a href="${tabletUrl}" style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Open Tablet</a>
      </div>
    </div>

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

    // Skip silently when restaurant has no notification_email configured.
    // This is the on/off switch — empty string saved as null in settings.
    if (!restaurant.notification_email) {
      return new Response(
        JSON.stringify({ skipped: true, message: "No notification_email configured" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!resendApiKey) {
      console.error("RESEND_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: items } = await supabase
      .from("order_items")
      .select("*, order_item_toppings(*)")
      .eq("order_id", order_id)
      .order("created_at");

    const html = buildRestaurantHtml(order, restaurant, items || []);
    const subject = order.scheduled_for
      ? `New Scheduled Order #${order.order_number} — ${restaurant.name}`
      : `New Order #${order.order_number} — ${restaurant.name}`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "DirectBite <orders@directbite.co>",
        to: [restaurant.notification_email],
        subject,
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
    console.log(`Restaurant email sent to ${restaurant.notification_email} for order #${order.order_number} — Resend ID: ${result.id}`);

    return new Response(
      JSON.stringify({ success: true, resend_id: result.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("send-order-restaurant-email error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
