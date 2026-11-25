// ============================================================================
// pos-v1-online-orders — the online orders feed — FULL current state of both channels (Ordr + KitchenHub), opaque not-modified token, 503 feed_too_large, settings, history (SYNC-CONTRACT §3c).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlineOrders).
// verify_jwt = false (supabase/config.toml). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// menu_snapshot_hash: pos-v1-menu-snapshot's builder behind a 30 s per-restaurant cache (one per instance;
// _shared/pos-online/menuHash.ts) — null on a failed build, never a failed poll.
// Needs migrations 101 (pos_devices), 103 (menu snapshot columns), 109 + 110 (pos_* online tables).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlineOrders, logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
// the KitchenHub mapping reads, 30 s per restaurant keyed by the maps revision (one per function instance)
import { KhContextCache } from "../_shared/pos-online/khContextCache.ts";
import { FeedMenuHash } from "../_shared/pos-online/menuHash.ts";
import { supabaseSnapshotDb } from "../_shared/pos-sync/menuSnapshot.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  khContext: new KhContextCache(),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-online-orders"),
  // module scope: lives as long as the function instance (the 30 s cache)
  menuHash: new FeedMenuHash(supabaseSnapshotDb(supabase)),
};

// Every 4xx / 5xx is logged (status + error code + field — never a body or token): logErrorResponse.
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleOnlineOrders(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
