// stripe-settlement-report — real settlement data for a restaurant's connected
// Stripe account over a date range. Read-only (no Stripe/DB writes). Returns an
// activity view (order breakdown + charge totals for the SELECTED range), an
// orders breakdown (from the DB), and a payout view (deposits + their sales
// window). All amounts are Stripe-native / DB integer cents — NO conversion.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import Stripe from "https://esm.sh/stripe@17.7.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Payouts settle ~2 days after each order, so a payout depositing inside the
// selected range can be composed of charges created up to ~3 weeks earlier.
// Widen the balance-transaction pull back by 21 days so payout grouping +
// per-payout sales windows see those earlier charges. Activity totals are
// still restricted to the SELECTED range below.
const WIDE_LOOKBACK_SECONDS = 21 * 86400;

// Sum the amounts of a balance transaction's fee_details entries of one type.
function sumFeeDetails(bt: any, feeType: string): number {
  const arr = bt.fee_details || [];
  let cents = 0;
  for (const fd of arr) {
    if (fd.type === feeType) cents += fd.amount;
  }
  return cents;
}

// Dollars (possibly null) → integer cents.
function dollarsToCents(v: any): number {
  return Math.round(Number(v || 0) * 100);
}

// America/New_York UTC offset in ms at a given instant, via Intl — never a
// hardcoded -4/-5, so EDT and EST both come out right.
function etOffsetMs(utcMs: number): number {
  const parts: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  for (const p of fmt.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUtc - utcMs;
}

// Unix seconds at 00:00:00 America/New_York on an ET date key ("YYYY-MM-DD"),
// optionally dayOffset days later. Two passes: the offset is sampled at the
// naive guess, then re-sampled at the corrected instant so a DST boundary
// falling inside the guess resolves.
function etMidnightUnix(dateKey: string, dayOffset = 0): number {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d + dayOffset, 0, 0, 0);
  const firstPass = naive - etOffsetMs(naive);
  return Math.floor((naive - etOffsetMs(firstPass)) / 1000);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- Auth: validate the caller with getUser, like admin-refund ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Body ---
    const { restaurant_id, start, end } = await req.json();
    if (!restaurant_id || !start || !end) {
      return new Response(
        JSON.stringify({ error: "restaurant_id, start, end are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Look up the connected account + owning tablet ---
    const { data: restaurant, error: restErr } = await supabase
      .from("restaurants")
      .select("stripe_account_id, tablet_email")
      .eq("id", restaurant_id)
      .single();

    if (restErr || !restaurant) {
      return new Response(
        JSON.stringify({ error: "Restaurant not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Ownership check (mirrors admin-refund's admin lookup). Authorized if
    //     the caller is THIS restaurant's tablet user, or a fleet admin. ---
    const { data: adminUser } = await supabase
      .from("admin_users")
      .select("email")
      .eq("email", user.email)
      .single();

    const isTabletOwner = user.email === restaurant.tablet_email;
    if (!adminUser && !isTabletOwner) {
      return new Response(
        JSON.stringify({ error: "not authorized for this restaurant" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!restaurant.stripe_account_id) {
      return new Response(
        JSON.stringify({ error: "no stripe account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const stripeAccount = restaurant.stripe_account_id;

    // --- Two windows. `start`/`end` are America/New_York date keys from the
    //     caller (src/utils/scheduling.js getRangeForPreset), so SELECTED runs
    //     00:00:00 ET on `start` to 00:00:00 ET the day after `end`, END
    //     EXCLUSIVE. WIDE reaches 21 days back for payout grouping only. ---
    const selectedStartUnix = etMidnightUnix(start);
    const selectedEndUnix = etMidnightUnix(end, 1); // exclusive
    const wideStartUnix = selectedStartUnix - WIDE_LOOKBACK_SECONDS;

    // --- Balance transactions: pull the WIDE set (paginate, cap 100 pages).
    //     If the cap is reached with has_more still set the pull is short, and
    //     a short pull silently under-reports every activity total below — so
    //     throw rather than return a number that looks complete. ---
    const rawBt: any[] = [];
    let startingAfter: string | undefined = undefined;
    let hasMore = false;
    for (let page = 0; page < 100; page++) {
      const resp: any = await stripe.balanceTransactions.list(
        {
          created: { gte: wideStartUnix, lt: selectedEndUnix },
          limit: 100,
          expand: ["data.source"],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        { stripeAccount }
      );
      rawBt.push(...resp.data);
      hasMore = resp.has_more === true;
      if (!hasMore || resp.data.length === 0) break;
      startingAfter = resp.data[resp.data.length - 1].id;
    }
    if (hasMore) {
      throw new Error(
        `balance transaction pagination exhausted the 100-page cap at ${rawBt.length} rows with has_more still true — totals would be short, refusing to report`
      );
    }

    // --- Payouts deposited in the SELECTED window ---
    const payoutResp = await stripe.payouts.list(
      { created: { gte: selectedStartUnix, lt: selectedEndUnix }, limit: 100 },
      { stripeAccount }
    );

    // --- Classify. WIDE rows feed payout grouping; SELECTED rows feed activity
    //     totals + the per-charge detail (so widened rows can't inflate). ---
    const wideCharges = rawBt.filter((bt: any) => bt.type === "charge");
    const wideRefunds = rawBt.filter((bt: any) => bt.type === "refund");
    const wideActivityRows = [...wideCharges, ...wideRefunds];

    const inSelected = (bt: any) =>
      bt.created >= selectedStartUnix && bt.created < selectedEndUnix;
    const charges = wideCharges.filter(inSelected);
    const refunds = wideRefunds.filter(inSelected);
    const selectedActivityRows = [...charges, ...refunds];

    // --- Per-charge detail (SELECTED). Foreign-card flagging is done client-side. ---
    const charge_detail = charges.map((bt: any) => {
      const source = bt.source; // expanded charge object (or null)
      return {
        charge_id: source?.id ?? bt.id,
        gross: bt.amount,
        stripe_fee: sumFeeDetails(bt, "stripe_fee"),
        app_fee: sumFeeDetails(bt, "application_fee"),
        net: bt.net,
        created: bt.created,
        available_on: bt.available_on,
        status: bt.status,
      };
    });

    // --- ACTIVITY VIEW (SELECTED; integer cents) ---
    const gross_charged = charges.reduce((s: number, bt: any) => s + bt.amount, 0);
    const stripe_fees_actual = charges.reduce(
      (s: number, bt: any) => s + sumFeeDetails(bt, "stripe_fee"),
      0
    );
    const directbite_fees = charges.reduce(
      (s: number, bt: any) => s + sumFeeDetails(bt, "application_fee"),
      0
    );
    const refunds_amount = refunds.reduce((s: number, bt: any) => s + bt.amount, 0); // negative
    const net_activity =
      charges.reduce((s: number, bt: any) => s + bt.net, 0) +
      refunds.reduce((s: number, bt: any) => s + bt.net, 0);

    const activity = {
      charge_count: charges.length,
      refund_count: refunds.length,
      gross_charged,
      stripe_fees_actual,
      directbite_fees,
      refunds_amount,
      net_activity,
    };

    // --- ORDERS BREAKDOWN (DB; SELECTED range, trust created_at). ---
    const selStartIso = new Date(selectedStartUnix * 1000).toISOString();
    const selEndIso = new Date(selectedEndUnix * 1000).toISOString();
    const { data: ordersData, error: ordersErr } = await supabase
      .from("orders")
      .select(
        "status, subtotal, discount_amount, loyalty_discount_amount, tax_amount, tip_amount, delivery_fee, delivery_fulfillment_method, uber_actual_fee, uber_status, recoup_amount, recoup_rate"
      )
      .eq("restaurant_id", restaurant_id)
      .gte("created_at", selStartIso)
      .lt("created_at", selEndIso);
    if (ordersErr) throw new Error(`orders fetch failed: ${ordersErr.message}`);

    const orders = ordersData || [];
    const nonCancelled = orders.filter((o: any) => o.status !== "cancelled");
    const cancelledOrders = orders.filter((o: any) => o.status === "cancelled");
    const udOrders = nonCancelled.filter(
      (o: any) => o.delivery_fulfillment_method === "uber_direct"
    );

    const food_cents = nonCancelled.reduce(
      (s: number, o: any) =>
        s +
        Math.round(
          (Number(o.subtotal || 0) -
            Number(o.discount_amount || 0) -
            Number(o.loyalty_discount_amount || 0)) * 100
        ),
      0
    );
    const tax_cents = nonCancelled.reduce((s: number, o: any) => s + dollarsToCents(o.tax_amount), 0);
    const tips_cents = nonCancelled.reduce((s: number, o: any) => s + dollarsToCents(o.tip_amount), 0);
    const delivery_cents = nonCancelled.reduce((s: number, o: any) => s + dollarsToCents(o.delivery_fee), 0);

    // Migration 061 — credit-processing recoup. NOTE: orders.service_fee
    // ALREADY CONTAINS this amount; never sum the two. The rate comes from the
    // per-order stamp, not current restaurant config, so a window spanning a
    // rate change reports honestly — mixed rates yield null and the UI drops
    // the percentage rather than showing a wrong one.
    const recoupOrders = nonCancelled.filter((o: any) => Number(o.recoup_amount || 0) > 0);
    const recoup_cents = recoupOrders.reduce((s: number, o: any) => s + dollarsToCents(o.recoup_amount), 0);
    const recoupRates = [...new Set(recoupOrders.map((o: any) => Number(o.recoup_rate || 0)))];
    const recoup_rate = recoupRates.length === 1 ? recoupRates[0] : null;

    // Attribute Uber economics ONLY to orders the courier actually delivered.
    // uber_status === 'delivered' is the sole positive marker: the switch-to-
    // in-house / cancel flows leave delivery_fulfillment_method='uber_direct'
    // and uber_actual_fee=null, so non-deliveries are indistinguishable by
    // those fields. Positive-match on 'delivered' — canceled / null / failed /
    // returned / in-flight all fall to non-delivered.
    const delivered = udOrders.filter((o: any) => o.uber_status === "delivered");
    const nonDelivered = udOrders.filter((o: any) => o.uber_status !== "delivered");

    const ud_count = delivered.length;
    // Option A: a delivered order with a null actual fee contributes $0 — no
    // uber_quoted_fee fallback.
    const ud_uber_charged_cents = delivered.reduce(
      (s: number, o: any) => s + dollarsToCents(o.uber_actual_fee || 0),
      0
    );
    const ud_customer_paid_cents = delivered.reduce(
      (s: number, o: any) => s + dollarsToCents(o.delivery_fee),
      0
    );
    const ud_net_cost_cents = ud_uber_charged_cents - ud_customer_paid_cents;
    // Tip split — cap 500 to match what dispatch fronts to Uber
    // (_shared/uberCreateDelivery.ts:491 sends tip: Math.min(tipCents, 500)).
    const ud_tips_to_driver_cents = delivered.reduce(
      (s: number, o: any) => s + Math.min(Math.round(Number(o.tip_amount || 0) * 100), 500),
      0
    );
    // Kept = the over-$5 portion of DELIVERED tips (stays in the restaurant's
    // balance) PLUS the FULL tip of every non-delivered order (no driver got it).
    const ud_tip_kept_cents =
      delivered.reduce((s: number, o: any) => s + Math.max(Math.round(Number(o.tip_amount || 0) * 100) - 500, 0), 0) +
      nonDelivered.reduce((s: number, o: any) => s + Math.round(Number(o.tip_amount || 0) * 100), 0);

    const breakdown = {
      food_cents,
      tax_cents,
      tips_cents,
      delivery_cents,
      recoup_cents,
      recoup_rate,
      completed_count: nonCancelled.length,
      cancelled_count: cancelledOrders.length,
      ud_count,
      ud_uber_charged_cents,
      ud_customer_paid_cents,
      ud_net_cost_cents,
      ud_tips_to_driver_cents,
      ud_tip_kept_cents,
    };

    // --- ADJUSTMENTS (DB; SELECTED ET window, approved only). Keyed off
    //     approved_at, NOT created_at: admin-approve-adjustment creates the
    //     PaymentIntent at approval time, so approved_at is when the money
    //     moved. The IS NOT NULL guards on the Stripe ids are load-bearing,
    //     not defensive: approved rows predating the charging code carry no
    //     Stripe id and were never actually collected.
    //
    //     Adjustment charges/refunds are separate PaymentIntents and Refunds
    //     on the connected account, so they ALREADY appear as balance
    //     transactions and are ALREADY counted in gross_charged,
    //     stripe_fees_actual and refunds_amount above. This key is
    //     attribution, not new money. Any consumer must add these to the
    //     DB-side breakdown to make the Sales section foot — and must NOT add
    //     them to Gross Charged, which already includes them. ---
    const { data: adjData, error: adjErr } = await supabase
      .from("adjustment_requests")
      .select("type, amount, approved_at, stripe_charge_intent_id, stripe_refund_id")
      .eq("restaurant_id", restaurant_id)
      .eq("status", "approved")
      .not("approved_at", "is", null)
      .gte("approved_at", selStartIso)
      .lt("approved_at", selEndIso);
    if (adjErr) throw new Error(`adjustments fetch failed: ${adjErr.message}`);

    const adjRows = adjData || [];
    const adjCharges = adjRows.filter(
      (a: any) => a.type === "charge" && a.stripe_charge_intent_id != null
    );
    const adjRefunds = adjRows.filter(
      (a: any) => a.type === "refund" && a.stripe_refund_id != null
    );
    const adjustments = {
      // Both positive magnitudes — `amount` is stored as positive numeric
      // dollars regardless of type, unlike Stripe's signed refund rows.
      charges_cents: adjCharges.reduce((s: number, a: any) => s + dollarsToCents(a.amount), 0),
      charges_count: adjCharges.length,
      refunds_cents: adjRefunds.reduce((s: number, a: any) => s + dollarsToCents(a.amount), 0),
      refunds_count: adjRefunds.length,
    };

    // --- PAYOUT VIEW (grouped by settlement; WIDE rows). Each group also
    //     reports its deposit date + the sales window (min/max created) of its
    //     constituent charges. `ties` retained but unused by the UI. ---
    const payouts = (payoutResp.data || []).map((p: any) => ({
      id: p.id,
      amount: p.amount,
      arrival_date: p.arrival_date,
      status: p.status,
    }));

    const payout_groups = payouts.map((p: any) => {
      let rows = wideActivityRows.filter((bt: any) => bt.payout === p.id);
      if (rows.length === 0) {
        rows = wideActivityRows.filter(
          (bt: any) => bt.status === "available" && bt.available_on === p.arrival_date
        );
      }
      const grouped_net = rows.reduce((s: number, bt: any) => s + bt.net, 0);
      const createds = rows.map((bt: any) => bt.created);
      return {
        payout_id: p.id,
        payout_amount: p.amount,
        grouped_net,
        count: rows.length,
        ties: grouped_net === p.amount,
        deposited: p.arrival_date,
        sales_start: createds.length ? Math.min(...createds) : null,
        sales_end: createds.length ? Math.max(...createds) : null,
      };
    });

    // Pending bucket: SELECTED activity rows not yet settled (status 'pending').
    const pendingRows = selectedActivityRows.filter((bt: any) => bt.status === "pending");
    const pending = {
      pending_count: pendingRows.length,
      pending_net: pendingRows.reduce((s: number, bt: any) => s + bt.net, 0),
    };

    return new Response(
      JSON.stringify({
        range: { start, end, selectedStartUnix, selectedEndUnix, wideStartUnix },
        activity,
        breakdown,
        adjustments,
        payouts,
        payout_groups,
        pending,
        charges: charge_detail,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("stripe-settlement-report error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
