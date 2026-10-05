// ============================================================================
// kh-webhook — Process KitchenHub DSP order webhooks
// ============================================================================
//
// Receives order events (DoorDash / Grubhub / Uber Eats via KitchenHub) and
// upserts them into public.external_orders. Every authenticated delivery is
// first captured in public.external_order_events as an audit trail / replay
// source, then normalized and routed to a restaurant via kitchenhub_stores.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// KitchenHub authenticates with a static shared-secret header
// (x-ordr-kh-secret), compared constant-time against the
// KITCHENHUB_WEBHOOK_SECRET env var. Handler refuses any request without it.
//
// Flow:
//   1. CORS preflight + method check (POST only).
//   2. Shared-secret check BEFORE reading/parsing the body.
//   3. Read raw body via req.text(); JSON.parse. 400 on failure.
//   4. Insert external_order_events row (always). 500 on failure.
//   5. Non-'Order' events → mark processed, 200.
//   6. extractOrder + isSafeOrderId. Bad shape → event error, 200.
//   7. kitchenhub_stores lookup (enabled). Unmapped → event error, 200.
//   8. Read existing status; resolveStatus (forward-only, cancel wins).
//   9. Upsert external_orders on kh_order_id. Tablet-owned columns are
//      absent from the row object so they are never overwritten.
//  10. Mark event processed, 200 + empty body.
//
// Error response shapes (all bodies empty):
//   - 405: non-POST
//   - 401: missing / wrong secret header
//   - 400: body read or JSON parse failure
//   - 500: secret env missing, event insert failed, lookup/upsert failed
//          (KitchenHub retries; the upsert is idempotent)
//   - 200: success, non-Order event, bad shape, unmapped store
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { timingSafeStringEqual } from "../_shared/uberSignature.ts";
import {
  extractOrder,
  normalizeStatus,
  parseOrderId,
  resolveStatus,
  toRow,
} from "../_shared/khNormalize.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ordr-kh-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Columns omitted from the upsert when the incoming event has them null, so
// an event that leaves them out never clears a previously stored value.
const PRESERVE_ON_NULL = [
  "accepted_at",
  "completed_at",
  "cancelled_at",
  "cancelled_by",
  "prep_time_minutes",
  "scheduled_for",
  "pickup_at",
  "delivery_type",
  "customer_phone",
  "customer_phone_code",
] as const;

function ackResponse(): Response {
  return new Response(null, { status: 200, headers: corsHeaders });
}

function errorResponse(status: number): Response {
  return new Response(null, { status, headers: corsHeaders });
}

// Best-effort event bookkeeping. A failure here is logged but never changes
// the response — the order write (or deliberate drop) already happened.
async function markEvent(
  eventId: number | string,
  fields: { processed?: boolean; error?: string },
): Promise<void> {
  const { error } = await supabase
    .from("external_order_events")
    .update(fields)
    .eq("id", eventId);
  if (error) {
    console.error("[kh-webhook] event update failed", {
      event_id: eventId,
      fields,
      error,
    });
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse(405);
  }

  // -------- Step 2: shared-secret auth (before touching the body) --------
  const expectedSecret = Deno.env.get("KITCHENHUB_WEBHOOK_SECRET");
  if (!expectedSecret) {
    console.error("[kh-webhook] secret_not_configured");
    return errorResponse(500);
  }
  const providedSecret = req.headers.get("x-ordr-kh-secret");
  if (!providedSecret || !timingSafeStringEqual(providedSecret, expectedSecret)) {
    // Never log the header value.
    console.warn("[kh-webhook] rejected: missing or invalid secret header", {
      header_present: !!providedSecret,
    });
    return errorResponse(401);
  }

  // -------- Step 3: read + parse body --------
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("[kh-webhook] failed to read request body", err);
    return errorResponse(400);
  }
  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    // No JSON → nothing structured to store in external_order_events.
    console.error("[kh-webhook] failed to parse JSON body", {
      error: String(err),
      body_length: rawBody.length,
    });
    return errorResponse(400);
  }

  const eventType: string | null =
    payload?.event_data?.event_type ?? payload?.event_data?.webhook_type ?? null;
  const eventStatus: string | null =
    payload?.event_data?.status ?? payload?.event_data?.event_name ?? null;

  // -------- Step 4: audit insert (always) --------
  const rawOrderId = payload?.order?.order?.id ?? payload?.order?.id;
  const rawStoreId = payload?.order?.store?.id ?? payload?.store?.id ?? null;
  const { data: eventRow, error: eventErr } = await supabase
    .from("external_order_events")
    .insert({
      kh_order_id: parseOrderId(rawOrderId),
      kh_store_id: rawStoreId,
      event_type: eventType,
      event_status: eventStatus,
      payload,
    })
    .select("id")
    .single();
  if (eventErr || !eventRow) {
    console.error("[kh-webhook] event insert failed", {
      error: eventErr,
      event_type: eventType,
      kh_order_id: rawOrderId ?? null,
    });
    return errorResponse(500);
  }
  const eventId = eventRow.id;

  // -------- Step 5: non-order events --------
  if (eventType !== "Order") {
    console.log("[kh-webhook] non-order event acknowledged", {
      event_id: eventId,
      event_type: eventType,
      event_status: eventStatus,
    });
    await markEvent(eventId, { processed: true });
    return ackResponse();
  }

  // -------- Step 6: shape + id validation --------
  const o = extractOrder(payload);
  if (!o) {
    console.warn("[kh-webhook] dropped: bad_shape", { event_id: eventId });
    await markEvent(eventId, { error: "bad_shape" });
    return ackResponse();
  }
  const khOrderId = parseOrderId(o.order?.id);
  if (khOrderId === null) {
    console.warn("[kh-webhook] dropped: unsafe_order_id", {
      event_id: eventId,
      kh_order_id: o.order?.id ?? null,
    });
    await markEvent(eventId, { error: "unsafe_order_id" });
    return ackResponse();
  }
  const khStoreId = o.store?.id ?? null;

  // -------- Step 7: route to restaurant --------
  const { data: store, error: storeErr } = await supabase
    .from("kitchenhub_stores")
    .select("restaurant_id")
    .eq("kh_store_id", khStoreId)
    .eq("enabled", true)
    .maybeSingle();
  if (storeErr) {
    console.error("[kh-webhook] store lookup failed", {
      event_id: eventId,
      kh_store_id: khStoreId,
      error: storeErr,
    });
    await markEvent(eventId, { error: "store_lookup_failed" });
    return errorResponse(500);
  }
  if (!store) {
    console.warn("[kh-webhook] dropped: unmapped_store", {
      event_id: eventId,
      kh_store_id: khStoreId,
      kh_order_id: khOrderId,
    });
    await markEvent(eventId, { error: "unmapped_store", processed: true });
    return ackResponse();
  }

  // -------- Step 8: forward-only status --------
  const { data: existing, error: existingErr } = await supabase
    .from("external_orders")
    .select("status")
    .eq("kh_order_id", khOrderId)
    .maybeSingle();
  if (existingErr) {
    console.error("[kh-webhook] existing order lookup failed", {
      event_id: eventId,
      kh_order_id: khOrderId,
      error: existingErr,
    });
    await markEvent(eventId, { error: "existing_lookup_failed" });
    return errorResponse(500);
  }
  const incoming = normalizeStatus(o.order?.status);
  const status = resolveStatus(existing?.status, incoming);

  // -------- Step 9: upsert --------
  const row = toRow(o);
  row.kh_order_id = khOrderId;
  // provider_id is NOT NULL; a missing provider must never fail the insert.
  row.provider_id = row.provider_id ?? "unknown";
  // Preserve-on-null: an upsert only updates the columns present, so drop
  // these when null and a later event that omits them never wipes a value
  // already stored. On first insert they default to null.
  for (const key of PRESERVE_ON_NULL) {
    if (row[key] === null) delete row[key];
  }
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await supabase
    .from("external_orders")
    .upsert(
      {
        ...row,
        restaurant_id: store.restaurant_id,
        status,
        raw: payload,
        last_event_at: nowIso,
        updated_at: nowIso,
      },
      { onConflict: "kh_order_id" },
    );
  if (upsertErr) {
    console.error("[kh-webhook] external_orders upsert failed", {
      event_id: eventId,
      kh_order_id: khOrderId,
      error: upsertErr,
    });
    await markEvent(eventId, { error: `upsert_failed: ${upsertErr.message}` });
    return errorResponse(500);
  }

  // -------- Step 10: acknowledge --------
  console.log("[kh-webhook] order upserted", {
    event_id: eventId,
    kh_order_id: khOrderId,
    restaurant_id: store.restaurant_id,
    existing_status: existing?.status ?? null,
    incoming_status: incoming,
    status,
    provider: o.provider?.name ?? null,
  });
  await markEvent(eventId, { processed: true });
  return ackResponse();
});
