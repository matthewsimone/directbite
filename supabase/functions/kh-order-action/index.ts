// ============================================================================
// kh-order-action — Tablet actions on DSP orders, written back to KitchenHub
// ============================================================================
//
// Called from the tablet's ExternalOrderDetail: Accept (with prep time),
// Mark Ready (KitchenHub 'complete') and Cancel. Sends the status change to
// KitchenHub, then mirrors it onto public.external_orders.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Handler validates auth manually, same pattern as uber-create-delivery:
//   - Authorization: Bearer <tablet user JWT>
//   - getUser() → email; restaurants.tablet_email must match
// All DB access via SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
//
// Flow:
//   1. CORS preflight + method check
//   2. Parse body: { external_order_id, action, prep_time? }
//   3. Authorize tablet user
//   4. Load external_orders row + restaurant (FK join); ownership check
//   5. kitchenhub_stores.enabled for the restaurant
//   6. Status precondition (accept/cancel need 'new', complete needs 'accepted')
//   7. PUT /v2/orders/{kh_order_id}/status/
//   8. 200 → compare-and-set status write (resolveStatus) + timestamps
//      409 → GET the order, sync our row from KitchenHub's status
//      403 → not_main_account
//      other → kitchenhub_error
//
// Response shapes (HTTP 200 unless noted; 4xx for auth / request shape):
//   - { ok: false, error: 'invalid_body' | 'invalid_inputs', detail }    [400]
//   - { ok: false, error: 'missing_auth' | 'invalid_auth' }              [401]
//   - { ok: false, error: 'forbidden' }                                  [403]
//   - { ok: false, error: 'order_not_found' | 'restaurant_not_found' }   [404]
//   - { ok: false, error: 'store_not_enabled' }                          [409]
//   - { ok: false, error: 'invalid_status', status }
//   - { ok: true, status, db_synced }
//   - { ok: false, error: 'conflict', status }
//   - { ok: false, error: 'not_main_account', message }
//   - { ok: false, error: 'kitchenhub_error', http, detail }
//   - { ok: false, error: 'db_error', detail }                           [500]
//
// Never logs or returns KitchenHub tokens.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { normalizeStatus, resolveStatus, type OrderStatus } from "../_shared/khNormalize.ts";
import { khFetch } from "../_shared/khToken.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type Action = "accept" | "complete" | "cancel";
const TARGET: Record<Action, OrderStatus> = {
  accept: "accepted",
  complete: "completed",
  cancel: "cancelled",
};
// DSPs reject cancel after accept, so cancel is only offered on 'new'.
const REQUIRED_STATUS: Record<Action, string> = {
  accept: "new",
  complete: "accepted",
  cancel: "new",
};
const NOT_MAIN_ACCOUNT_MESSAGE =
  "This provider is connected elsewhere (read-only). Disconnect the provider tablet or other integration.";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Compare-and-set status write. Re-reads the current status, resolves it
// forward-only against `target`, and updates only if the row still holds the
// status we read — so a webhook landing mid-request (e.g. a provider cancel)
// is never overwritten. Two attempts; returns the stored status, or null on a
// DB failure. Timestamps are written only when the target status is reached.
async function writeStatus(
  id: string,
  target: OrderStatus,
  stamps: Record<string, unknown>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: cur, error: readErr } = await supabase
      .from("external_orders")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (readErr || !cur) {
      console.error("[kh-order-action] status re-read failed", { id, error: readErr });
      return null;
    }
    const next = resolveStatus(cur.status, target);
    const patch: Record<string, unknown> = {
      status: next,
      updated_at: new Date().toISOString(),
      ...(next === target ? stamps : {}),
    };
    const { data: rows, error } = await supabase
      .from("external_orders")
      .update(patch)
      .eq("id", id)
      .eq("status", cur.status)
      .select("status");
    if (error) {
      console.error("[kh-order-action] status write failed", { id, error });
      return null;
    }
    if (rows && rows.length > 0) return next;
  }
  console.error("[kh-order-action] status write lost two races", { id });
  return null;
}

async function readKhError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 500);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  // -------- Parse body --------
  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_body" }, 400);
  }
  const { external_order_id, action, prep_time } = body || {};

  if (typeof external_order_id !== "string" || !external_order_id) {
    return jsonResponse(
      { ok: false, error: "invalid_inputs", detail: "external_order_id_required" },
      400,
    );
  }
  if (typeof action !== "string" || !Object.hasOwn(TARGET, action)) {
    return jsonResponse({ ok: false, error: "invalid_inputs", detail: "invalid_action" }, 400);
  }
  const act = action as Action;
  if (
    act === "accept" &&
    !(Number.isInteger(prep_time) && prep_time >= 1 && prep_time <= 240)
  ) {
    return jsonResponse(
      { ok: false, error: "invalid_inputs", detail: "prep_time_required_1_to_240" },
      400,
    );
  }

  // -------- Authorize --------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "missing_auth" }, 401);
  }
  const tokenStr = authHeader.slice("Bearer ".length).trim();

  const { data: { user }, error: authErr } = await supabase.auth.getUser(tokenStr);
  if (authErr || !user || !user.email) {
    return jsonResponse({ ok: false, error: "invalid_auth" }, 401);
  }

  // -------- Fetch order + restaurant (FK join) --------
  // Service-role select bypasses RLS; ownership verified after fetch via
  // restaurants.tablet_email match (same pattern as uber-create-delivery).
  const { data: row, error: rowErr } = await supabase
    .from("external_orders")
    .select(`
      id, restaurant_id, kh_order_id, status,
      restaurants:restaurant_id ( id, tablet_email )
    `)
    .eq("id", external_order_id)
    .maybeSingle();
  if (rowErr) {
    console.error("[kh-order-action] order fetch failed", { external_order_id, error: rowErr });
    return jsonResponse({ ok: false, error: "db_error", detail: rowErr.message }, 500);
  }
  if (!row) {
    return jsonResponse({ ok: false, error: "order_not_found" }, 404);
  }
  // deno-lint-ignore no-explicit-any
  const restaurant = (row as any).restaurants;
  if (!restaurant) {
    console.error("[kh-order-action] restaurant join failed", { external_order_id });
    return jsonResponse({ ok: false, error: "restaurant_not_found" }, 404);
  }
  if (restaurant.tablet_email !== user.email) {
    return jsonResponse({ ok: false, error: "forbidden" }, 403);
  }
  // Past this point, caller is authorized.

  // -------- Store gate --------
  const { data: store, error: storeErr } = await supabase
    .from("kitchenhub_stores")
    .select("enabled")
    .eq("restaurant_id", row.restaurant_id)
    .maybeSingle();
  if (storeErr) {
    console.error("[kh-order-action] store lookup failed", { external_order_id, error: storeErr });
    return jsonResponse({ ok: false, error: "db_error", detail: storeErr.message }, 500);
  }
  if (!store?.enabled) {
    return jsonResponse({ ok: false, error: "store_not_enabled" }, 409);
  }

  // -------- Status precondition --------
  if (row.status !== REQUIRED_STATUS[act]) {
    return jsonResponse({ ok: false, error: "invalid_status", status: row.status });
  }

  const logCtx = { external_order_id, kh_order_id: row.kh_order_id, action: act };

  // -------- KitchenHub status change --------
  const khBody = act === "accept" ? { status: "accept", prep_time } : { status: act };
  let res: Response;
  try {
    res = await khFetch(supabase, `/v2/orders/${row.kh_order_id}/status/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(khBody),
    });
  } catch (err) {
    // deno-lint-ignore no-explicit-any
    const e = err as any;
    console.error("[kh-order-action] KitchenHub request failed", {
      ...logCtx,
      error: e?.message ?? String(err),
      http: e?.http ?? null,
    });
    return jsonResponse({
      ok: false,
      error: "kitchenhub_error",
      http: e?.http ?? null,
      detail: e?.message ?? "request_failed",
    });
  }

  if (res.ok) {
    await res.body?.cancel();
    const nowIso = new Date().toISOString();
    const target = TARGET[act];
    const stamps =
      act === "accept" ? { accepted_at: nowIso, prep_time_minutes: prep_time }
      : act === "complete" ? { completed_at: nowIso }
      : { cancelled_at: nowIso, cancelled_by: "restaurant" };
    const stored = await writeStatus(row.id, target, stamps);
    // KitchenHub already applied the change; a failed mirror write is
    // reconciled by the webhook KitchenHub sends for this transition.
    console.log("[kh-order-action] applied", { ...logCtx, http: res.status, stored });
    return jsonResponse({ ok: true, status: stored ?? target, db_synced: stored !== null });
  }

  if (res.status === 409) {
    await res.body?.cancel();
    let synced: string = row.status;
    try {
      const getRes = await khFetch(supabase, `/v2/orders/${row.kh_order_id}/`, { method: "GET" });
      if (getRes.ok) {
        const kh = await getRes.json().catch(() => null);
        const incoming = normalizeStatus(kh?.order?.status);
        if (incoming) {
          const ts = kh?.timestamps ?? {};
          const stamps: Record<string, unknown> = {};
          for (const k of ["accepted_at", "completed_at", "cancelled_at"]) {
            if (ts[k]) stamps[k] = ts[k];
          }
          if (kh?.order?.cancelled_by) stamps.cancelled_by = kh.order.cancelled_by;
          synced = (await writeStatus(row.id, incoming, stamps)) ?? resolveStatus(row.status, incoming);
        }
      } else {
        console.warn("[kh-order-action] conflict re-fetch failed", { ...logCtx, http: getRes.status });
        await getRes.body?.cancel();
      }
    } catch (err) {
      console.error("[kh-order-action] conflict re-fetch exception", { ...logCtx, error: String(err) });
    }
    console.warn("[kh-order-action] conflict", { ...logCtx, synced });
    return jsonResponse({ ok: false, error: "conflict", status: synced });
  }

  if (res.status === 403) {
    await res.body?.cancel();
    console.warn("[kh-order-action] not main account", logCtx);
    return jsonResponse({ ok: false, error: "not_main_account", message: NOT_MAIN_ACCOUNT_MESSAGE });
  }

  const detail = await readKhError(res);
  console.error("[kh-order-action] KitchenHub error", { ...logCtx, http: res.status, detail });
  return jsonResponse({ ok: false, error: "kitchenhub_error", http: res.status, detail });
});
