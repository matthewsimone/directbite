// ============================================================================
// kh-admin — KitchenHub location / store / provider management (admin only)
// ============================================================================
//
// Called from the admin panel's "Delivery apps (KitchenHub)" section.
// Body: { action, restaurant_id?, ... }. Covers KitchenHub's acceptance
// checklist: locations (create/list/get/edit/delete), stores (create/list/
// delete), provider connections (create link/list/status/pause/resume/delete),
// plus set_enabled (routing + tablet flag together).
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml). The
// handler validates the caller manually — getUser(token) → admin_users — the
// admin-refund pattern minus its tablet branch. Admin only.
//
// Response shape (HTTP 200 unless noted):
//   { ok: true, ... }
//   { ok: false, error: 'kitchenhub_error', step, http, kitchenhub }  ← KH body verbatim
//   { ok: false, error: <code>, ... }                                 ← our checks
//   401 missing_auth / invalid_auth · 403 forbidden · 400 invalid_inputs ·
//   404 restaurant_not_found · 500 db_error / not_configured
// Never returns or logs KitchenHub tokens.
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { khFetch } from "../_shared/khToken.ts";
import { parseUsAddress, safeKhBody } from "../_shared/khAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TIMEZONE = "America/New_York";
// Max pause KitchenHub is asked for (7 days); "until resumed" omits it.
const MAX_PAUSE_SECONDS = 7 * 24 * 60 * 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type KhResult =
  // deno-lint-ignore no-explicit-any
  | { ok: true; http: number; data: any }
  | { ok: false; http: number | null; error: unknown };

// One KitchenHub call; never throws. Error bodies are returned verbatim
// (parsed JSON, or text ≤ 2000 chars).
async function kh(path: string, init: RequestInit = {}): Promise<KhResult> {
  try {
    const res = await khFetch(supabase, path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = safeKhBody(await res.text());
    return res.ok ? { ok: true, http: res.status, data: body } : { ok: false, http: res.status, error: body };
  } catch (err) {
    // deno-lint-ignore no-explicit-any
    return { ok: false, http: (err as any)?.http ?? null, error: err instanceof Error ? err.message : String(err) };
  }
}

function khFail(step: string, r: KhResult): Response {
  const e = r as { http: number | null; error: unknown };
  console.error("[kh-admin] KitchenHub error", { step, http: e.http });
  return json({ ok: false, error: "kitchenhub_error", step, http: e.http, kitchenhub: e.error });
}

async function requireAdmin(req: Request): Promise<Response | null> {
  const h = req.headers.get("Authorization");
  if (!h || !h.startsWith("Bearer ")) return json({ ok: false, error: "missing_auth" }, 401);
  const { data: { user }, error } = await supabase.auth.getUser(h.slice("Bearer ".length).trim());
  if (error || !user?.email) return json({ ok: false, error: "invalid_auth" }, 401);
  const { data: admin, error: aErr } = await supabase
    .from("admin_users").select("email").eq("email", user.email).maybeSingle();
  if (aErr) return json({ ok: false, error: "db_error" }, 500);
  if (!admin) return json({ ok: false, error: "forbidden" }, 403);
  return null;
}

function loadRestaurant(id: string) {
  return supabase.from("restaurants")
    .select("id, name, address, dsp_orders_enabled").eq("id", id).maybeSingle();
}

function loadMapping(restaurantId: string) {
  return supabase.from("kitchenhub_stores")
    .select("restaurant_id, kh_store_id, kh_location_id, enabled, created_at")
    .eq("restaurant_id", restaurantId).maybeSingle();
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // -------- Admin check first --------
  const denied = await requireAdmin(req);
  if (denied) return denied;

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const action = typeof body?.action === "string" ? body.action : "";
  const restaurantId = typeof body?.restaurant_id === "string" ? body.restaurant_id : "";

  // -------- Actions without a restaurant --------
  if (action === "list_locations") {
    const r = await kh("/v2/locations/");
    return r.ok ? json({ ok: true, locations: r.data?.locations ?? [] }) : khFail("list_locations", r);
  }
  if (action === "list_stores") {
    const locationId = typeof body?.location_id === "string" ? body.location_id : "";
    if (locationId) {
      const r = await kh(`/v2/locations/${encodeURIComponent(locationId)}/`);
      return r.ok ? json({ ok: true, location_id: locationId, stores: r.data?.stores ?? [] }) : khFail("get_location", r);
    }
    const r = await kh("/v2/stores/");
    return r.ok ? json({ ok: true, stores: r.data?.stores ?? [] }) : khFail("list_stores", r);
  }

  // -------- Everything else is per restaurant --------
  if (!restaurantId) return json({ ok: false, error: "invalid_inputs", detail: "restaurant_id_required" }, 400);
  const { data: restaurant, error: rErr } = await loadRestaurant(restaurantId);
  if (rErr) return json({ ok: false, error: "db_error", detail: rErr.message }, 500);
  if (!restaurant) return json({ ok: false, error: "restaurant_not_found" }, 404);
  const { data: mapping, error: mErr } = await loadMapping(restaurantId);
  if (mErr) return json({ ok: false, error: "db_error", detail: mErr.message }, 500);

  const needMapping = () => json({ ok: false, error: "not_provisioned" });
  // Destructive store/location actions are refused while DSP orders are live.
  const liveGuard = () =>
    restaurant.dsp_orders_enabled === true
      ? json({
        ok: false,
        error: "restaurant_live",
        detail: "Turn off orders on tablet before deleting the KitchenHub store or location.",
      })
      : null;

  // Integration account must belong to this restaurant's store.
  async function ownedAccount(accountId: unknown): Promise<Response | null> {
    if (typeof accountId !== "string" || !accountId) {
      return json({ ok: false, error: "invalid_inputs", detail: "integration_account_id_required" }, 400);
    }
    const r = await kh(`/v2/integration_accounts/${encodeURIComponent(accountId)}/`);
    if (!r.ok) return khFail("get_integration_account", r);
    if (r.data?.store_id !== mapping!.kh_store_id) return json({ ok: false, error: "account_not_in_store" }, 403);
    return null;
  }

  switch (action) {
    case "provision": {
      if (mapping) return json({ ok: false, error: "already_provisioned", mapping });
      const name = String(restaurant.name ?? "").trim();
      if (name.length < 3) {
        return json({ ok: false, error: "invalid_name", detail: "KitchenHub needs a name of at least 3 characters" });
      }
      const addr = parseUsAddress(restaurant.address);
      if (!addr) return json({ ok: false, error: "address_unparseable", address: restaurant.address });

      // Reuse a location/store already tagged with this restaurant, so a retry
      // after a partial failure never creates duplicates.
      const locs = await kh("/v2/locations/");
      if (!locs.ok) return khFail("list_locations", locs);
      // deno-lint-ignore no-explicit-any
      let location = (locs.data?.locations ?? []).find((l: any) => l.partner_location_id === restaurant.id);
      let createdLocation = false;
      if (!location) {
        const c = await kh("/v2/locations/", {
          method: "POST",
          body: JSON.stringify({
            location_name: name,
            location_street: addr.street,
            location_city: addr.city,
            location_state: addr.state,
            location_zipcode: addr.zipcode,
            location_country: "US",
            location_timezone: TIMEZONE,
            partner_location_id: restaurant.id,
          }),
        });
        if (!c.ok) return khFail("create_location", c);
        location = c.data;
        createdLocation = true;
      }

      const sts = await kh(`/v2/stores/?partner_store_id=${encodeURIComponent(restaurant.id)}`);
      let store = sts.ok
        // deno-lint-ignore no-explicit-any
        ? (sts.data?.stores ?? []).find((s: any) => s.partner_store_id === restaurant.id && s.location_id === location.id)
        : null;
      if (!store) {
        const c = await kh("/v2/stores/", {
          method: "POST",
          body: JSON.stringify({
            location_id: location.id,
            store_name: name,
            partner_store_id: restaurant.id,
            auto_accept_enabled: false,
            // KitchenHub defaults this to true; the tablet's MARK READY owns completion.
            auto_complete_enabled: false,
          }),
        });
        if (!c.ok) {
          // Don't leave an empty location behind that we just created.
          if (createdLocation) await kh(`/v2/locations/${encodeURIComponent(location.id)}/`, { method: "DELETE" });
          return khFail("create_store", c);
        }
        store = c.data;
      }

      const { error: insErr } = await supabase.from("kitchenhub_stores").insert({
        restaurant_id: restaurant.id,
        kh_store_id: store.id,
        kh_location_id: location.id,
        enabled: false,
      });
      if (insErr) {
        // KitchenHub objects are kept; a retry adopts them via partner ids.
        console.error("[kh-admin] mapping insert failed", { restaurant_id: restaurant.id, error: insErr.message });
        return json({
          ok: false,
          error: "db_error",
          detail: insErr.message,
          kh_location_id: location.id,
          kh_store_id: store.id,
        }, 500);
      }
      console.log("[kh-admin] provisioned", {
        restaurant_id: restaurant.id,
        kh_location_id: location.id,
        kh_store_id: store.id,
      });
      return json({ ok: true, location, store });
    }

    case "get": {
      if (!mapping) return json({ ok: true, provisioned: false, dsp_orders_enabled: restaurant.dsp_orders_enabled === true });
      const [loc, st] = await Promise.all([
        mapping.kh_location_id
          ? kh(`/v2/locations/${encodeURIComponent(mapping.kh_location_id)}/`)
          : Promise.resolve(null),
        kh(`/v2/stores/${encodeURIComponent(mapping.kh_store_id)}/`),
      ]);
      const errOf = (r: KhResult | null) =>
        r && !r.ok ? { http: (r as { http: number | null }).http, kitchenhub: (r as { error: unknown }).error } : null;
      return json({
        ok: true,
        provisioned: true,
        mapping,
        dsp_orders_enabled: restaurant.dsp_orders_enabled === true,
        location: loc && loc.ok ? loc.data : null,
        location_error: loc ? errOf(loc) : { http: null, kitchenhub: "no kh_location_id on mapping" },
        store: st.ok ? st.data : null,
        store_error: errOf(st),
      });
    }

    case "set_enabled": {
      if (!mapping) return needMapping();
      if (typeof body?.enabled !== "boolean") {
        return json({ ok: false, error: "invalid_inputs", detail: "enabled_boolean_required" }, 400);
      }
      const enabled: boolean = body.enabled;
      const prevMapping = mapping.enabled;
      const { error: mapErr } = await supabase
        .from("kitchenhub_stores").update({ enabled }).eq("restaurant_id", restaurant.id);
      if (mapErr) return json({ ok: false, error: "db_error", detail: mapErr.message }, 500);
      const { error: restErr } = await supabase
        .from("restaurants").update({ dsp_orders_enabled: enabled }).eq("id", restaurant.id);
      if (restErr) {
        // Keep the two flags in step: undo the mapping change.
        await supabase.from("kitchenhub_stores").update({ enabled: prevMapping }).eq("restaurant_id", restaurant.id);
        return json({ ok: false, error: "db_error", detail: restErr.message }, 500);
      }
      console.log("[kh-admin] set_enabled", { restaurant_id: restaurant.id, enabled });
      return json({ ok: true, kitchenhub_store_enabled: enabled, dsp_orders_enabled: enabled });
    }

    case "update_location": {
      if (!mapping) return needMapping();
      if (!mapping.kh_location_id) return json({ ok: false, error: "no_location_id" });
      const name = String(restaurant.name ?? "").trim();
      const addr = parseUsAddress(restaurant.address);
      if (!addr) return json({ ok: false, error: "address_unparseable", address: restaurant.address });
      const loc = await kh(`/v2/locations/${encodeURIComponent(mapping.kh_location_id)}/`, {
        method: "PATCH",
        body: JSON.stringify({
          location_name: name,
          location_street: addr.street,
          location_city: addr.city,
          location_state: addr.state,
          location_zip: addr.zipcode, // PATCH uses location_zip (create uses location_zipcode)
          location_country: "US",
        }),
      });
      if (!loc.ok) return khFail("update_location", loc);
      const st = await kh(`/v2/stores/${encodeURIComponent(mapping.kh_store_id)}/`, {
        method: "PATCH",
        // auto_complete_enabled: false also fixes stores created in the
        // KitchenHub dashboard with its default of true.
        body: JSON.stringify({ store_name: name, auto_complete_enabled: false }),
      });
      if (!st.ok) return khFail("update_store", st);
      return json({ ok: true, location: loc.data, store: st.data });
    }

    case "delete_store": {
      if (!mapping) return needMapping();
      const guard = liveGuard();
      if (guard) return guard;
      const r = await kh(`/v2/stores/${encodeURIComponent(mapping.kh_store_id)}/`, { method: "DELETE" });
      if (!r.ok && r.http !== 404) return khFail("delete_store", r);
      // Mapping row stays (kh_store_id is NOT NULL) but is disabled; delete_location removes it.
      await supabase.from("kitchenhub_stores").update({ enabled: false }).eq("restaurant_id", restaurant.id);
      return json({ ok: true, deleted_store: mapping.kh_store_id, already_gone: !r.ok });
    }

    case "delete_location": {
      if (!mapping) return needMapping();
      const guard = liveGuard();
      if (guard) return guard;
      if (!mapping.kh_location_id) return json({ ok: false, error: "no_location_id" });
      const loc = await kh(`/v2/locations/${encodeURIComponent(mapping.kh_location_id)}/`);
      if (!loc.ok && loc.http !== 404) return khFail("get_location", loc);
      const stores = loc.ok ? (loc.data?.stores ?? []) : [];
      if (stores.length > 0) return json({ ok: false, error: "location_has_stores", stores });
      if (loc.ok) {
        const d = await kh(`/v2/locations/${encodeURIComponent(mapping.kh_location_id)}/`, { method: "DELETE" });
        if (!d.ok && d.http !== 404) return khFail("delete_location", d);
      }
      const { error: delErr } = await supabase.from("kitchenhub_stores").delete().eq("restaurant_id", restaurant.id);
      if (delErr) return json({ ok: false, error: "db_error", detail: delErr.message }, 500);
      return json({ ok: true, deleted_location: mapping.kh_location_id });
    }

    case "list_providers": {
      if (!mapping) return needMapping();
      const [accts, provs] = await Promise.all([
        kh(`/v2/integration_accounts/?store_id=${encodeURIComponent(mapping.kh_store_id)}`),
        kh("/v2/providers/"),
      ]);
      if (!accts.ok) return khFail("list_integration_accounts", accts);
      const accounts = Array.isArray(accts.data) ? accts.data : [];
      const withStatus = await Promise.all(
        // deno-lint-ignore no-explicit-any
        accounts.map(async (a: any) => {
          if (a.connection !== "connected") return { ...a, online: null, offline_reason: null };
          const s = await kh(`/v2/integration_accounts/${encodeURIComponent(a.integration_account_id)}/status/`);
          return s.ok
            ? { ...a, online: s.data?.online ?? null, offline_reason: s.data?.offline_reason ?? null }
            : {
              ...a,
              online: null,
              offline_reason: null,
              status_error: { http: s.http, kitchenhub: (s as { error: unknown }).error },
            };
        }),
      );
      const providers = provs.ok && Array.isArray(provs.data)
        // deno-lint-ignore no-explicit-any
        ? provs.data.map((p: any) => ({
          provider_id: p.provider_id,
          provider_name: p.provider_name,
          can_update_online_status: p.provider_capabilities?.online_status?.update_online_status?.is_supported ?? null,
        }))
        : null;
      return json({ ok: true, accounts: withStatus, providers });
    }

    case "connect_provider": {
      if (!mapping) return needMapping();
      const providerId = typeof body?.provider_id === "string" ? body.provider_id : "";
      if (!providerId) return json({ ok: false, error: "invalid_inputs", detail: "provider_id_required" }, 400);
      const redirectUrl = Deno.env.get("KH_CONNECT_REDIRECT_URL");
      if (!redirectUrl) return json({ ok: false, error: "not_configured", detail: "KH_CONNECT_REDIRECT_URL" }, 500);
      const r = await kh("/v2/integration_accounts/", {
        method: "POST",
        body: JSON.stringify({ provider_id: providerId, store_id: mapping.kh_store_id, redirect_url: redirectUrl }),
      });
      if (!r.ok) return khFail("create_integration_account", r);
      return json({ ok: true, integration_account_id: r.data?.integration_account_id, url: r.data?.url });
    }

    case "pause_provider":
    case "resume_provider": {
      if (!mapping) return needMapping();
      const bad = await ownedAccount(body?.integration_account_id);
      if (bad) return bad;
      const payload: Record<string, unknown> = { online: action === "resume_provider" };
      if (action === "pause_provider" && body?.pause_seconds != null) {
        const secs = Number(body.pause_seconds);
        if (!Number.isInteger(secs) || secs < 60 || secs > MAX_PAUSE_SECONDS) {
          return json({ ok: false, error: "invalid_inputs", detail: "pause_seconds_60_to_604800" }, 400);
        }
        payload.pause_duration = secs;
      }
      const r = await kh(`/v2/integration_accounts/${encodeURIComponent(body.integration_account_id)}/status/`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (!r.ok) return khFail(action, r);
      return json({ ok: true, status: r.data });
    }

    case "disconnect_provider": {
      if (!mapping) return needMapping();
      const bad = await ownedAccount(body?.integration_account_id);
      if (bad) return bad;
      const r = await kh(`/v2/integration_accounts/${encodeURIComponent(body.integration_account_id)}/`, {
        method: "DELETE",
      });
      if (!r.ok && r.http !== 404) return khFail("delete_integration_account", r);
      return json({ ok: true });
    }

    default:
      return json({ ok: false, error: "invalid_inputs", detail: "unknown_action" }, 400);
  }
});
