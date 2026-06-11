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

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { restaurant_id, amount, order_data, payment_intent_id, idempotency_key } = await req.json();

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
         delivery_minimum_in_house, delivery_minimum_uber_direct`
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
    const resolution = resolveMode(restaurant as RestaurantForMode);
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
    if (!isPickup) {
      const minDollars = serverResolvedMode === 'uber_direct'
        ? Number(restaurant.delivery_minimum_uber_direct || 0)
        : Number(restaurant.delivery_minimum_in_house || 0);
      const foodSubtotal = Number(order_data?.subtotal || 0);
      if (minDollars > 0 && foodSubtotal < minDollars) {
        return validationError("below_minimum", `mode=${serverResolvedMode} subtotal=${foodSubtotal} min=${minDollars}`);
      }
    }

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
        Math.round(Number(od.discount_amount || 0) * 100);

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

    // Create PaymentIntent directly on the connected account (direct charges)
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount, // already in cents from frontend
        currency: "usd",
        payment_method_types: ["card"],
        application_fee_amount: 150, // $1.50 DirectBite fee
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

    return new Response(
      JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        stripeAccount: restaurant.stripe_account_id,
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
