// ============================================================================
// pos-v1-delivery-dispatch — book the provider courier (Uber Direct) for a PAID-IN-FULL, CARD-ONLY POS delivery order; behind pos_restaurant_settings.pos_delivery_dispatch_enabled (CP23; ordr-pos DELIVERY.md §2 / §6.3 / §7).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-delivery/handlers.ts (handleDeliveryDispatch); the Uber calls are copied +
// hash-pinned (_shared/pos-delivery/uberCalls.ts, webPins.json), the shared Uber modules imported unchanged
// (_shared/pos-delivery/live.ts). POS orders stay in pos_* — nothing touches orders / order_items / uber_quotes.
// verify_jwt = false (supabase/config.toml). Env: see _shared/pos-delivery/live.ts. Needs migrations 104 + 109–115.
// NOT DEPLOYED.
// ============================================================================

import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { handleDeliveryDispatch } from "../_shared/pos-delivery/handlers.ts";
import { liveDeliveryDeps } from "../_shared/pos-delivery/live.ts";

const deps = liveDeliveryDeps("pos-v1-delivery-dispatch");

// Every 4xx / 5xx is logged (status + error code + field — never a body or token).
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleDeliveryDispatch(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
