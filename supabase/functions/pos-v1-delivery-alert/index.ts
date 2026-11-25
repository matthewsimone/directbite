// ============================================================================
// pos-v1-delivery-alert — the every-register delivery toast's shared "handled" mark (POS-005, migration 118): the first
// register to handle a provider cancel / a failed booking sets it once; every register clears the toast on its next
// pos-v1-delivery-status poll (scope 'restaurant').
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-delivery/handlers.ts (handleDeliveryAlert). No provider call.
// POS orders stay in pos_* — nothing touches orders / order_items / uber_quotes. verify_jwt = false
// (supabase/config.toml). Env: see _shared/pos-delivery/live.ts. Needs migrations 104 + 109–118.
// NOT DEPLOYED.
// ============================================================================

import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { handleDeliveryAlert } from "../_shared/pos-delivery/handlers.ts";
import { liveDeliveryDeps } from "../_shared/pos-delivery/live.ts";

const deps = liveDeliveryDeps("pos-v1-delivery-alert");

// Every 4xx / 5xx is logged (status + error code + field — never a body or token).
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleDeliveryAlert(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
