// ============================================================================
// pos-v1-menu-snapshot — the register's menu + pricing config (SYNC-CONTRACT §4).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2 middleware). Body { restaurant_id, if_none_match }.
// 200 { not_modified: true, hash } | 200 full MenuSnapshot (persisted to
// pos_menu_snapshots first). Errors per SYNC §3.3/§5: 401 device_unregistered /
// device_revoked, 403 device_mismatch, 400 restaurant_mismatch / invalid_payload,
// 426 upgrade_required, 500 snapshot_config_invalid (+ field) / internal_error.
// Also the POS's pause / auth probe: a matching if_none_match is answered from a
// per-instance cache (30 s) after the auth lookup alone.
//
// verify_jwt = false (supabase/config.toml). Logic: _shared/pos-sync/menuSnapshot*.ts.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs migration 103 (address_* columns,
// pos_menu_snapshots).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { supabaseSnapshotDb } from "../_shared/pos-sync/menuSnapshot.ts";
import { handleMenuSnapshot, SnapshotCache, supabasePersistSnapshot } from "../_shared/pos-sync/menuSnapshotHandler.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const deps = {
  store: new PgDeviceStore(supabase),
  snapshotDb: supabaseSnapshotDb(supabase),
  persist: supabasePersistSnapshot(supabase),
  cache: new SnapshotCache(),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-menu-snapshot"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(
    req,
    (r) => handleMenuSnapshot(r, deps),
    (msg) => deps.log("internal_error", { error: msg }),
  )
);
