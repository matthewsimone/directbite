// ============================================================================
// pos-v1-delivery-status — the deliveries of some POS orders; a booked one refreshed from the provider at most every 30 s (polling — not the live uber-webhook) (CP23; ordr-pos DELIVERY.md §2 / §6.3 / §7).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-delivery/handlers.ts (handleDeliveryStatus); the Uber calls are copied +
// hash-pinned (_shared/pos-delivery/uberCalls.ts, webPins.json), the shared Uber modules imported unchanged
// (_shared/pos-delivery/live.ts). POS orders stay in pos_* — nothing touches orders / order_items / uber_quotes.
// verify_jwt = false (supabase/config.toml). Env: see _shared/pos-delivery/live.ts. Needs migrations 104 + 109–115.
// NOT DEPLOYED.
// ============================================================================

import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { handleDeliveryStatus } from "../_shared/pos-delivery/handlers.ts";
import { liveDeliveryDeps } from "../_shared/pos-delivery/live.ts";

const deps = liveDeliveryDeps("pos-v1-delivery-status");

// Every 4xx / 5xx is logged (status + error code + field — never a body or token).
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleDeliveryStatus(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
