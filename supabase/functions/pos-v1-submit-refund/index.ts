// ============================================================================
// pos-v1-submit-refund — END-OF-DAY entity (SYNC-CONTRACT §3a; handoff item 7).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2), §1a identity, §3a envelope: canonical
// content hash, card guard, idempotency (type, id, version) → 200 duplicate /
// 409 idempotency_key_reuse. refund after Close (v1, immutable) — 409 unknown_payment (retryable), refund_exceeds_payment.
// Response { result, id, version, server_version, flags, server_time }.
//
// verify_jwt = false (supabase/config.toml). Logic: _shared/pos-eod/handlers.ts.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs migrations 101, 104, 105, 106.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleRefund } from "../_shared/pos-eod/handlers.ts";
import { PgEodStore } from "../_shared/pos-eod/store.ts";
import { PgStaffStore } from "../_shared/pos-staff/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const deps = {
  store: new PgDeviceStore(supabase),
  eod: new PgEodStore(supabase),
  staff: new PgStaffStore(supabase),
  now: () => Date.now(),
  log: consoleDeviceLog("pos-v1-submit-refund"),
};

Deno.serve((req: Request) =>
  handleDeviceHttp(req, (r) => handleRefund(r, deps), (msg) => deps.log("internal_error", { error: msg }))
);
