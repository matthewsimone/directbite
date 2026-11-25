// ============================================================================
// pos-admin-devices — /admin register management (DEVICE-AUTH §6). Admin only.
// ============================================================================
// verify_jwt = false (supabase/config.toml), like admin-refund / kh-admin: the
// handler validates the caller itself — Bearer JWT → getUser → admin_users by
// email (admin-refund:31-54 pattern). Only Matt at launch.
//
// Actions (POST JSON { action, ... }): list, create_enrollment,
// create_reenrollment, revoke, locked_ips — see _shared/pos-device/admin.ts.
// An enrollment code is returned once; only sha256(secret) is stored.
// Errors: { error: { code, message, field? } }.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { ADMIN_CORS_HEADERS, handleAdmin, type AdminCheck } from "../_shared/pos-device/admin.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";
import { errorResult, readBodyLimited, toResponse } from "../_shared/pos-sync/http.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const store = new PgDeviceStore(supabase);
const log = consoleDeviceLog("pos-admin-devices");

async function verifyAdmin(authorization: string | null): Promise<AdminCheck> {
  if (!authorization?.startsWith("Bearer ")) return { ok: false, status: 401 };
  const { data: { user }, error } = await supabase.auth.getUser(authorization.slice("Bearer ".length).trim());
  if (error || !user?.email) return { ok: false, status: 401 };
  const { data: admin } = await supabase.from("admin_users").select("email").eq("email", user.email).maybeSingle();
  return admin ? { ok: true, adminId: user.id } : { ok: false, status: 403 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS_HEADERS });
  const bodyText = await readBodyLimited(req, 16 * 1024);
  if (bodyText === null) return toResponse(errorResult(400, "invalid_payload", "body too large"), ADMIN_CORS_HEADERS);
  try {
    const r = await handleAdmin({ method: req.method, headers: req.headers, bodyText }, { store, now: () => Date.now(), log, verifyAdmin });
    return toResponse(r, ADMIN_CORS_HEADERS);
  } catch (err) {
    log("internal_error", { error: err instanceof Error ? err.message : "unknown" });
    return toResponse(errorResult(500, "internal_error", "Something went wrong. Please try again."), ADMIN_CORS_HEADERS);
  }
});
