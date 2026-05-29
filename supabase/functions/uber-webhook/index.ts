// ============================================================================
// uber-webhook — Process Uber Direct webhook events (M9b)
// ============================================================================
//
// Receives delivery_status, courier_update, refund_request, and
// shopping_progress events from Uber Direct's webhook stream. Verifies
// HMAC-SHA256 signature against the per-merchant
// uber_webhook_signing_secret (M9b.1 — a separately generated key
// registered in Uber's dashboard, distinct from the OAuth client_secret),
// dedupes by event_id, and updates the orders row with the new state.
//
// Multi-tenant design: a single DirectBite-owned webhook URL serves all
// restaurants. Each event payload contains a delivery_id that we use to
// look up the order, and from there the restaurant whose secret signs
// the event. This is the chicken/egg of multi-tenant webhooks — we must
// look up the order BEFORE we can verify the signature (we don't know
// the secret a priori). The lookup is a single indexed read with no side
// effects, so it's safe to do unauthenticated. No DB WRITES happen
// before HMAC verification succeeds.
//
// JWT setting: verify_jwt = false (declared in supabase/config.toml).
// Uber does not carry Supabase JWTs — HMAC signature IS the auth
// mechanism. Handler refuses any request without a valid signature.
//
// Flow:
//   1. CORS preflight + method check (POST only).
//   2. Read RAW body via req.text() — CANNOT use req.json() (would
//      normalize whitespace/escapes and break the signature).
//   3. Extract signature header — try X-Uber-Signature first, fall back
//      to X-Postmates-Signature (legacy for delivery_status +
//      courier_update). Reject 401 if neither present.
//   4. Parse JSON for routing. Reject 400 if invalid.
//   5. Extract event_id, kind, delivery_id from payload. Return 200 +
//      log if delivery_id missing (cannot route; don't trigger Uber
//      retry storm).
//   6. Look up orders.uber_delivery_id JOIN restaurants for
//      uber_client_secret. Return 200 + log if order not found (could
//      be old test data or a spoofed event — silent drop without
//      retry).
//   7. Verify HMAC-SHA256. 401 + log if invalid. NO DB WRITES happen
//      before this gate.
//   8. Dedup via INSERT into uber_webhook_events. PG unique violation
//      (23505) on event_id PK → already processed, return 200
//      immediately. Audit trail captured here — payload jsonb stores
//      the entire body for future debugging.
//   9. Process event by kind:
//      - event.delivery_status → UPDATE orders SET uber_status,
//        uber_status_updated_at
//      - event.courier_update → UPDATE orders SET uber_courier_info,
//        uber_status_updated_at (full jsonb replace)
//      - event.refund_request → log only (deferred to v1.1)
//      - event.shopping_progress → log only (not applicable to pizzeria)
//      - unknown → log + 200
//  10. Return 200 + empty body.
//
// Error response shapes (all bodies empty to avoid leaking state to
// potentially-malicious callers):
//   - 405: method not allowed (non-POST)
//   - 400: invalid_body (raw read or JSON parse failure)
//   - 401: missing or invalid signature
//   - 500: DB error (Uber will retry; we want them to)
//   - 200: success, dedup hit, missing/unknown delivery_id, unknown
//     event kind, refund_request, shopping_progress
//
// Out-of-order events: last-write-wins per D#1 default. If 'pickup'
// arrives after 'delivered' due to Uber's retry queues, uber_status
// briefly regresses; the next webhook corrects. Acceptable for v1;
// upgrade to state-machine ordering (M9b.1) if real-world out-of-order
// events become a customer-facing problem.
//
// Risk to 8 production restaurants (all in_house):
//   - No in_house order has uber_delivery_id set → step 6 lookup
//     returns null → 200 + log → no writes.
//   - Spoofed events targeting a Test Pizza delivery_id: HMAC
//     verification (step 7) rejects without the merchant's secret.
//     No writes.
//   - Zero behavior change for in_house operations.
//
// Schema dependencies:
//   - orders.uber_delivery_id (migration 031) — lookup key
//   - orders.uber_status, uber_status_updated_at (migration 031) —
//     write targets for delivery_status
//   - orders.uber_courier_info (migration 031) — write target for
//     courier_update (jsonb full replace)
//   - restaurants.uber_webhook_signing_secret (migration 036) — primary
//     HMAC key (per-restaurant, generated during onboarding and pasted
//     into Uber's dashboard webhook config)
//   - restaurants.uber_client_secret (migration 031) — fallback HMAC
//     key for transitional state; removed in M9b.2 once all uber_direct
//     restaurants have signing_secret populated
//   - uber_webhook_events table (migration 034) — dedup + audit trail
// ============================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { verifyUberSignature } from "../_shared/uberSignature.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-uber-signature, x-postmates-signature",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// PG unique_violation error code; raised when INSERT collides with the
// event_id PRIMARY KEY on uber_webhook_events. Supabase surfaces the
// raw PG SQLSTATE in PostgrestError.code.
const PG_UNIQUE_VIOLATION = "23505";

// M9c: terminal Uber delivery states. Once uber_status is one of these,
// the delivery_status handler stops accepting regressions from out-of-order
// webhook events. The bug this fixes surfaced in M9c smoke testing: after
// uberCancel.ts sets uber_status='canceled' during cancel+refund, the still-
// live Robocourier emitted later events (pickup, pickup_complete, …) that
// last-write-wins happily overwrote 'canceled' back to a non-terminal state.
// 'canceled' is set by uberCancel.ts; the others are Uber's natural terminal
// states. Spelling: Uber uses 'canceled' (one L) — matches uber_status
// throughout, distinct from orders.status 'cancelled' (two L's).
const TERMINAL_UBER_STATUSES = new Set([
  "delivered",
  "canceled",
  "failed",
  "returned",
]);

// Return 200 + empty body — used for success and silent-drop cases
// (missing delivery_id, no matching order, unknown event kind, dedup
// hit). Empty body avoids any information disclosure.
function ackResponse(): Response {
  return new Response(null, { status: 200, headers: corsHeaders });
}

// Return error with status code and empty body. Uber retries on
// non-2xx with exponential backoff (1s, 2s, 4s, ..., up to 7 attempts);
// the empty body avoids leaking internal state to a potentially-
// malicious caller.
function errorResponse(status: number): Response {
  return new Response(null, { status, headers: corsHeaders });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse(405);
  }

  // -------- Step 2: read RAW body --------
  // MUST use text(), not json(). The signature is over the exact bytes
  // received; JSON.parse + JSON.stringify would normalize whitespace
  // and \uXXXX escapes, producing a different byte sequence that won't
  // match Uber's signature.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    console.error("[uber-webhook] failed to read request body", err);
    return errorResponse(400);
  }

  // -------- Step 3: extract signature header --------
  // Try X-Uber-Signature first (newer), fall back to X-Postmates-
  // Signature (legacy for delivery_status + courier_update). HTTP
  // header names are case-insensitive; Deno's req.headers normalizes
  // to lowercase access.
  const signatureHeader =
    req.headers.get("x-uber-signature") ||
    req.headers.get("x-postmates-signature");

  if (!signatureHeader) {
    console.warn("[uber-webhook] rejected: missing signature header");
    return errorResponse(401);
  }

  // -------- Step 4: parse JSON for routing --------
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    console.error("[uber-webhook] failed to parse JSON body", err);
    return errorResponse(400);
  }

  // -------- Step 5: extract event metadata --------
  const eventId: string | undefined = parsed?.event_id;
  const kind: string | undefined = parsed?.kind;
  // Uber's docs use 'delivery_id' at top level for delivery_status and
  // courier_update. Some event types may nest it under data.delivery_id;
  // fall back defensively.
  const deliveryId: string | undefined =
    parsed?.delivery_id || parsed?.data?.delivery_id;

  if (!deliveryId) {
    // Cannot route without a delivery_id. Log + 200 (don't trigger
    // Uber retry storm for malformed events).
    console.warn("[uber-webhook] dropped: no delivery_id in payload", {
      kind,
      event_id: eventId,
    });
    return ackResponse();
  }

  // -------- Step 6: look up order + restaurant (FK join) --------
  // Single Supabase query: order row + joined webhook signing secret
  // (with client_secret as a fallback per M9b.1). Service-role bypasses
  // RLS so cross-restaurant access is intentional and safe. This is the
  // ONLY read before signature verification; the lookup itself has no
  // side effects.
  //
  // M9b.1: Webhook signature uses uber_webhook_signing_secret (separate
  // from OAuth client_secret per Uber's dashboard configuration). Fall
  // back to client_secret for transitional state — should be removed
  // once all restaurants have signing_secret populated.
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id, uber_status, uber_courier_info, restaurant_id,
      restaurants:restaurant_id (uber_client_secret, uber_webhook_signing_secret)
    `)
    .eq("uber_delivery_id", deliveryId)
    .maybeSingle();

  if (orderErr) {
    console.error("[uber-webhook] order lookup failed", {
      error: orderErr,
      delivery_id: deliveryId,
    });
    return errorResponse(500);
  }
  if (!order) {
    // No order has this delivery_id. Could be:
    //   - Stale test data from a wiped restaurant
    //   - Spoofed event with fabricated delivery_id
    //   - Webhook arriving before our DB write completed (extremely
    //     rare race; Uber's webhook latency is typically slower than
    //     our atomic UPDATE after create-delivery returns 201)
    // In all cases: log + 200. Don't trigger Uber retry; don't write.
    console.warn("[uber-webhook] dropped: no order for delivery_id", {
      delivery_id: deliveryId,
      kind,
      event_id: eventId,
    });
    return ackResponse();
  }

  // Extract the joined webhook signing secret. Supabase's FK join
  // returns the joined row as a nested object (or null). The TS
  // generics for embedded selects are awkward, so we cast through `any`.
  // Prefer uber_webhook_signing_secret (M9b.1 dedicated column); fall
  // back to uber_client_secret for restaurants migrated before the
  // signing_secret column was populated.
  const restaurantRow = (order as any).restaurants;
  const signingSecret: string | undefined =
    restaurantRow?.uber_webhook_signing_secret ||
    restaurantRow?.uber_client_secret;
  if (!signingSecret) {
    // FK-join produced no row, or restaurant has neither secret set.
    // The first is impossible (FK is enforced); the second means the
    // operator deleted credentials between dispatch and now. Either
    // way: cannot verify. Return 500 — Uber retries; gives the
    // operator time to fix credentials before the retry budget
    // exhausts.
    console.error(
      "[uber-webhook] no signing secret for order's restaurant",
      { order_id: order.id, restaurant_id: order.restaurant_id }
    );
    return errorResponse(500);
  }

  // -------- Step 7: verify HMAC signature --------
  // This is the security gate. NO database writes happen before this
  // succeeds. (The order lookup at step 6 is a read-only side effect
  // touching an indexed column; it doesn't reveal anything an attacker
  // couldn't already guess.)
  const validSignature = await verifyUberSignature(
    rawBody,
    signatureHeader,
    signingSecret
  );
  if (!validSignature) {
    console.warn("[uber-webhook] rejected: invalid signature", {
      delivery_id: deliveryId,
      kind,
      event_id: eventId,
      order_id: order.id,
    });
    return errorResponse(401);
  }
  // Past this point, event is authenticated.

  // -------- Step 8: dedup + audit trail --------
  // INSERT into uber_webhook_events. The event_id PRIMARY KEY enforces
  // dedup at the DB layer. PG raises unique_violation (code 23505) on
  // collision; we treat that as "already processed" and return 200
  // without re-running the event handler.
  //
  // The payload jsonb column captures the entire body for audit /
  // future debugging. Done BEFORE the orders update so even if the
  // update fails (and Uber retries), we have a record of every
  // verified webhook that touched the system.
  if (eventId) {
    const { error: dedupErr } = await supabase
      .from("uber_webhook_events")
      .insert({
        event_id: eventId,
        order_id: order.id,
        event_kind: kind || "unknown",
        payload: parsed,
      });
    if (dedupErr) {
      if (dedupErr.code === PG_UNIQUE_VIOLATION) {
        // Already processed. Return 200 immediately — don't re-run
        // the event handler. (Uber's docs say events may be delivered
        // multiple times.)
        return ackResponse();
      }
      console.error("[uber-webhook] dedup insert failed", {
        error: dedupErr,
        event_id: eventId,
      });
      return errorResponse(500);
    }
  } else {
    // No event_id in payload — skip dedup, process anyway. Uber's
    // docs guarantee event_id presence, but defensive code shouldn't
    // drop events on a missing-field edge case.
    console.warn(
      "[uber-webhook] processing event without event_id (no dedup)",
      { kind, delivery_id: deliveryId, order_id: order.id }
    );
  }

  // -------- Step 9: process event by kind --------
  const nowIso = new Date().toISOString();

  switch (kind) {
    case "event.delivery_status": {
      const newStatus: string | undefined = parsed?.status;
      if (typeof newStatus !== "string") {
        console.warn(
          "[uber-webhook] delivery_status missing status field",
          { order_id: order.id, event_id: eventId }
        );
        return ackResponse();
      }
      // M9c: terminal-state protection. Once the order reached a terminal
      // uber_status (delivered / canceled / failed / returned), do NOT let a
      // later out-of-order event regress it. Notably guards the cancel+refund
      // cascade: uberCancel.ts sets 'canceled', and we must not un-cancel it
      // when the released courier's trailing events arrive. order.uber_status
      // was read at step 6 (the lookup that routed this event), so the check
      // is in-memory — no extra query. Skip the write, still ack 200 so Uber
      // stops retrying.
      if (TERMINAL_UBER_STATUSES.has(order.uber_status ?? "")) {
        console.log(
          "[uber-webhook] delivery_status ignored — order in terminal state",
          {
            order_id: order.id,
            current: order.uber_status,
            incoming: newStatus,
            event_id: eventId,
          }
        );
        return ackResponse();
      }

      // Last-write-wins for non-terminal transitions. Out-of-order events
      // among non-terminal states are accepted; next webhook corrects.
      const statusUpdate: Record<string, unknown> = {
        uber_status: newStatus,
        uber_status_updated_at: nowIso,
      };
      // Migration 037: capture live dropoff ETA when the payload carries it.
      // Only write a valid string — never null out a previously-set ETA when
      // an event omits the field. parsed.data may be absent on some events;
      // optional chaining keeps the handler from crashing.
      const deliveryEta = parsed?.data?.dropoff_eta;
      if (typeof deliveryEta === "string" && deliveryEta) {
        statusUpdate.uber_dropoff_eta = deliveryEta;
      }
      const { error: statusErr } = await supabase
        .from("orders")
        .update(statusUpdate)
        .eq("id", order.id);
      if (statusErr) {
        console.error("[uber-webhook] orders update (status) failed", {
          error: statusErr,
          order_id: order.id,
        });
        return errorResponse(500);
      }
      break;
    }

    case "event.courier_update": {
      const courier = parsed?.data?.courier;
      if (!courier || typeof courier !== "object") {
        console.warn(
          "[uber-webhook] courier_update missing data.courier",
          { order_id: order.id, event_id: eventId }
        );
        return ackResponse();
      }
      // M9c: once we've actively canceled the delivery (uber_status =
      // 'canceled'), the courier is no longer ours — stop ingesting its
      // location/courier updates. This also prevents uber_status_updated_at
      // from churning on a canceled order. Note: D8 keeps courier updates
      // flowing for 'delivered' (ops may want the final courier location),
      // so only 'canceled' is excluded here — not the full terminal set.
      if (order.uber_status === "canceled") {
        console.log(
          "[uber-webhook] courier_update ignored — delivery canceled",
          { order_id: order.id, event_id: eventId }
        );
        return ackResponse();
      }

      // Full jsonb replace (not merge) per D#2. Future fields Uber
      // adds are captured automatically. Touches uber_status_updated_at
      // to signal recent activity even though uber_status itself
      // doesn't change here. Writes on every event (~20s cadence) per
      // D#2 default; PG handles the volume trivially.
      const courierUpdate: Record<string, unknown> = {
        uber_courier_info: courier,
        uber_status_updated_at: nowIso,
      };
      // Migration 037: courier_update events also carry dropoff_eta alongside
      // the courier object under data. Capture it when valid; never null out
      // a previously-set ETA.
      const courierEta = parsed?.data?.dropoff_eta;
      if (typeof courierEta === "string" && courierEta) {
        courierUpdate.uber_dropoff_eta = courierEta;
      }
      const { error: courierErr } = await supabase
        .from("orders")
        .update(courierUpdate)
        .eq("id", order.id);
      if (courierErr) {
        console.error(
          "[uber-webhook] orders update (courier) failed",
          { error: courierErr, order_id: order.id }
        );
        return errorResponse(500);
      }
      break;
    }

    case "event.refund_request":
      // Deferred to v1.1 per locked decision. Payload already
      // persisted to uber_webhook_events.payload at step 8 for future
      // audit / manual review by ops.
      console.log(
        "[uber-webhook] refund_request received (deferred to v1.1)",
        { order_id: order.id, event_id: eventId }
      );
      break;

    case "event.shopping_progress":
      // Not applicable to pizzeria orders (Uber Direct grocery
      // integration only). Log + 200.
      console.log("[uber-webhook] shopping_progress (not applicable)", {
        order_id: order.id,
        event_id: eventId,
      });
      break;

    default:
      // Unknown event kind. Don't reject — Uber may add new event
      // types we'd want to silently accept rather than retry-storm.
      // Payload is persisted to uber_webhook_events for later review.
      console.log("[uber-webhook] unknown event kind", {
        kind,
        order_id: order.id,
        event_id: eventId,
      });
  }

  // -------- Step 10: acknowledge --------
  return ackResponse();
});
