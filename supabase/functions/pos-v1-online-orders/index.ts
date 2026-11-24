// ============================================================================
// pos-v1-online-orders — the online orders feed — FULL current state of both channels (Ordr + KitchenHub), opaque not-modified token, 503 feed_too_large, settings, history (SYNC-CONTRACT §3c).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlineOrders).
// verify_jwt = false (supabase/config.toml). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Needs migrations 101 (pos_devices), 109 + 110 (pos_* online tables). NOT DEPLOYED.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlineOrders } from "../_shared/pos-online/handlers.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-online-orders"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleOnlineOrders(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
