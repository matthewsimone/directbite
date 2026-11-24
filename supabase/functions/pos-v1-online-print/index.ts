// ============================================================================
// pos-v1-online-print — per-station auto-print claim + result (pos_online_print_*), idempotent by action_id, writes the tablet's print columns (SYNC-CONTRACT §3c).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlinePrint).
// verify_jwt = false (supabase/config.toml). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Needs migrations 101 (pos_devices), 109 + 110 (pos_* online tables). NOT DEPLOYED.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlinePrint } from "../_shared/pos-online/handlers.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-online-print"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleOnlinePrint(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
