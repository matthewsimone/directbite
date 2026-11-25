/**
 * The live deps of the four POS delivery functions (entry points only — tests never load this file: it pulls in
 * the remote supabase-js import of the shared Uber modules). Binds the shared modules IMPORTED UNCHANGED:
 * _shared/uberToken.ts, uberCreds.ts, uberConfig.ts, uberPassthrough.ts, uberMode.ts, uberLog.ts.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_MAPS_API_KEY, UBER_PLATFORM_CLIENT_ID / _SECRET / _CUSTOMER_ID
 * (platform-billed restaurants; self-billed ones use their own stored credentials, as the web does).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { getUberToken } from "../uberToken.ts";
import { resolveUrlCreds } from "../uberCreds.ts";
import { getUberApiBase } from "../uberConfig.ts";
import { applyPassthrough } from "../uberPassthrough.ts";
import { resolveMode } from "../uberMode.ts";
import { logUber } from "../uberLog.ts";
import { consoleDeviceLog } from "../pos-device/log.ts";
import { PgDeviceStore } from "../pos-device/store.ts";
import { PgOrderStore } from "../pos-sync/submitOrder.ts";
import { geocodeAddress } from "./geocode.ts";
import type { DeliveryDeps } from "./handlers.ts";
import { PgDeliveryStore } from "./store.ts";

export function liveDeliveryDeps(fn: string): DeliveryDeps {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const log = consoleDeviceLog(fn);
  const orders = new PgOrderStore(supabase);
  return {
    store: new PgDeviceStore(supabase),
    db: supabase,
    delivery: new PgDeliveryStore(supabase),
    uber: { supabase, getUberToken, resolveUrlCreds, getUberApiBase, applyPassthrough, logUber, fetch: (u, i) => fetch(u, i) },
    geocode: (address: string) => geocodeAddress({ key: Deno.env.get("GOOGLE_MAPS_API_KEY"), fetch: (u, i) => fetch(u, i), log }, address),
    snapshot: (hash: string, restaurantId: string) => orders.getSnapshot(hash, restaurantId),
    // deno-lint-ignore no-explicit-any
    resolveMode: (restaurant: any) => resolveMode(restaurant),
    now: () => Date.now(),
    log,
  };
}
