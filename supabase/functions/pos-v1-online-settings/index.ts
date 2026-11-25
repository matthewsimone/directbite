// ============================================================================
// pos-v1-online-settings — online settings from a register (SYNC-CONTRACT §3c), idempotent by action_id, actor +
// approver recorded: the POS-only ones (print register, Ordr / KitchenHub auto-print → pos_restaurant_settings, 111)
// and the web tablet's own (estimates, delivery_available → restaurants; item_availability → menu_items.is_available,
// 112) — exactly the tablet's writes. item_availability answers the menu snapshot hash so the register pulls it.
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlineSettings) + migration 111
// (pos_online_settings_change) + 112 (pos_online_tablet_setting_change). verify_jwt = false (supabase/config.toml).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs migrations 101, 103 (menu snapshot columns), 109–112. NOT DEPLOYED.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlineSettings } from "../_shared/pos-online/handlers.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
import { supabaseSnapshotDb } from "../_shared/pos-sync/menuSnapshot.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-online-settings"),
  snapshotDb: supabaseSnapshotDb(supabase),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleOnlineSettings(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
