// ============================================================================
// pos-v1-online-order-action — Ordr order actions from a register: ack, stuck_ack, accept (+ the ready email once),
// schedule, complete, complete_all_in_progress, wake_scheduled — each EXACTLY the web tablet's write, compare-and-set
// on expected_status, idempotent by action_id (SYNC-CONTRACT §3c). CP19 money: cancel_refund = admin-refund {type:
// 'full'} UNCHANGED (its glue copied + hash-pinned, the shared Uber / app-fee modules imported unchanged),
// adjustment_request = the tablet's ADJUST insert. CP20 Uber: dispatch_delivery = uber-create-delivery (the shared
// core createUberDelivery imported unchanged), self_deliver = uber-self-deliver (cancelUberDelivery + refundUberAppFee
// imported unchanged); their handler glue copied + hash-pinned (_shared/pos-online/uberGlue.ts, webPins.json).
// CP21 KitchenHub: ext_ack = the tablet's tap (external_orders.acknowledged_at); ext_accept / ext_ready / ext_cancel =
// kh-order-action (its glue copied + hash-pinned, _shared/pos-online/khGlue.ts; khNormalize + khToken imported unchanged).
// ============================================================================
// Device-authed (DEVICE-AUTH §4.2). Logic: _shared/pos-online/handlers.ts (handleOnlineOrderAction) + migration 111
// (pos_online_order_action). verify_jwt = false (supabase/config.toml).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (the ready email is called like the tablet calls it),
// STRIPE_SECRET_KEY (the platform key admin-refund / uber-self-deliver use; unset → cancel_refund / dispatch_delivery /
// self_deliver 501) + the Uber env the shared Uber modules read (the same secrets uber-create-delivery /
// uber-self-deliver use), KITCHENHUB_CLIENT_ID / KITCHENHUB_CLIENT_SECRET (khFetch, as kh-order-action). Needs migrations
// 101, 109–111, 113, 114 (pending dispatch / self-deliver + the release), 117 (pending ext_* + their release; the maps).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";
// admin-refund's shared modules, imported UNCHANGED (the glue that calls them: _shared/pos-online/adminRefundGlue.ts)
import { cancelUberDelivery } from "../_shared/uberCancel.ts";
import { refundUberAppFee } from "../_shared/refundUberAppFee.ts";
// uber-create-delivery's shared core, imported UNCHANGED (the glue that calls it: _shared/pos-online/uberGlue.ts)
import { createUberDelivery } from "../_shared/uberCreateDelivery.ts";
// kh-order-action's KitchenHub client, imported UNCHANGED (the glue that calls it: _shared/pos-online/khGlue.ts)
import { khFetch } from "../_shared/khToken.ts";
import { handleDeviceHttp } from "../_shared/pos-sync/http.ts";
import { handleOnlineOrderAction, logErrorResponse } from "../_shared/pos-online/handlers.ts";
import { makeReadyEmail } from "../_shared/pos-online/readyEmail.ts";
import { PgOnlineStore } from "../_shared/pos-online/store.ts";
// the KitchenHub mapping reads, 30 s per restaurant keyed by the maps revision (one per function instance)
import { KhContextCache } from "../_shared/pos-online/khContextCache.ts";
import { consoleDeviceLog } from "../_shared/pos-device/log.ts";
import { PgDeviceStore } from "../_shared/pos-device/store.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const log = consoleDeviceLog("pos-v1-online-order-action");
const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
const deps = {
  store: new PgDeviceStore(supabase),
  db: supabase,
  online: new PgOnlineStore(supabase),
  khContext: new KhContextCache(),
  now: () => Date.now(),
  log,
  readyEmail: makeReadyEmail({ supabaseUrl: Deno.env.get("SUPABASE_URL")!, anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", log }),
  refund: stripeKey ? { stripe: new Stripe(stripeKey), cancelUberDelivery, refundUberAppFee } : undefined,
  uber: { createUberDelivery },
  khFetch,
};

// Every 4xx / 5xx is logged (status + error code + field — never a body or token): logErrorResponse.
Deno.serve(async (req: Request) =>
  logErrorResponse(
    deps.log,
    await handleDeviceHttp(req, (r) => handleOnlineOrderAction(r, deps), (msg) => deps.log("internal_error", { error: msg })),
  )
);
