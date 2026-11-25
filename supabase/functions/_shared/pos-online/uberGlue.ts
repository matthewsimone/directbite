/**
 * Uber for online orders from a register (CP20): dispatch_delivery = uber-create-delivery, self_deliver =
 * uber-self-deliver — their logic UNCHANGED. The shared modules are IMPORTED UNCHANGED by the entry point and passed
 * in: _shared/uberCreateDelivery.ts createUberDelivery (the same in-process core uber-create-delivery and
 * stripe-webhook call), _shared/uberCancel.ts cancelUberDelivery, _shared/refundUberAppFee.ts refundUberAppFee.
 *
 * COPIED web handler glue, each range pinned by hash (_shared/pos-online/webPins.json; scripts/check-ordr-core.mjs
 * fails if a range changes or this file stops citing its hash — then re-copy, re-review, re-pin):
 *   uber-create-delivery/index.ts :170-182  sha256 4339fd63ea3c250892a6213a54a6e4ee88d8b0fdd55ad7872d0cbdb57fa51387
 *     (pickup_ready_dt must be in the future)
 *   uber-create-delivery/index.ts :212-233  sha256 5bb22a6e385d7d863fe2ea09835950ef3fd5113b3e46a42a6ac3f2204f417c76
 *     (the order + restaurant select handed to createUberDelivery)
 *   uber-create-delivery/index.ts :266-315  sha256 39825159b1873e80e0246a33c47a709c83d321f8688bb03552a77164af75595b
 *     (scheduled lead time, migration 096; the createUberDelivery call)
 *   uber-self-deliver/index.ts    :100-112  sha256 5b56b8282b9fe7b9a3e6d4054e4bb0031bdf0392153e82af84f815332ae0124d
 *     (the order + restaurant select)
 *   uber-self-deliver/index.ts    :143-187  sha256 f269551317e4bd50b4c5ebc48d2ba72d30605958c12604d0496ecc71dc3d0a3e
 *     (cancel Uber → self_delivering + cancelled_by → app-fee walk-back)
 *
 * The copies differ from the web lines ONLY in:
 *   1. every `return jsonResponse(…)` → a typed result (handlers.ts maps it to the §3c wire);
 *   2. the request fields the tablet sends are given by the register: ASAP → pickup_ready_minutes = prep_minutes;
 *      scheduled (order.scheduled_for set) → pickup_ready_dt = order.scheduled_for — exactly the tablet's choice
 *      (OrdersTab.jsx :764-786); pickup_deadline_minutes is never sent (the tablet never sends it);
 *   3. console.log / console.error → the injected log (same facts);
 *   4. the order + restaurant fetch is split from the rest so the caller's compare-and-set runs between them
 *      (the select itself is verbatim).
 * The web handler's auth (tablet email / admin) is replaced by the device middleware + the restaurant check; its
 * pickup_ready_minutes 1–240 check by the contract's 5–120 (handlers.ts).
 */

// deno-lint-ignore-file no-explicit-any

export interface UberGlueDeps {
  /** Service-role supabase-js client — the same client the web functions use. */
  supabase: any;
  /** The platform Stripe client (STRIPE_SECRET_KEY) — uber-self-deliver's, for refundUberAppFee. */
  stripe: any;
  createUberDelivery: (supabase: any, order: any, restaurant: any, opts: any) => Promise<{ status: number; body: Record<string, unknown> }>;
  cancelUberDelivery: (supabase: any, order: any, restaurant: any) => Promise<
    { success: true; alreadyCanceled?: boolean; uberFee?: number } | { success: false; error: string; detail?: unknown; status?: number; retry_after?: unknown }
  >;
  refundUberAppFee: (stripe: any, order: any, restaurant: any, uberFeeCents?: number) => Promise<unknown>;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export type FetchResult =
  | { kind: 'ok'; order: any; restaurant: any }
  | { kind: 'db_error'; message: string }
  | { kind: 'order_not_found' | 'restaurant_not_found' };

// ---- dispatch_delivery = uber-create-delivery --------------------------------------------------------------

/** uber-create-delivery/index.ts :212-233 (+ :235-250 → typed results). */
export async function fetchForDispatch(d: UberGlueDeps, order_id: string): Promise<FetchResult> {
  const { supabase } = d;
  // -------- Fetch order + restaurant (FK join) --------
  // Service-role select bypasses RLS; ownership verified after fetch via
  // restaurants.tablet_email match (same pattern as uber-token).
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id, order_number, status, delivery_fulfillment_method,
      uber_quote_id, uber_delivery_id, uber_tracking_url, uber_status,
      accepted_at, restaurant_id, customer_name, customer_phone,
      delivery_address, special_instructions,
      dropoff_lat, dropoff_lng,
      subtotal, tip_amount, scheduled_for,
      restaurants:restaurant_id (
        id, name, address, phone, latitude, longitude,
        uber_customer_id, uber_environment, uber_billing_mode,
        uber_passthrough_mode, uber_passthrough_value,
        uber_scheduled_lead_minutes,
        tablet_email
      )
    `)
    .eq("id", order_id)
    .maybeSingle();

  if (orderErr) return { kind: 'db_error', message: orderErr.message };
  if (!order) return { kind: 'order_not_found' };
  const restaurant = (order as any).restaurants;
  if (!restaurant) return { kind: 'restaurant_not_found' };
  return { kind: 'ok', order, restaurant };
}

export type DispatchResult =
  /** uber-create-delivery :170-182 — the scheduled slot is not in the future (400 invalid_inputs) */
  | { kind: 'pickup_ready_dt_invalid' }
  /** createUberDelivery's { status, body }, relayed verbatim (uber-create-delivery :298-316) */
  | { kind: 'result'; status: number; body: Record<string, unknown> };

/**
 * The rest of uber-create-delivery after the fetch: the pickup_ready_dt check (:170-182), the scheduled lead time
 * (:266-288) and the createUberDelivery call (:290-315). ASAP ⇔ order.scheduled_for is null (the tablet's rule).
 */
export async function dispatchFetched(
  d: UberGlueDeps, order: any, restaurant: any, input: { pickup_ready_minutes: number | null; accepted_quote_id: string | null },
): Promise<DispatchResult> {
  const { supabase, createUberDelivery } = d;
  const hasPickupDt = order.scheduled_for != null;
  const pickup_ready_dt: string | undefined = hasPickupDt ? order.scheduled_for : undefined;
  const pickup_ready_minutes = input.pickup_ready_minutes;
  const pickup_deadline_minutes: number | undefined = undefined;
  const accepted_quote_id = input.accepted_quote_id ?? undefined;

  // ---- uber-create-delivery/index.ts :170-182 ----
  if (hasPickupDt) {
    const parsedDt =
      typeof pickup_ready_dt === "string" ? Date.parse(pickup_ready_dt) : NaN;
    if (Number.isNaN(parsedDt) || parsedDt <= Date.now()) {
      return { kind: 'pickup_ready_dt_invalid' };
    }
  }

  // ---- uber-create-delivery/index.ts :266-315 ----
  // -------- Scheduled lead time (migration 096) --------
  // Scheduled path only: ask Uber to pick up uber_scheduled_lead_minutes
  // before the customer's slot instead of at it, floored to now + 5 min.
  // NULL lead → pickup_ready_dt passes through unchanged.
  let effectivePickupReadyDt = pickup_ready_dt;
  if (hasPickupDt) {
    const leadRaw = restaurant.uber_scheduled_lead_minutes;
    if (order.scheduled_for && leadRaw != null) {
      const lead = Math.min(60, Math.max(10, Number(leadRaw)));
      const target = Date.parse(order.scheduled_for) - lead * 60_000;
      const floor = Date.now() + 5 * 60_000;
      effectivePickupReadyDt = new Date(Math.max(target, floor)).toISOString();
      d.log('scheduled_lead_applied', {
        order_id: order.id,
        scheduled_for: order.scheduled_for,
        lead_minutes: lead,
        requested_pickup_ready_dt: pickup_ready_dt,
        effective_pickup_ready_dt: effectivePickupReadyDt,
      });
    }
  }

  // -------- Delegate to shared core --------
  // All Uber business logic (fulfillment-mode check, idempotency, quote
  // resolve/refresh, price guard, manifest, POST, DB write) lives in
  // _shared/uberCreateDelivery.ts so stripe-webhook can reuse it in-process
  // for scheduled-order booking (step 2). The handler owns transport only:
  // auth, input validation, order/restaurant fetch + ownership. The ASAP/
  // tablet path passes relative minutes and transitions to 'in_progress',
  // exactly as before — the helper's { status, body } is relayed verbatim.
  const result = await createUberDelivery(
    supabase,
    order,
    restaurant,
    hasPickupDt
      ? {
          pickupReadyDt: effectivePickupReadyDt,
          pickupDeadlineMinutes: pickup_deadline_minutes,
          acceptedQuoteId: accepted_quote_id,
          postWriteStatus: "scheduled",
        }
      : {
          pickupReadyMinutes: pickup_ready_minutes,
          pickupDeadlineMinutes: pickup_deadline_minutes,
          acceptedQuoteId: accepted_quote_id,
          postWriteStatus: "in_progress",
        }
  );
  return { kind: 'result', status: result.status, body: result.body };
}

// ---- self_deliver = uber-self-deliver -----------------------------------------------------------------------

/** uber-self-deliver/index.ts :100-112 (+ :114-128 → typed results). */
export async function fetchForSelfDeliver(d: UberGlueDeps, order_id: string): Promise<FetchResult> {
  const { supabase } = d;
  // -------- Fetch order + restaurant (FK join) --------
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id, status, delivery_fulfillment_method, uber_status, uber_delivery_id,
      stripe_charge_id, restaurant_id,
      restaurants:restaurant_id (
        id, uber_customer_id, uber_environment, uber_billing_mode,
        stripe_account_id, tablet_email
      )
    `)
    .eq("id", order_id)
    .maybeSingle();

  if (orderErr) return { kind: 'db_error', message: orderErr.message };
  if (!order) return { kind: 'order_not_found' };
  const restaurant = (order as any).restaurants;
  if (!restaurant) return { kind: 'restaurant_not_found' };
  return { kind: 'ok', order, restaurant };
}

export type SelfDeliverResult =
  /** :148-156 — the Uber delivery could not be released: NO status change */
  | { kind: 'cancel_failed'; error: string; detail: unknown; retry_after: unknown }
  /** :167-176 — the orders update failed (500 db_error) */
  | { kind: 'db_error'; message: string }
  /** :184-187 — self_delivering, the app fee walked back */
  | { kind: 'ok' };

/** uber-self-deliver/index.ts :143-187 after the fetch. */
export async function selfDeliverFetched(d: UberGlueDeps, order: any, restaurant: any, order_id: string): Promise<SelfDeliverResult> {
  const { supabase, stripe, cancelUberDelivery, refundUberAppFee } = d;

  // ---- uber-self-deliver/index.ts :143-187 ----
  // -------- Release the Uber delivery --------
  // cancelUberDelivery handles the pending → Uber /cancel call ($0 fee at
  // pending), and short-circuits success if the order was never dispatched or
  // is already canceled. It sets uber_status='canceled' on success.
  const cancel = await cancelUberDelivery(supabase, order, restaurant);
  if (!cancel.success) {
    // Spec: abort, no status change. Surface the error so the tablet can tell
    // the operator the Uber delivery couldn't be released.
    return { kind: 'cancel_failed', error: cancel.error, detail: cancel.detail, retry_after: cancel.retry_after };
  }

  // -------- Transition to self-delivering (NO refund) --------
  const { error: updateErr } = await supabase
    .from("orders")
    .update({
      status: "self_delivering",
      cancelled_by: "restaurant_self_deliver",
    })
    .eq("id", order_id);

  if (updateErr) {
    d.log('self_deliver_update_failed', { order_id, error: updateErr.message });
    return { kind: 'db_error', message: updateErr.message };
  }

  // Platform billing: the Uber delivery is released and the restaurant is now
  // driving it themselves. DirectBite fronted the Uber fee + upfront tip via
  // the application fee and will never pay Uber, so that portion goes back to
  // the connected account. Never throws and never gates the response — the
  // order is already 'self_delivering' and the operator must not see a failure.
  // Self mode no-ops inside the helper.
  await refundUberAppFee(stripe, order as any, restaurant, cancel.uberFee);

  d.log('self_deliver_done', { order_id });
  return { kind: 'ok' };
}
