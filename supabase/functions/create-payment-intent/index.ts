import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";
import { resolveMode, RestaurantForMode } from "../_shared/uberMode.ts";
import { applyPassthrough } from "../_shared/uberPassthrough.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Great-circle distance in miles. Mirrors src/utils/haversine.js
// (haversineDistanceMiles) exactly — same earth radius, same formula — so the
// server's radius verdict matches the distance the customer was shown. Local
// rather than imported, following hashToken's precedent below.
const EARTH_RADIUS_MILES = 3958.8;
function haversineDistanceMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Duplicated from customer-auth (its lines 91-99) rather than imported —
// edge functions do not share a module here. MUST stay identical: a
// different digest would never match a stored token_hash.
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Resolves the customer behind a session token, for the redemption ownership
// check below.
//
// Tri-state on purpose. "No valid session" and "we could not tell" must not
// collapse into one answer: the first is the customer's problem to fix by
// signing in, the second is ours, and telling a signed-in customer to sign in
// because a database read blipped would be a lie they cannot act on.
//
// This duplicates the session validation in the Stripe Customer block further
// down rather than sharing it. That block is deliberately non-fatal — it
// swallows every failure and falls through to a guest checkout — which is the
// opposite posture from a gate that must reject. Merging them would mean one of
// the two behaviours quietly changing.
type SessionLookup =
  | { status: "ok"; customerId: string }
  | { status: "no_session" }
  | { status: "read_error"; message: string };

async function resolveSessionCustomer(
  sessionToken: unknown
): Promise<SessionLookup> {
  if (typeof sessionToken !== "string" || !sessionToken.trim()) {
    return { status: "no_session" };
  }

  try {
    const tokenHash = await hashToken(sessionToken);
    const { data: session, error } = await supabase
      .from("customer_sessions")
      .select("customer_id, revoked_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (error) return { status: "read_error", message: error.message };

    // Missing, revoked and expired are one answer to the caller — the same
    // collapse customer-auth makes, so a caller cannot probe for which tokens
    // exist.
    if (
      !session ||
      session.revoked_at !== null ||
      new Date(session.expires_at).getTime() < Date.now()
    ) {
      return { status: "no_session" };
    }

    return { status: "ok", customerId: session.customer_id };
  } catch (err: any) {
    return { status: "read_error", message: err?.message || "lookup threw" };
  }
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // session_token is TOP LEVEL, never inside order_data: order_data is
    // persisted wholesale into pending_orders, and a session token written
    // there would be a 365-day credential sitting in plaintext.
    const { restaurant_id, amount, order_data, payment_intent_id, idempotency_key, session_token } = await req.json();

    if (!restaurant_id || !amount) {
      return new Response(
        JSON.stringify({ error: "restaurant_id and amount are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up restaurant's Stripe Connect account + M6 mode-resolution fields
    const { data: restaurant, error: restErr } = await supabase
      .from("restaurants")
      .select(
        `stripe_account_id, name,
         delivery_fulfillment, uber_credentials_verified_at,
         uber_direct_active, uber_schedule,
         uber_passthrough_mode, uber_passthrough_value,
         delivery_minimum_in_house, delivery_minimum_uber_direct,
         uber_billing_mode, latitude, longitude,
         delivery_max_radius_miles, uber_extends_delivery, uber_max_radius_miles`
      )
      .eq("id", restaurant_id)
      .single();

    if (restErr || !restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurant not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!restaurant.stripe_account_id) {
      return new Response(
        JSON.stringify({ error: "Restaurant has not connected Stripe" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // -------- M6: server-side mode resolution + quote validation --------
    // Defensive: ignore the client's claim of delivery_fulfillment_method
    // from order_data. Re-resolve from restaurant config (and current NY
    // time, in case the 'both' mode schedule lapses mid-checkout).
    // M-uz: the client's extended_zone claim counts only when this restaurant
    // actually opted in AND is configured in_house — the only shape where an
    // extended zone means anything. Same re-check uber-quote performs.
    const extendedZone =
      order_data?.extended_zone === true &&
      restaurant.uber_extends_delivery === true &&
      restaurant.delivery_fulfillment === "in_house";
    const resolution = resolveMode(restaurant as RestaurantForMode, undefined, extendedZone);
    const serverResolvedMode = resolution.resolved_mode;

    // M6.5: Pickup orders never need delivery quote validation regardless
    // of the restaurant's resolved fulfillment mode. Short-circuit to the
    // in_house else-branch behavior so payment intent creation isn't
    // blocked for pickup customers on uber_direct restaurants. Without
    // this gate, every pickup order on a uber_direct restaurant rejects
    // with quote_validation_failed/missing_quote_id and the customer
    // sees the spinner-of-death.
    const isPickup = order_data?.order_type === "pickup";

    // Helper to return structured validation errors. Customer sees a generic
    // toast ("Delivery quote changed. Please try again."); the granular
    // reason is for telemetry / console.error only.
    function validationError(reason: string, detail?: string): Response {
      console.error("[create-payment-intent] quote validation failed", {
        reason,
        detail,
        restaurant_id,
        quote_id: order_data?.uber_quote_id,
      });
      return new Response(
        JSON.stringify({
          error: "quote_validation_failed",
          reason,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Server-side delivery-minimum guard (Step B). Mirrors the client check so a
    // crafted request can't bypass it. Delivery only; no-op when the minimum is 0.
    // Mode picked by serverResolvedMode (resolveMode already collapses 'both').
    //
    // The floor is revenue, not menu prices: measured after any promotion AND
    // after a discount reward, which is CheckoutPage's netSubtotal. order_data
    // carries the promotion (discount_amount) but deliberately carries nothing
    // about the reward except its id — trusting an amount from the client here
    // would let a crafted request lower the very floor it has to clear.
    //
    // Hence the hoisted read below. The full redemption block further down owns
    // the authoritative loyaltyDiscountCents, but it runs 100+ lines after this
    // guard; re-reading the one column keeps this check in place rather than
    // reordering that block's seven rejections ahead of this one.
    if (!isPickup) {
      const minDollars = serverResolvedMode === 'uber_direct'
        ? Number(restaurant.delivery_minimum_uber_direct || 0)
        : Number(restaurant.delivery_minimum_in_house || 0);
      if (minDollars > 0) {
        let rewardDiscountCents = 0;
        if (order_data?.loyalty_redemption_id) {
          const { data: claimed } = await supabase
            .from("loyalty_redemptions")
            .select("discount_cents, reward_kind")
            .eq("id", order_data.loyalty_redemption_id)
            .eq("restaurant_id", restaurant_id)
            .maybeSingle();
          // Only a discount reward moves this figure — an item reward is
          // already a zero-priced line, the same reason loyaltyDiscountCents
          // below starts at 0. A missing, foreign or already-spent row
          // contributes nothing and is rejected by the block below, not here:
          // this guard's job is the floor, and claiming a bad id must not
          // quietly relax it.
          if (claimed?.reward_kind === "discount") {
            rewardDiscountCents = Number(claimed.discount_cents || 0);
          }
        }
        // Cents throughout, floored at 0: an over-large reward displays at face
        // value on the client, so the subtraction can go negative.
        const netSubtotalCents = Math.max(
          0,
          Math.round(Number(order_data?.subtotal || 0) * 100) -
            Math.round(Number(order_data?.discount_amount || 0) * 100) -
            rewardDiscountCents
        );
        const minCents = Math.round(minDollars * 100);
        if (netSubtotalCents < minCents) {
          return validationError(
            "below_minimum",
            `mode=${serverResolvedMode} net=${netSubtotalCents} min=${minCents}`
          );
        }
      }
    }

    // Platform-billing application fee. Defaults to the flat $1.50 (150¢) for
    // self mode, pickup, and in-house — byte-identical to pre-Phase-2 behavior.
    // For a PLATFORM-billed uber_direct order, DirectBite fronts the Uber fee on
    // its own card and recoups it via the Stripe application fee, so the fee
    // becomes 150 + the full Uber quoted fee. The customer/restaurant split is
    // already handled by the passthrough on the customer-facing delivery_fee.
    const isPlatform = (restaurant.uber_billing_mode ?? "self") === "platform";
    let applicationFeeCents = 150;

    // Set by the validation block below when a discount reward is claimed.
    // Item rewards are already free in the line items, so they contribute
    // nothing here.
    let loyaltyDiscountCents = 0;

    // -------- Loyalty redemption validation --------
    // The client sends only an id. Everything about the discount is read
    // from the row: the amount, the point cost, and whether it is still
    // claimable. A forged or foreign id fails here rather than producing
    // a cheap order.
    const claimedRedemptionId = order_data?.loyalty_redemption_id;
    if (claimedRedemptionId) {
      const { data: redemption, error: redErr } = await supabase
        .from("loyalty_redemptions")
        .select("id, restaurant_id, customer_id, status, points_spent, reward_kind, discount_cents, reward_id, code_expires_at")
        .eq("id", claimedRedemptionId)
        .maybeSingle();

      if (redErr) {
        return validationError("redemption_read_error", redErr.message);
      }
      if (!redemption) {
        return validationError("redemption_not_found");
      }
      if (redemption.restaurant_id !== restaurant_id) {
        return validationError("redemption_wrong_restaurant");
      }

      // Ownership, checked before status or expiry because it is the more
      // fundamental failure: there is no point telling someone their reward
      // expired when it was never theirs to spend.
      //
      // A redemption is points already deducted from one customer's balance,
      // but the cart line carrying its id outlives the session that created it
      // — cart storage is keyed by restaurant with a two-hour TTL, never by
      // customer (useCart.jsx:10, :21). Without this gate a browser with no
      // session at all could still spend that reward for the remainder of the
      // 30-minute redemption TTL.
      //
      // Two codes because the remedies differ: signing in fixes the first,
      // only removing the line fixes the second. A read failure reuses the
      // existing redemption_read_error rather than blaming the customer for an
      // outage on our side.
      const sessionLookup = await resolveSessionCustomer(session_token);
      if (sessionLookup.status === "read_error") {
        return validationError("redemption_read_error", sessionLookup.message);
      }
      if (sessionLookup.status === "no_session") {
        return validationError("redemption_requires_signin");
      }
      if (sessionLookup.customerId !== redemption.customer_id) {
        return validationError("redemption_not_yours");
      }

      if (redemption.status !== "pending") {
        return validationError("redemption_not_pending", redemption.status);
      }
      if (
        redemption.code_expires_at &&
        new Date(redemption.code_expires_at).getTime() < Date.now()
      ) {
        return validationError("redemption_expired");
      }

      // The reward's own floor, evaluated against the paid subtotal. The
      // reward line itself prices at zero, so "spend $20 to use this" means
      // twenty dollars of other food.
      const { data: rewardRow } = await supabase
        .from("loyalty_rewards")
        .select("min_subtotal_cents")
        .eq("id", redemption.reward_id)
        .maybeSingle();

      const minCents = Number(rewardRow?.min_subtotal_cents || 0);
      if (minCents > 0) {
        // After any promotion, before the reward itself — the restaurant's
        // minimum is a revenue floor, not a menu-price floor. CheckoutPage
        // computes the same figure as discountedSubtotal; the two must agree.
        const paidSubtotalCents = Math.max(
          0,
          Math.round(Number(order_data?.subtotal || 0) * 100) -
            Math.round(Number(order_data?.discount_amount || 0) * 100)
        );
        if (paidSubtotalCents < minCents) {
          return validationError(
            "redemption_below_minimum",
            `subtotal=${paidSubtotalCents} min=${minCents}`
          );
        }
      }

      // Only a discount reward moves money at this level. An item reward's
      // value is already expressed as a zero-priced line.
      if (redemption.reward_kind === "discount") {
        loyaltyDiscountCents = Number(redemption.discount_cents || 0);
      }
    }
    // -------- End loyalty redemption validation --------

    if (!isPickup && serverResolvedMode === "uber_direct") {
      // Server says uber_direct. Client must have a uber_quote_id; if not, reject.
      const clientQuoteId: string | undefined = order_data?.uber_quote_id;
      if (!clientQuoteId || typeof clientQuoteId !== "string") {
        return validationError("missing_quote_id");
      }

      // Lookup in cache. uber-quote wrote here at quote time; client cannot
      // fabricate a quote_id because we'd have no matching row.
      const { data: cachedQuote, error: cacheReadErr } = await supabase
        .from("uber_quotes")
        .select("*")
        .eq("quote_id", clientQuoteId)
        .maybeSingle();

      if (cacheReadErr) {
        return validationError("cache_read_error", cacheReadErr.message);
      }
      if (!cachedQuote) {
        return validationError("quote_not_found");
      }

      // Cross-restaurant attack defense: claimed quote must belong to the
      // restaurant the order is being placed at.
      if (cachedQuote.restaurant_id !== restaurant_id) {
        return validationError("wrong_restaurant");
      }

      // Expiry: 60-second buffer so we don't lock a quote that's seconds
      // away from expiring (M9's create-delivery call would then fail).
      const expiresAtMs = new Date(cachedQuote.expires_at).getTime();
      if (expiresAtMs < Date.now() + 60 * 1000) {
        return validationError("quote_expired");
      }

      // Recompute the customer-side fee using the cached Uber-side fee +
      // the restaurant's CURRENT passthrough policy. If the restaurant
      // changed passthrough between quote and lock, this catches it.
      const recomputed = applyPassthrough(
        cachedQuote.uber_quoted_fee_cents,
        restaurant.uber_passthrough_mode,
        Number(restaurant.uber_passthrough_value || 0)
      );

      if (recomputed.customer_cents !== cachedQuote.customer_delivery_fee_cents) {
        // Passthrough changed mid-checkout. Per Decision C, reject and
        // force re-quote (no mid-flow re-confirmation).
        return validationError(
          "passthrough_changed",
          `cached=${cachedQuote.customer_delivery_fee_cents} recomputed=${recomputed.customer_cents}`
        );
      }

      const serverValidatedFeeCents = cachedQuote.customer_delivery_fee_cents;

      // Platform billing: recoup the FULL Uber fee AND the tip DirectBite fronts.
      // (Self mode leaves applicationFeeCents at the default 150.)
      // The tip recoup must byte-match what dispatch actually fronts to Uber:
      // _shared/uberCreateDelivery.ts sends `tip: Math.min(tipCents, 500)` (the
      // $5 upfront cap). We recoup exactly that — no more (the over-$5 tip stays
      // in the restaurant's balance, never sent to Uber), no less (DirectBite
      // would otherwise eat the fronted tip).
      if (isPlatform) {
        const frontedTipCents = Math.min(
          Math.round(Number(order_data?.tip_amount || 0) * 100),
          500
        );
        applicationFeeCents =
          150 + cachedQuote.uber_quoted_fee_cents + frontedTipCents;
      }

      // Total-amount validation: client's `amount` (in cents) must equal
      // what we'd compute server-side from order_data subtotal/tax/tip/
      // service + the cached customer delivery fee. ±2-cent tolerance
      // for float drift (D-1).
      const od = order_data || {};
      const expectedAmountCents =
        Math.round(Number(od.subtotal || 0) * 100) +
        Math.round(Number(od.tax_amount || 0) * 100) +
        Math.round(Number(od.tip_amount || 0) * 100) +
        Math.round(Number(od.service_fee || 1.5) * 100) +
        serverValidatedFeeCents -
        Math.round(Number(od.discount_amount || 0) * 100) -
        loyaltyDiscountCents;

      if (Math.abs(Number(amount) - expectedAmountCents) > 2) {
        return validationError(
          "amount_mismatch",
          `client_amount=${amount} expected=${expectedAmountCents}`
        );
      }

      // FIX③: backfill dropoff coords from the cached quote when the client's
      // order_data is missing them. The cached quote (migration 040) was priced
      // with these exact coords, so dispatching against them guarantees the
      // Uber delivery location matches the quote. This neutralizes the frontend
      // race where dropoff_lat/lng and uber_quote_id (independent async state)
      // could be snapshotted inconsistently into order_data.
      if (
        order_data &&
        (typeof order_data.dropoff_lat !== "number" ||
          typeof order_data.dropoff_lng !== "number") &&
        typeof cachedQuote.dropoff_lat === "number" &&
        typeof cachedQuote.dropoff_lng === "number"
      ) {
        console.warn(
          "[create-payment-intent] backfilling dropoff coords from cached quote",
          { quote_id: clientQuoteId, restaurant_id }
        );
        order_data.dropoff_lat = cachedQuote.dropoff_lat;
        order_data.dropoff_lng = cachedQuote.dropoff_lng;
      }

      // FIX①: coords are mandatory for a uber_direct delivery. After the
      // backfill above this only trips when the cache also lacks them (e.g. a
      // pre-migration-040 quote) — reject BEFORE charging, so we never create a
      // coordless order that Uber would later reject with "location changed".
      if (
        typeof order_data?.dropoff_lat !== "number" ||
        typeof order_data?.dropoff_lng !== "number"
      ) {
        return validationError("missing_dropoff_coords");
      }
    } else {
      // Server resolves to in_house. If client's order_data claims uber_*
      // fields, null them out before they hit pending_orders (defensive
      // against tampering that would otherwise propagate through
      // stripe-webhook's split-brain check).
      if (
        order_data &&
        (order_data.uber_quote_id ||
          order_data.uber_quoted_fee ||
          order_data.uber_environment)
      ) {
        console.warn(
          "[create-payment-intent] in_house mode but order_data claims uber fields; clearing",
          { restaurant_id, payment_intent_id }
        );
        order_data.uber_quote_id = null;
        order_data.uber_quoted_fee = null;
        order_data.uber_environment = null;
        order_data.delivery_fulfillment_method = "in_house";
      }
    }
    // -------- End M6 validation block --------

    // -------- Distance guard (delivery only) --------
    // The client picks the mode; the server decides whether the address actually
    // qualifies for it. Without this, a crafted order_data could claim uber_direct
    // for an address past the extended radius, or in_house for one past the tier
    // radius. Runs after the block above so dropoff coords are already backfilled
    // from the cached quote and already proven non-null for uber_direct.
    if (!isPickup) {
      const rLat = Number(restaurant.latitude);
      const rLng = Number(restaurant.longitude);
      const dLat = order_data?.dropoff_lat;
      const dLng = order_data?.dropoff_lng;

      if (
        Number.isFinite(rLat) && Number.isFinite(rLng) &&
        typeof dLat === "number" && typeof dLng === "number"
      ) {
        const distanceMiles = haversineDistanceMiles(rLat, rLng, dLat, dLng);
        // A plain uber_direct restaurant has no configured radius — Uber's own
        // quote defines serviceability — so only the two configured radii apply.
        const limitMiles = serverResolvedMode === "uber_direct"
          ? (extendedZone ? Number(restaurant.uber_max_radius_miles ?? 10) : null)
          : Number(restaurant.delivery_max_radius_miles ?? 0);

        if (limitMiles !== null && limitMiles > 0 && distanceMiles > limitMiles) {
          return validationError(
            "address_out_of_range",
            `mode=${serverResolvedMode} extended=${extendedZone} ` +
              `distance=${distanceMiles.toFixed(2)} limit=${limitMiles}`
          );
        }
      } else if (serverResolvedMode === "in_house") {
        // Warn rather than reject: an in_house order has never been required to
        // carry coords, and rejecting would break existing in-house restaurants.
        // Nothing is gained by omitting them — the in-house delivery_fee in
        // order_data is already client-supplied and unvalidated today.
        console.warn(
          "[create-payment-intent] distance guard skipped; missing coords",
          { restaurant_id }
        );
      }
    }

    // Store order data in pending_orders table to avoid Stripe metadata size limits
    let pending_order_id: string;

    if (payment_intent_id) {
      // Update: look up existing pending order from the payment intent metadata
      const existing = await stripe.paymentIntents.retrieve(
        payment_intent_id,
        { stripeAccount: restaurant.stripe_account_id }
      );
      pending_order_id = existing.metadata?.pending_order_id || "";

      if (pending_order_id && order_data) {
        await supabase
          .from("pending_orders")
          .update({ order_data })
          .eq("id", pending_order_id);
      }

      const updated = await stripe.paymentIntents.update(
        payment_intent_id,
        {
          amount,
          // Only platform orders re-assert the application fee on update.
          // Self/pickup/in-house update path stays byte-identical (no app-fee field).
          ...(isPlatform ? { application_fee_amount: applicationFeeCents } : {}),
          metadata: {
            restaurant_id,
            restaurant_name: restaurant.name,
            pending_order_id,
          },
        },
        { stripeAccount: restaurant.stripe_account_id }
      );

      return new Response(
        JSON.stringify({
          clientSecret: updated.client_secret,
          paymentIntentId: updated.id,
          stripeAccount: restaurant.stripe_account_id,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a pending order row
    const { data: pendingOrder, error: poErr } = await supabase
      .from("pending_orders")
      .insert({ restaurant_id, order_data: order_data || {} })
      .select("id")
      .single();

    if (poErr || !pendingOrder) {
      throw new Error("Failed to create pending order");
    }

    pending_order_id = pendingOrder.id;

    let customerId: string | null = null;
    // True only when we resolved a PRE-EXISTING Customer. A freshly created
    // one has no saved cards to redisplay, so it gets no Customer Session.
    let reusedExistingCustomer = false;

    // A verified session lets us reuse the Stripe Customer this person already
    // has at this restaurant, so their saved card is offered again. Entirely
    // best-effort: any miss, any failure, and we fall through to the create
    // block below exactly as before. No session token means byte-identical
    // behaviour to the guest path.
    if (typeof session_token === "string" && session_token.trim()) {
      try {
        const tokenHash = await hashToken(session_token);

        const { data: session } = await supabase
          .from("customer_sessions")
          .select("customer_id, revoked_at, expires_at")
          .eq("token_hash", tokenHash)
          .maybeSingle();

        if (
          session &&
          session.revoked_at === null &&
          new Date(session.expires_at).getTime() >= Date.now()
        ) {
          const { data: profile } = await supabase
            .from("restaurant_customers")
            .select("stripe_customer_id")
            .eq("restaurant_id", restaurant_id)
            .eq("customer_id", session.customer_id)
            .maybeSingle();

          const savedId = profile?.stripe_customer_id || null;

          if (savedId) {
            // A Customer deleted on the connected account still leaves its id
            // in our table. Handing a deleted id to paymentIntents.create
            // throws — and that call sits OUTSIDE the non-fatal catch below,
            // so the throw would break checkout outright. Retrieve first and
            // treat any failure, or a deleted flag, as no saved customer.
            try {
              const existing = await stripe.customers.retrieve(savedId, {
                stripeAccount: restaurant.stripe_account_id,
              });
              if (!(existing as any).deleted) {
                customerId = savedId;
                reusedExistingCustomer = true;
              }
            } catch (retrieveErr: any) {
              console.error(
                "[create-payment-intent] saved customer retrieve failed (non-fatal)",
                retrieveErr.message
              );
            }
          }
        }
      } catch (sessionErr: any) {
        console.error(
          "[create-payment-intent] session customer lookup failed (non-fatal)",
          sessionErr.message
        );
      }
    }

    if (!customerId) {
      // Create a Stripe Customer on the connected account so the payment method
      // can be reused for post-completion adjustment charges. NON-FATAL: if this
      // fails we fall through to a customerless PaymentIntent (pre-change
      // behavior) rather than blocking checkout.
      try {
        const cd = order_data || {};
        const customer = await stripe.customers.create(
          {
            name: cd.customer_name || undefined,
            email: cd.customer_email || undefined,
            phone: cd.customer_phone || undefined,
            metadata: { restaurant_id, pending_order_id },
          },
          { stripeAccount: restaurant.stripe_account_id }
        );
        customerId = customer.id;
      } catch (custErr: any) {
        console.error(
          "[create-payment-intent] customer create failed (non-fatal)",
          custErr.message
        );
      }
    }

    // Create PaymentIntent directly on the connected account (direct charges)
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount, // already in cents from frontend
        currency: "usd",
        payment_method_types: ["card"],
        ...(customerId ? { customer: customerId, setup_future_usage: "off_session" } : {}),
        application_fee_amount: applicationFeeCents, // 150 self/pickup/in-house; 150 + Uber fee for platform
        metadata: {
          restaurant_id,
          restaurant_name: restaurant.name,
          pending_order_id,
        },
      },
      {
        stripeAccount: restaurant.stripe_account_id,
        ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
      }
    );

    // A Customer Session lets the Payment Element redisplay the cards this
    // customer already has. Deliberately AFTER paymentIntents.create: the
    // payment intent must exist regardless, so a failure here can only cost
    // the saved-card list, never the payment.
    //
    // NOTE: no payment_method_save / payment_method_save_usage here. The
    // PaymentIntent above already sets setup_future_usage, and Stripe rejects
    // the combination with an IntegrationError.
    let customerSessionClientSecret: string | null = null;
    if (reusedExistingCustomer && customerId) {
      try {
        const customerSession = await stripe.customerSessions.create(
          {
            customer: customerId,
            components: {
              payment_element: {
                enabled: true,
                features: {
                  payment_method_redisplay: "enabled",
                  payment_method_allow_redisplay_filters: ["always", "unspecified"],
                },
              },
            },
          },
          { stripeAccount: restaurant.stripe_account_id }
        );
        customerSessionClientSecret = customerSession.client_secret;
      } catch (csErr: any) {
        console.error(
          "[create-payment-intent] customer session create failed (non-fatal)",
          csErr.message
        );
      }
    }

    return new Response(
      JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        stripeAccount: restaurant.stripe_account_id,
        customerSessionClientSecret,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("create-payment-intent error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
