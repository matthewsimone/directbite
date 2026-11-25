// ============================================================================
// pos-v1-delivery-cancel — cancel the booked provider courier of a POS delivery order (refused once the driver has the food) (CP23; ordr-pos DELIVERY.md §2 / §6.3 / §7).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-delivery/handlers.ts (handleDeliveryCancel); the Uber calls are copied +
// hash-pinned (_shared/pos-delivery/uberCalls.ts, webPins.json), the shared Uber modules imported unchanged
// (_shared/pos-delivery/live.ts). POS orders stay in pos_* — nothing touches orders / order_items / uber_quotes.
// verify_jwt = false (supabase/config.toml). Env: see _shared/pos-delivery/live.ts. Needs migrations 104 + 109–115.
// NOT DEPLOYED.
// ============================================================================

import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { handleDeliveryCancel } from "../_shared/pos-delivery/handlers.ts";
import { liveDeliveryDeps } from "../_shared/pos-delivery/live.ts";

const deps = liveDeliveryDeps("pos-v1-delivery-cancel");

// Every 4xx / 5xx is logged (status + error code + field — never a body or token).
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleDeliveryCancel(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
