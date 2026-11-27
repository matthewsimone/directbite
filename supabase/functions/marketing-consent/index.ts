import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";

// marketing-consent — records a customer's restaurant marketing choices
// (SMS / email) after checkout. Addresses come ONLY from the order the
// Stripe webhook wrote, never from the request. Writes only to
// marketing_consents and marketing_consent_events.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SOURCES = ["checkout_web", "checkout_app"] as const;
type Source = typeof SOURCES[number];
type Channel = "sms" | "email";

const ORDER_LOOKUP_ATTEMPTS = 10;
const ORDER_LOOKUP_DELAY_MS = 1000;
const MAX_ORDER_AGE_MS = 24 * 60 * 60 * 1000;

interface OrderRow {
  restaurant_id: string;
  customer_id: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  phone_e164: string | null;
  created_at: string;
}

interface ConsentRow {
  id: string;
  status: "subscribed" | "unsubscribed";
  customer_id: string | null;
}

interface EventContext {
  source: Source;
  policyVersion: string;
  orderRef: string;
  ip: string | null;
  userAgent: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function phoneFromOrder(order: OrderRow): string | null {
  if (isNonEmptyString(order.phone_e164)) return order.phone_e164.trim();
  const digits = (order.customer_phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return null;
}

function emailFromOrder(order: OrderRow): string | null {
  const email = (order.customer_email || "").trim().toLowerCase();
  return email.includes("@") ? email : null;
}

async function findOrder(paymentIntentId: string): Promise<OrderRow | null> {
  for (let attempt = 1; attempt <= ORDER_LOOKUP_ATTEMPTS; attempt++) {
    const { data, error } = await supabase
      .from("orders")
      .select("restaurant_id, customer_id, customer_phone, customer_email, phone_e164, created_at")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (error) throw new Error(`order lookup: ${error.message}`);
    if (data) return data as OrderRow;
    if (attempt < ORDER_LOOKUP_ATTEMPTS) await sleep(ORDER_LOOKUP_DELAY_MS);
  }
  return null;
}

async function selectConsent(
  restaurantId: string,
  channel: Channel,
  address: string,
): Promise<ConsentRow | null> {
  const { data, error } = await supabase
    .from("marketing_consents")
    .select("id, status, customer_id")
    .eq("restaurant_id", restaurantId)
    .eq("channel", channel)
    .eq("address", address)
    .maybeSingle();
  if (error) throw new Error(`consent select: ${error.message}`);
  return (data as ConsentRow) ?? null;
}

async function insertEvent(
  consentId: string,
  action: "opt_in" | "opt_out",
  textShown: string | null,
  ctx: EventContext,
): Promise<void> {
  const { error } = await supabase.from("marketing_consent_events").insert({
    consent_id: consentId,
    action,
    source: ctx.source,
    text_shown: textShown,
    policy_version: ctx.policyVersion,
    order_ref: ctx.orderRef,
    ip_address: ctx.ip,
    user_agent: ctx.userAgent,
  });
  if (error) throw new Error(`event insert: ${error.message}`);
}

// Subscribe (restaurant, channel, address). Returns "subscribed" when the
// status actually changed (new row, or was 'unsubscribed') — only then is an
// opt_in event written. Already subscribed → "unchanged" (the original
// subscribed_at is kept; a missing customer_id is filled in).
async function subscribe(
  order: OrderRow,
  channel: Channel,
  address: string,
  textShown: string,
  ctx: EventContext,
): Promise<"subscribed" | "unchanged"> {
  const now = new Date().toISOString();
  let existing = await selectConsent(order.restaurant_id, channel, address);

  if (!existing) {
    const { data, error } = await supabase
      .from("marketing_consents")
      .insert({
        restaurant_id: order.restaurant_id,
        channel,
        address,
        status: "subscribed",
        customer_id: order.customer_id ?? null,
        subscribed_at: now,
        unsubscribed_at: null,
        updated_at: now,
      })
      .select("id")
      .single();
    if (!error && data) {
      await insertEvent(data.id, "opt_in", textShown, ctx);
      return "subscribed";
    }
    if (error?.code !== "23505") throw new Error(`consent insert: ${error?.message}`);
    // Lost a race on unique (restaurant_id, channel, address): re-select.
    existing = await selectConsent(order.restaurant_id, channel, address);
    if (!existing) throw new Error("consent insert: unique violation but row not found");
  }

  if (existing.status === "subscribed") {
    if (!existing.customer_id && order.customer_id) {
      const { error } = await supabase
        .from("marketing_consents")
        .update({ customer_id: order.customer_id, updated_at: now })
        .eq("id", existing.id)
        .is("customer_id", null);
      if (error) throw new Error(`consent customer backfill: ${error.message}`);
    }
    return "unchanged";
  }

  // Email: an explicit unsubscribe is never undone by a later order notice.
  if (channel === "email") return "unchanged";

  // Was 'unsubscribed'. Conditional on status so a concurrent request can't
  // flip it twice and write two events.
  const { data: flipped, error } = await supabase
    .from("marketing_consents")
    .update({
      status: "subscribed",
      subscribed_at: now,
      unsubscribed_at: null,
      customer_id: order.customer_id ?? existing.customer_id,
      updated_at: now,
    })
    .eq("id", existing.id)
    .eq("status", "unsubscribed")
    .select("id");
  if (error) throw new Error(`consent resubscribe: ${error.message}`);
  if (!flipped || flipped.length === 0) return "unchanged";
  await insertEvent(existing.id, "opt_in", textShown, ctx);
  return "subscribed";
}

// Unsubscribe only an existing 'subscribed' row. No row → nothing written.
async function unsubscribe(
  order: OrderRow,
  channel: Channel,
  address: string,
  ctx: EventContext,
): Promise<"unsubscribed" | "unchanged"> {
  const existing = await selectConsent(order.restaurant_id, channel, address);
  if (!existing || existing.status !== "subscribed") return "unchanged";

  const now = new Date().toISOString();
  const { data: flipped, error } = await supabase
    .from("marketing_consents")
    .update({ status: "unsubscribed", unsubscribed_at: now, updated_at: now })
    .eq("id", existing.id)
    .eq("status", "subscribed")
    .select("id");
  if (error) throw new Error(`consent unsubscribe: ${error.message}`);
  if (!flipped || flipped.length === 0) return "unchanged";
  await insertEvent(existing.id, "opt_out", null, ctx);
  return "unsubscribed";
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    if (!body || typeof body !== "object") {
      return json(400, { error: "invalid JSON body" });
    }

    const {
      payment_intent_id,
      sms,
      email_opt,
      sms_text,
      email_text,
      policy_version,
      source,
    } = body;

    if (typeof payment_intent_id !== "string" || !payment_intent_id.startsWith("pi_")) {
      return json(400, { error: "payment_intent_id must start with pi_" });
    }
    if (typeof sms !== "boolean" || typeof email_opt !== "boolean") {
      return json(400, { error: "sms and email_opt must be booleans" });
    }
    if (!SOURCES.includes(source)) {
      return json(400, { error: "source must be checkout_web or checkout_app" });
    }
    if (!isNonEmptyString(policy_version)) {
      return json(400, { error: "policy_version is required" });
    }
    if (sms && !isNonEmptyString(sms_text)) {
      return json(400, { error: "sms_text is required when sms is true" });
    }
    if (email_opt && !isNonEmptyString(email_text)) {
      return json(400, { error: "email_text is required when email_opt is true" });
    }
    if (
      (typeof sms_text === "string" && sms_text.length > 2000) ||
      (typeof email_text === "string" && email_text.length > 2000)
    ) {
      return json(400, { error: "text too long" });
    }
    if (policy_version.length > 50) {
      return json(400, { error: "policy_version too long" });
    }

    const order = await findOrder(payment_intent_id);
    if (!order) {
      console.warn("marketing-consent: order not found for", payment_intent_id);
      return json(202, { ok: false, reason: "order_not_found" });
    }
    if (Date.now() - new Date(order.created_at).getTime() > MAX_ORDER_AGE_MS) {
      console.warn("marketing-consent: order too old for", payment_intent_id);
      return json(200, { ok: false, reason: "order_too_old" });
    }

    // Idempotency: any event already recorded for this order → done.
    const { data: prior, error: priorErr } = await supabase
      .from("marketing_consent_events")
      .select("id")
      .eq("order_ref", payment_intent_id)
      .limit(1);
    if (priorErr) throw new Error(`idempotency check: ${priorErr.message}`);
    if (prior && prior.length > 0) {
      return json(200, { ok: true, skipped: "already_processed" });
    }

    const { data: rest } = await supabase.from("restaurants").select("name").eq("id", order.restaurant_id).maybeSingle();
    const restaurantName = (rest as { name?: string } | null)?.name || "this restaurant";
    const fill = (t: string) => t.split("{restaurant}").join(restaurantName);

    const ctx: EventContext = {
      source: source as Source,
      policyVersion: policy_version,
      orderRef: payment_intent_id,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent: req.headers.get("user-agent") || null,
    };

    const phone = phoneFromOrder(order);
    const email = emailFromOrder(order);

    let smsResult: "subscribed" | "unchanged" | "no_phone";
    if (!phone) {
      smsResult = "no_phone";
    } else if (sms) {
      smsResult = await subscribe(order, "sms", phone, fill(sms_text), ctx);
    } else {
      smsResult = "unchanged";
    }

    let emailResult: "subscribed" | "unsubscribed" | "unchanged" | "no_email";
    if (!email) {
      emailResult = "no_email";
    } else if (email_opt) {
      emailResult = await subscribe(order, "email", email, fill(email_text), ctx);
    } else {
      emailResult = await unsubscribe(order, "email", email, ctx);
    }

    return json(200, { ok: true, sms: smsResult, email: emailResult });
  } catch (err: any) {
    console.error("marketing-consent error:", err?.message ?? String(err));
    return json(500, { error: "internal" });
  }
});
