// ============================================================================
// pos-v1-submit-order — a register pushes one order aggregate (SYNC-CONTRACT §3).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Idempotent by (order_id, version) + content
// hash (§3.1); server reprices against the order's pinned snapshot with the
// vendored pricing module (total of record, §3.4); flags mismatch / stale_price
// / unknown_snapshot / availability_flag / delivery. POS orders live only in the
// pos_* tables (never the web's orders table).
//
// verify_jwt = false (supabase/config.toml). Logic: _shared/pos-sync/submitOrder.ts
// (+ orderPayload / orderPricing / orderStore). Env: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Needs migrations 101, 103, 104, 105.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { supabaseSnapshotDb } from "../_shared/pos-sync/menuSnapshot.ts";
import { supabasePersistSnapshot } from "../_shared/pos-sync/menuSnapshotHandler.ts";
import { CurrentSnapshots, handleSubmitOrder, PgOrderStore } from "../_shared/pos-sync/submitOrder.ts";
import { PgStaffStore } from "../_shared/pos-staff/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const deps = {
  store: new PgDeviceStore(supabase),
  orders: new PgOrderStore(supabase),
  current: new CurrentSnapshots(supabaseSnapshotDb(supabase), supabasePersistSnapshot(supabase)),
  staff: new PgStaffStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-submit-order"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(
    req,
    (r) => handleSubmitOrder(r, deps),
    (msg) => deps.log("internal_error", { error: msg }),
  )
);
