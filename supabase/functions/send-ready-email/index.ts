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

// "2:31 PM" — time only. Hardcoded America/New_York for the same reason as
// send-confirmation-email: edge functions run in UTC and all current
// restaurants are in NJ.
function formatTimeShort(isoString: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(isoString));
}

// TODAY / TOMORROW / "THU 5/7", relative to Eastern.
function formatDayLabel(isoString: string): string {
  const tz = "America/New_York";
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" };
  const fmt = new Intl.DateTimeFormat("en-US", opts);
  const target = fmt.format(new Date(isoString));
  const now = new Date();
  if (fmt.format(now) === target) return "TODAY";
  const tomorrow = new Date(now.getTime() + 86400000);
  if (fmt.format(tomorrow) === target) return "TOMORROW";
  const dayShort = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(isoString));
  const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric" }).format(new Date(isoString));
  return `${dayShort.toUpperCase()} ${monthDay}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildReadyHtml(order: any, restaurant: any, isDelivery: boolean): string {
  const time = formatTimeShort(order.quoted_for);
  const day = formatDayLabel(order.quoted_for);
  const name = escapeHtml(restaurant.name || "");
  const phone = escapeHtml(restaurant.phone || "");
  const heading = isDelivery ? "Your order is on the way" : "Get ready for pickup";
  const lead = isDelivery
    ? `Your order from ${name} will arrive around:`
    : `Your order from ${name} will be ready for pickup around:`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px 24px;">
        <tr><td style="text-align:center;">
          <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#111827;">${heading}</h1>
          <p style="margin:0 0 8px;font-size:15px;color:#4b5563;line-height:1.5;">${lead}</p>
          <p style="margin:0 0 24px;font-size:30px;font-weight:700;color:#16A34A;line-height:1.2;">${time} ${day}</p>
          <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Order #${escapeHtml(String(order.order_number || ""))}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px;" />
          <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Need help? Contact</p>
          <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#111827;">${name}</p>
          <p style="margin:0;font-size:14px;color:#4b5563;">${phone}</p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">powered by Ordr</p>
    </td></tr>
  </table>
</body></html>`;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { order_id } = await req.json();

    if (!order_id) {
      return new Response(
        JSON.stringify({ error: "order_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!resendApiKey) {
      console.error("RESEND_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Email not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

    // --- Guards. All server-side so any future caller inherits them. ---
    // Every guard returns 200 with skipped:true rather than an error: the
    // tablet fires this and forgets, and a skip is a normal outcome, not a
    // failure the operator should ever see.

    if (!restaurant.ready_time_confirmation_enabled) {
      return new Response(
        JSON.stringify({ success: true, skipped: "flag_off" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (order.delivery_fulfillment_method === "uber_direct") {
      return new Response(
        JSON.stringify({ success: true, skipped: "uber_direct" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (order.scheduled_for) {
      return new Response(
        JSON.stringify({ success: true, skipped: "scheduled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!order.quoted_for) {
      return new Response(
        JSON.stringify({ success: true, skipped: "no_quote" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (order.ready_email_sent_at) {
      return new Response(
        JSON.stringify({ success: true, skipped: "already_sent" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!order.customer_email) {
      return new Response(
        JSON.stringify({ success: true, skipped: "no_email" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isDelivery = order.order_type === "delivery";
    const time = formatTimeShort(order.quoted_for);
    const html = buildReadyHtml(order, restaurant, isDelivery);

    // RFC 5322 display name: always quoted, with internal " and \ escaped.
    // Same reasoning as send-confirmation-email — an unquoted name with a
    // comma splits the header and Resend rejects the send.
    const senderName = `"${String(restaurant.name || "Ordr").replace(/[\\"]/g, "\\$&")}"`;

    const subject = isDelivery
      ? `Your ${restaurant.name} order will arrive around ${time}`
      : `Your ${restaurant.name} order will be ready around ${time}`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${senderName} <orders@ordr.co>`,
        to: [order.customer_email],
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

    // Stamp AFTER a confirmed send. If this write fails the email already
    // went out and a retry would duplicate it — but a duplicate ready email
    // is far less harmful than a silent never-sent one, and the tablet does
    // not retry this call anyway.
    const { error: stampErr } = await supabase
      .from("orders")
      .update({ ready_email_sent_at: new Date().toISOString() })
      .eq("id", order_id);

    if (stampErr) {
      console.error("ready_email_sent_at stamp failed:", stampErr.message);
    }

    console.log(`Ready email sent to ${order.customer_email} — Resend ID: ${result.id}`);

    return new Response(
      JSON.stringify({ success: true, resend_id: result.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("send-ready-email error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
