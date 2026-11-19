// ============================================================================
// pos-v1-price-order — server-authoritative order pricing (stateless quote)
// ============================================================================
//
// POST, header `x-ordr-api-version: 1`. Body: IDs and customer choices only
// (see _shared/pos-v1/request.ts). Every price, rate, fee, promo, redemption
// and the delivery distance is loaded / computed server-side, then priced by
// the vendored Ordr POS module (_shared/ordr-core, byte-identical to ordr-pos;
// drift-checked by scripts/check-ordr-core.mjs). No writes.
//
// 200 → { apiVersion, pricingModuleHash, sourceCommit, breakdown, resolved }
// 4xx/5xx → { code, message } (5xx messages are generic; details are logged).
//
// Channel: this endpoint serves the web checkout → 'online'. Channel is never
// a request field; the POS (in_person) will be identified by device auth.
//
// JWT: verify_jwt = false (config.toml), the same anonymous-customer pattern
// as create-payment-intent; DB access is service-role with explicit columns.
// Requires migration 099 (restaurants.timezone); without it every quote fails
// with pricing_config_invalid rather than crashing.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, POS_V1_ALLOWED_ORIGINS.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { ApiError } from "../_shared/pos-v1/errors.ts";
import { corsHeaders, isOriginAllowed, parseOriginList } from "../_shared/pos-v1/cors.ts";
import { handlePriceRequest } from "../_shared/pos-v1/handler.ts";
import { MAX_BODY_BYTES } from "../_shared/pos-v1/request.ts";
import { supabasePricingDb } from "../_shared/pos-v1/supabaseDb.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const db = supabasePricingDb(supabase);
const staticOrigins = parseOriginList(Deno.env.get("POS_V1_ALLOWED_ORIGINS"));

// Custom domains change rarely; refresh at most every 5 minutes per isolate.
const CUSTOM_DOMAIN_TTL_MS = 5 * 60 * 1000;
let customDomains: { set: Set<string>; at: number } | null = null;

async function getCustomDomains(): Promise<Set<string>> {
  if (customDomains && Date.now() - customDomains.at < CUSTOM_DOMAIN_TTL_MS) return customDomains.set;
  const { data, error } = await supabase
    .from("restaurants")
    .select("custom_domain")
    .not("custom_domain", "is", null);
  if (error) {
    console.error("[pos-v1-price-order] custom_domain read failed", error.message);
    return customDomains?.set ?? new Set();
  }
  const set = new Set<string>(
    (data ?? [])
      .map((r: { custom_domain: string | null }) => (r.custom_domain ?? "").trim().toLowerCase().replace(/^www\./, ""))
      .filter(Boolean),
  );
  customDomains = { set, at: Date.now() };
  return set;
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

/** Read at most MAX_BODY_BYTES; null if the body is larger. */
async function readBodyLimited(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  let cors: Record<string, string> = {};
  if (origin) {
    if (!isOriginAllowed(origin, staticOrigins, await getCustomDomains())) {
      return json(403, new ApiError("origin_not_allowed", "origin not allowed").toBody(), { Vary: "Origin" });
    }
    cors = corsHeaders(origin);
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const bodyText = await readBodyLimited(req);
  if (bodyText === null) {
    return json(400, new ApiError("request_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`).toBody(), cors);
  }

  const result = await handlePriceRequest(
    { method: req.method, headers: req.headers, bodyText },
    {
      db,
      now: () => new Date(),
      channel: "online",
      log: (event, data) => console.error(`[pos-v1-price-order] ${event}`, JSON.stringify(data)),
    },
  );
  return json(result.status, result.body, cors);
});
