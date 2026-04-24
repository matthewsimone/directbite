import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { encode as base64Encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const twilioPhone = Deno.env.get("TWILIO_PHONE_NUMBER") || "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}

function formatMoney(amount: number): string {
  return `$${Number(amount || 0).toFixed(2)}`;
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

    // Fetch restaurant with slug
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select("id, name, slug, sms_enabled, sms_phone, estimated_pickup_minutes")
      .eq("id", order.restaurant_id)
      .single();

    if (!restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurant not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if SMS is enabled
    if (!restaurant.sms_enabled || !restaurant.sms_phone) {
      return new Response(
        JSON.stringify({ skipped: true, message: "SMS alerts not enabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!twilioSid || !twilioToken || !twilioPhone) {
      console.error("Twilio credentials not configured");
      return new Response(
        JSON.stringify({ error: "Twilio not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build SMS message
    const orderType = order.order_type.toUpperCase();
    const tabletUrl = `directbite.co/${restaurant.slug}/tablet`;

    let message = `New ${orderType} order #${order.order_number}\n`;
    message += `${formatMoney(order.total_amount)} - ${order.customer_name} - ${formatPhone(order.customer_phone)}\n`;

    if (order.order_type === "delivery" && order.delivery_address) {
      message += `${order.delivery_address}\n`;
    }

    message += `Open: ${tabletUrl}`;

    // Send via Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
    const auth = base64Encode(new TextEncoder().encode(`${twilioSid}:${twilioToken}`));

    const twilioRes = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: twilioPhone,
        To: restaurant.sms_phone,
        Body: message,
      }),
    });

    const twilioData = await twilioRes.json();
    const success = twilioRes.ok;

    // Log to sms_logs
    await supabase.from("sms_logs").insert({
      order_id,
      restaurant_id: restaurant.id,
      to_phone: restaurant.sms_phone,
      message,
      status: success ? "sent" : "failed",
      twilio_sid: twilioData.sid || null,
      error: success ? null : (twilioData.message || JSON.stringify(twilioData)),
    });

    if (success) {
      console.log(`SMS sent to ${restaurant.sms_phone} for order #${order.order_number}`);
      return new Response(
        JSON.stringify({ success: true, twilio_sid: twilioData.sid }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      console.error(`SMS failed for order #${order.order_number}:`, twilioData.message);
      return new Response(
        JSON.stringify({ success: false, error: twilioData.message }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (err: any) {
    console.error("send-order-sms error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
