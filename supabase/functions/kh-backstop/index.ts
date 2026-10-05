// ============================================================================
// kh-backstop — Re-send KitchenHub orders the webhook missed
// ============================================================================
//
// Scheduled every 2 minutes by pg_cron + pg_net. Lists recent KitchenHub
// orders for every enabled store and re-delivers any we are missing (or are
// behind on) through the existing kh-webhook, so all normalization, routing,
// audit (external_order_events) and forward-only status logic stays in one
// place. kh-webhook is not modified.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Authenticated by a static x-ordr-cron-secret header compared constant-time
// against KH_BACKSTOP_SECRET. pg_net carries no Supabase JWT.
//
// Flow:
//   1. Secret check (401 on mismatch).
//   2. Enabled kitchenhub_stores. None → 200 { stores: 0 }.
//   3. GET /v2/orders/?store_id=…&store_id=…&date_from=<now-2h>&page=N
//      until an empty page (or a page with no new ids), hard cap 10 pages.
//   4. One batch lookup of external_orders by kh_order_id.
//   5. Forward when the row is missing, or KitchenHub's status is ahead
//      (resolveStatus(row.status, incoming) !== row.status).
//   6. Sequential POSTs to kh-webhook with the webhook shared secret, at most
//      MAX_FORWARDS_PER_RUN attempts; the rest are picked up next run.
//   7. One structured summary log line; always 200 after auth, with any
//      KitchenHub / DB error carried in the summary so the cron never hammers.
//
// Never logs secrets or tokens.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { timingSafeStringEqual } from "../_shared/uberSignature.ts";
import { normalizeStatus, parseOrderId, resolveStatus } from "../_shared/khNormalize.ts";
import { khFetch } from "../_shared/khToken.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const LOOKBACK_MS = 2 * 60 * 60 * 1000;
const MAX_PAGES = 10;
const FORWARD_TIMEOUT_MS = 15_000;
// Bounds a run's wall-clock time (sequential forwards, 15s timeout each) so a
// large backlog can't run past the edge-function limit or into the next
// 2-minute run. Counts attempts, successful or not.
const MAX_FORWARDS_PER_RUN = 50;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// KitchenHub's documented date format: '2022-03-30T16:12:33', UTC, no zone
// suffix and no milliseconds.
function khDate(d: Date): string {
  return d.toISOString().slice(0, 19);
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  // -------- 1. Cron secret --------
  const expected = Deno.env.get("KH_BACKSTOP_SECRET");
  if (!expected) {
    console.error("[kh-backstop] secret_not_configured");
    return jsonResponse({ error: "not_configured" }, 500);
  }
  const provided = req.headers.get("x-ordr-cron-secret");
  if (!provided || !timingSafeStringEqual(provided, expected)) {
    console.warn("[kh-backstop] rejected: missing or invalid secret header", {
      header_present: !!provided,
    });
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const webhookSecret = Deno.env.get("KITCHENHUB_WEBHOOK_SECRET");
  if (!webhookSecret) {
    console.error("[kh-backstop] webhook_secret_not_configured");
    return jsonResponse({ error: "not_configured" }, 500);
  }

  const startedAt = Date.now();
  const summary = {
    stores: 0,
    fetched: 0,
    forwarded: 0,
    failures: 0,
    pages: 0,
    capped: false,
    error: null as string | null,
    error_detail: null as string | null,
    forwarded_ids: [] as number[],
  };
  const finish = () => {
    console.log("[kh-backstop] run", { ...summary, duration_ms: Date.now() - startedAt });
    return jsonResponse(summary);
  };

  // -------- 2. Enabled stores --------
  const { data: stores, error: storesErr } = await supabase
    .from("kitchenhub_stores")
    .select("kh_store_id")
    .eq("enabled", true);
  if (storesErr) {
    summary.error = "store_lookup_failed";
    summary.error_detail = storesErr.message;
    return finish();
  }
  summary.stores = stores?.length ?? 0;
  if (summary.stores === 0) return finish();

  // -------- 3. One paged list call across all stores --------
  const params = new URLSearchParams();
  for (const s of stores!) params.append("store_id", s.kh_store_id);
  params.set("date_from", khDate(new Date(Date.now() - LOOKBACK_MS)));

  // deno-lint-ignore no-explicit-any
  const byId = new Map<number, any>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    params.set("page", String(page));
    let res: Response;
    try {
      res = await khFetch(supabase, `/v2/orders/?${params.toString()}`, { method: "GET" });
    } catch (err) {
      summary.error = "kitchenhub_request_failed";
      summary.error_detail = err instanceof Error ? err.message : String(err);
      break;
    }
    if (!res.ok) {
      summary.error = `kitchenhub_${res.status}`;
      summary.error_detail = (await res.text().catch(() => "")).slice(0, 300);
      break;
    }
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list)) {
      summary.error = "bad_list_shape";
      break;
    }
    summary.pages = page;
    if (list.length === 0) break;
    let added = 0;
    for (const item of list) {
      const id = parseOrderId(item?.order?.id);
      if (id !== null && !byId.has(id)) {
        byId.set(id, item);
        added++;
      }
    }
    // A page with nothing new means `page` is being ignored (or wrapped);
    // stop instead of re-reading the same data up to the cap.
    if (added === 0) break;
    if (page === MAX_PAGES) summary.error = "page_cap_reached";
  }
  summary.fetched = byId.size;
  if (byId.size === 0) return finish();

  // -------- 4. Batch lookup --------
  const ids = [...byId.keys()];
  const { data: rows, error: rowsErr } = await supabase
    .from("external_orders")
    .select("kh_order_id, status")
    .in("kh_order_id", ids);
  if (rowsErr) {
    summary.error = "external_orders_lookup_failed";
    summary.error_detail = rowsErr.message;
    return finish();
  }
  const existing = new Map<number, string>();
  for (const r of rows ?? []) existing.set(Number(r.kh_order_id), r.status);

  // -------- 5 + 6. Decide and forward, sequentially --------
  let attempts = 0;
  for (const [id, item] of byId) {
    const current = existing.get(id);
    const incoming = normalizeStatus(item?.order?.status);
    const missing = current === undefined;
    const behind = !missing && resolveStatus(current, incoming) !== current;
    if (!missing && !behind) continue;

    if (attempts >= MAX_FORWARDS_PER_RUN) {
      summary.capped = true;
      break;
    }
    attempts++;

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/kh-webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ordr-kh-secret": webhookSecret,
        },
        body: JSON.stringify({
          version: "2.0.0",
          event_data: { event_type: "Order", status: "Backstop" },
          order: item,
        }),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (res.ok) {
        summary.forwarded++;
        summary.forwarded_ids.push(id);
      } else {
        summary.failures++;
        console.error("[kh-backstop] forward failed", { kh_order_id: id, http: res.status, missing });
      }
    } catch (err) {
      summary.failures++;
      console.error("[kh-backstop] forward exception", {
        kh_order_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return finish();
});
