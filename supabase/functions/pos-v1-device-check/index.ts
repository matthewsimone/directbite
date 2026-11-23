// ============================================================================
// pos-v1-device-check — DIAGNOSTIC. Not part of SYNC-CONTRACT §2.
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2 middleware). Returns the principal
// { device_id, restaurant_id, prefix, server_time }. Exists to prove on a real
// deploy (Test Pizza) that the Supabase gateway passes x-ordr-device-token and
// x-ordr-device-id through untouched with verify_jwt = false (audit item 0.g),
// before pos-v1-menu-snapshot exists. Safe to keep or delete later.
//
// verify_jwt = false (supabase/config.toml). Logic: _shared/pos-device/deviceCheck.ts.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleDeviceCheck } from "../_shared/pos-device/deviceCheck.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const store = new PgDeviceStore(supabase);
const log = consoleDeviceLog("pos-v1-device-check");

Deno.serve((req: Request) =>
  handleDeviceHttp(
    req,
    (r) => handleDeviceCheck(r, { store, now: () => Date.now(), log }),
    (msg) => log("internal_error", { error: msg }),
  )
);
