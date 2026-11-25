// ============================================================================
// pos-v1-online-order-action — Ordr order actions from a register: ack, stuck_ack, accept (+ the ready email once),
// schedule, complete, complete_all_in_progress, wake_scheduled — each EXACTLY the web tablet's write, compare-and-set
// on expected_status, idempotent by action_id (SYNC-CONTRACT §3c). Money / Uber / KitchenHub actions → 501 (CP19–21).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlineOrderAction) + migration 111
// (pos_online_order_action). verify_jwt = false (supabase/config.toml).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (the ready email is called like the tablet calls it).
// Needs migrations 101 (pos_devices), 109 + 110 + 111 (pos_* online tables). NOT DEPLOYED.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlineOrderAction, logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { makeReadyEmail } from "../_shared/pos-online/readyEmail.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const log = consoleDeviceLog("pos-v1-online-order-action");
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  now: () => Date.now(),
  log,
  readyEmail: makeReadyEmail({ supabaseUrl: Deno.env.get("SUPABASE_URL")!, anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", log }),
};

// Every 4xx / 5xx is logged (status + error code + field — never a body or token): logErrorResponse.
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleOnlineOrderAction(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
