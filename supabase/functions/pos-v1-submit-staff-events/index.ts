// ============================================================================
// pos-v1-submit-staff-events — append-only staff audit (SYNC-CONTRACT §3b, §3a).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). One StaffEventPayload per request,
// idempotent by event_id (same hash → 200 duplicate + the original response;
// different → 409 idempotency_key_reuse). Card guard → 400
// card_data_rejected. Flag: unknown_actor. No PINs / hashes ever.
//
// verify_jwt = false (supabase/config.toml). Logic: _shared/pos-staff/handlers.ts.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs migrations 101 + 105.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleStaffEvent } from "../_shared/pos-staff/handlers.ts";
import { PgStaffStore } from "../_shared/pos-staff/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  staff: new PgStaffStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-submit-staff-events"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleStaffEvent(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
