// ============================================================================
// pos-v1-online-settings — the POS-only online settings from a register: the print register, Ordr auto-print,
// KitchenHub auto-print (pos_restaurant_settings), idempotent by action_id, actor + approver recorded
// (SYNC-CONTRACT §3c). estimates / delivery_available / item_availability → 501 (not built in CP18).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlineSettings) + migration 111
// (pos_online_settings_change). verify_jwt = false (supabase/config.toml). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Needs migrations 101 (pos_devices), 109 + 110 + 111 (pos_* online tables). NOT DEPLOYED.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlineSettings } from "../_shared/pos-online/handlers.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-online-settings"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleOnlineSettings(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
