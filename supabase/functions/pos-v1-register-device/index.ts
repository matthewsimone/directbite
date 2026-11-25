// ============================================================================
// pos-v1-register-device — the only UNAUTHENTICATED pos-v1 device function.
// ============================================================================
// Spec: ordr-pos docs/DEVICE-AUTH.md §4.1 + §5; SYNC-CONTRACT §2.
// Logic: _shared/pos-device/register.ts (tested with the in-memory store).
//
// verify_jwt = false (supabase/config.toml). Clients send the publishable key
// as `apikey`, x-ordr-api-version: 1, x-ordr-client. No Authorization header.
//
// Request:  { enrollment_code, registration_nonce, existing_device_id, hardware_model, app_version }
// 200:      { device_id, device_token, restaurant_id, prefix, label, server_time }
// Errors:   400 enrollment_invalid (ONE body for every failure), 429 rate_limited + Retry-After,
//           426 upgrade_required, 405, 500 internal_error.
//
// The response body carries the device token: it is never logged.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { handleRegister } from "../_shared/pos-device/register.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const store = new PgDeviceStore(supabase);
const log = consoleDeviceLog("pos-v1-register-device");

Deno.serve((req: Request) =>
  handleDeviceHttp(
    req,
    (r) => handleRegister(r, { store, now: () => Date.now(), log }),
    (msg) => log("internal_error", { error: msg }),
  )
);
