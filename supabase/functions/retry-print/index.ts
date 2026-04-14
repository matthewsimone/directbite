import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { encode as base64Encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

const printNodeApiKey = Deno.env.get("PRINTNODE_API_KEY") || "";
const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const twilioPhone = Deno.env.get("TWILIO_PHONE_NUMBER") || "";
const directbitePhone = Deno.env.get("DIRECTBITE_PHONE_NUMBER") || "";
const directbiteEmail = Deno.env.get("DIRECTBITE_EMAIL") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  lines.push(sep);
  lines.push(formatReceiptLine("Subtotal:", formatMoney(order.subtotal)));

  if (Number(order.discount_amount) > 0) {
    lines.push(formatReceiptLine(`Discount (${order.discount_percentage}%):`, `-${formatMoney(order.discount_amount)}`));
  }
  if (order.order_type === "delivery" && Number(order.delivery_fee) > 0) {
    lines.push(formatReceiptLine("Delivery Fee:", formatMoney(order.delivery_fee)));
  }

  lines.push(formatReceiptLine("Tax:", formatMoney(order.tax_amount)));

  if (Number(order.tip_amount) > 0) {
    lines.push(formatReceiptLine("Tip:", formatMoney(order.tip_amount)));
  }

  lines.push(formatReceiptLine("Service Fee:", formatMoney(order.service_fee)));
  lines.push(formatReceiptLine("TOTAL:", formatMoney(order.total_amount)));
  lines.push("");
  lines.push("    Powered by DirectBite.co");
  lines.push("");

  return lines.join("\n");
}

// ---------- Send SMS via Twilio ----------
async function sendSms(to: string, message: string) {
  if (!twilioSid || !twilioToken || !twilioPhone) {
    console.error("Twilio not configured, skipping SMS");
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const auth = base64Encode(new TextEncoder().encode(`${twilioSid}:${twilioToken}`));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: twilioPhone,
        To: to,
        Body: message,
      }),
    });

    if (!response.ok) {
      console.error("Twilio SMS error:", await response.text());
    }
  } catch (err: any) {
    console.error("Twilio SMS failed:", err.message);
  }
}

// ---------- Send email via Resend ----------
async function sendAlertEmail(to: string[], subject: string, htmlBody: string) {
  if (!resendApiKey) {
    console.error("Resend not configured, skipping email");
    return;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "DirectBite <orders@directbite.co>",
        to,
        subject,
        html: htmlBody,
      }),
    });

    if (!response.ok) {
      console.error("Resend email error:", await response.text());
    }
  } catch (err: any) {
    console.error("Resend email failed:", err.message);
  }
}

// ---------- Build failure alert email ----------
function buildFailureEmailHtml(order: any, restaurant: any, items: any[]): string {
  let itemsHtml = "";
  for (const item of items) {
    itemsHtml += `<p><strong>${item.quantity}x ${item.item_name}${item.size_name ? ` (${item.size_name})` : ""}</strong> — ${formatMoney(item.base_price * item.quantity)}</p>`;
    for (const t of item.order_item_toppings || []) {
      if (t.placement_type === "addon") {
        const priceStr = Number(t.price_charged) === 0 ? "Free" : `+${formatMoney(t.price_charged)}`;
        itemsHtml += `<p style="padding-left:20px;color:#666;">${t.topping_name} ${priceStr}</p>`;
      } else {
        const placement = t.placement === "whole" ? "" : `${t.placement.toUpperCase()}: `;
        itemsHtml += `<p style="padding-left:20px;color:#666;">${placement}${t.topping_name} +${formatMoney(t.price_charged)}</p>`;
      }
    }
    if (item.special_instructions) {
      itemsHtml += `<p style="padding-left:20px;color:#999;font-style:italic;">${item.special_instructions}</p>`;
    }
  }

  return `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
      <h2 style="color:#dc2626;">⚠️ Print Failed</h2>
      <p>Order <strong>#${order.order_number}</strong> at <strong>${restaurant.name}</strong> failed to print after 3 attempts.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
      <p><strong>Customer:</strong> ${order.customer_name}</p>
      <p><strong>Phone:</strong> ${order.customer_phone}</p>
      <p><strong>Type:</strong> ${order.order_type.toUpperCase()}</p>
      ${order.delivery_address ? `<p><strong>Address:</strong> ${order.delivery_address}</p>` : ""}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
      <h3>Items</h3>
      ${itemsHtml}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
      <p>Subtotal: ${formatMoney(order.subtotal)}</p>
      ${Number(order.discount_amount) > 0 ? `<p>Discount (${order.discount_percentage}%): -${formatMoney(order.discount_amount)}</p>` : ""}
      ${order.order_type === "delivery" && Number(order.delivery_fee) > 0 ? `<p>Delivery Fee: ${formatMoney(order.delivery_fee)}</p>` : ""}
      <p>Tax: ${formatMoney(order.tax_amount)}</p>
      ${Number(order.tip_amount) > 0 ? `<p>Tip: ${formatMoney(order.tip_amount)}</p>` : ""}
      <p>Service Fee: ${formatMoney(order.service_fee)}</p>
      <p><strong>Total: ${formatMoney(order.total_amount)}</strong></p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
      <p style="color:#999;font-size:12px;">Please check the printer and reprint from the tablet interface.</p>
    </div>
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

    if (!restaurant?.printnode_printer_id) {
      return new Response(
        JSON.stringify({ error: "No printer configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch order items with toppings
    const { data: items } = await supabase
      .from("order_items")
      .select("*, order_item_toppings(*)")
      .eq("order_id", order_id)
      .order("created_at");

    // Format receipt and attempt print
    const receiptText = formatReceipt(order, restaurant, items || []);
    const receiptBase64 = base64Encode(new TextEncoder().encode(receiptText));
    const attemptNumber = (order.print_attempts || 0) + 1;

    let printSuccess = false;
    let errorMessage = "";

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
        printSuccess = true;
      } else {
        errorMessage = `PrintNode ${response.status}: ${(await response.text()).slice(0, 200)}`;
      }
    } catch (err: any) {
      errorMessage = err.message;
    }

    // Record attempt
    await supabase.from("print_logs").insert({
      order_id,
      order_number: order.order_number,
      restaurant_id: order.restaurant_id,
      attempt_number: attemptNumber,
      status: printSuccess ? "success" : "failed",
      error_message: printSuccess ? null : errorMessage,
    });

    if (printSuccess) {
      await supabase
        .from("orders")
        .update({ print_status: "printed", print_attempts: attemptNumber })
        .eq("id", order_id);

      return new Response(
        JSON.stringify({ success: true, message: "Print job sent" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update failed status
    await supabase
      .from("orders")
      .update({ print_status: "failed", print_attempts: attemptNumber, last_print_attempt: new Date().toISOString() })
      .eq("id", order_id);

    // If 3+ total attempts, send failure alerts
    if (attemptNumber >= 3) {
      console.log(`Print permanently failed for order #${order.order_number} after ${attemptNumber} attempts — sending alerts`);

      const smsMessage = `⚠️ Print failed for Order #${order.order_number} at ${restaurant.name}. Please check the printer.`;
      const emailSubject = `⚠️ Print Failed — Order #${order.order_number} at ${restaurant.name}`;
      const emailHtml = buildFailureEmailHtml(order, restaurant, items || []);

      // Send SMS to DirectBite and restaurant
      const smsTargets = [directbitePhone];
      if (restaurant.phone) smsTargets.push(restaurant.phone);

      await Promise.all(smsTargets.filter(Boolean).map(phone => sendSms(phone, smsMessage)));

      // Send email to DirectBite and restaurant tablet email
      const emailTargets = [directbiteEmail];
      if (restaurant.tablet_email) emailTargets.push(restaurant.tablet_email);

      await sendAlertEmail(emailTargets.filter(Boolean), emailSubject, emailHtml);
    }

    return new Response(
      JSON.stringify({ success: false, message: errorMessage, attempts: attemptNumber }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("retry-print error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
