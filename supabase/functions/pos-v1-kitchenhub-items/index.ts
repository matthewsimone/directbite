// ============================================================================
// pos-v1-kitchenhub-items — staff map marketplace (KitchenHub) items to the Ordr menu once, from a register, so
// DoorDash / Grubhub / Uber Eats lines route by category → printer (CP21). op list (seen-in-orders 30 days + the
// marketplace menu pull, read-only, cached ≥ 5 min) / set / clear (idempotent by UUID action_id). Nothing is pushed
// to KitchenHub.
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/khItemsHandler.ts + migration 117
// (pos_kitchenhub_item_maps, pos_kitchenhub_menu_pulls, pos_kitchenhub_item_map_change). verify_jwt = false
// (supabase/config.toml). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KITCHENHUB_CLIENT_ID /
// KITCHENHUB_CLIENT_SECRET (the menu pull, through _shared/khToken.ts khFetch imported UNCHANGED — unset → the list
// is seen-in-orders only). Needs migrations 101, 109–111, 117.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { khFetch } from "../_shared/khToken.ts";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { handleKitchenhubItems } from "../_shared/pos-online/khItemsHandler.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const log = consoleDeviceLog("pos-v1-kitchenhub-items");
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  now: () => Date.now(),
  log,
  khFetch,
};

// Every 4xx / 5xx is logged (status + error code + field — never a body or token): logErrorResponse.
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleKitchenhubItems(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
