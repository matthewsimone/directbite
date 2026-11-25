// ============================================================================
// pos-v1-staff-snapshot — the register's staff list + settings (SYNC-CONTRACT §3b).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Body { restaurant_id, if_none_match } →
// 200 { not_modified: true, hash } | 200 StaffSnapshot (published to
// pos_staff_snapshots first) | 404 no_staff | 500 staff_config_invalid.
// The ONLY place PIN hashes (scrypt hex) leave the server.
//
// verify_jwt = false (supabase/config.toml). Logic: _shared/pos-staff/handlers.ts.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs migrations 101 + 105.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleStaffSnapshot } from "../_shared/pos-staff/handlers.ts";
import { PgStaffStore } from "../_shared/pos-staff/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  staff: new PgStaffStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-staff-snapshot"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleStaffSnapshot(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
