// stripe-settlement-report — real settlement data for a restaurant's connected
// Stripe account over a date range. Read-only (no Stripe/DB writes). Returns
// BOTH an activity view (by transaction, in the range) and a payout view
// (grouped by settlement + a pending bucket). All amounts are Stripe-native
// integer cents — NO conversion.
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

// Sum the amounts of a balance transaction's fee_details entries of one type.
function sumFeeDetails(bt: any, feeType: string): number {
  const arr = bt.fee_details || [];
  let cents = 0;
  for (const fd of arr) {
    if (fd.type === feeType) cents += fd.amount;
  }
  return cents;
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

    // ISO date → unix seconds. endUnix adds a full day so `lte` INCLUDES the
    // whole final calendar day (without +86400, the entire end date is dropped).
    const startUnix = Math.floor(new Date(start).getTime() / 1000);
    const endUnix = Math.floor(new Date(end).getTime() / 1000) + 86400;

    // --- Balance transactions (filter on `created`, paginate, cap 10 pages) ---
    const rawBt: any[] = [];
    let startingAfter: string | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const resp = await stripe.balanceTransactions.list(
        {
          created: { gte: startUnix, lte: endUnix },
          limit: 100,
          expand: ["data.source"],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        { stripeAccount }
      );
      rawBt.push(...resp.data);
      if (!resp.has_more || resp.data.length === 0) break;
      startingAfter = resp.data[resp.data.length - 1].id;
    }

    // --- Payouts (single page of 100; report scope) ---
    const payoutResp = await stripe.payouts.list(
      { created: { gte: startUnix, lte: endUnix }, limit: 100 },
      { stripeAccount }
    );

    // --- Classify by type. Payout rows (type==='payout') are the deposit
    //     itself and are EXCLUDED from activity sums. ---
    const charges = rawBt.filter((bt: any) => bt.type === "charge");
    const refunds = rawBt.filter((bt: any) => bt.type === "refund");
    const activityRows = [...charges, ...refunds];

    // --- Per-charge detail (frontend drill-down + high-fee/foreign-card flag
    //     when stripe_fee / gross > 0.04). ---
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

    // --- ACTIVITY VIEW (by transaction, in range; integer cents) ---
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

    // --- PAYOUT VIEW (grouped by settlement) ---
    const payouts = (payoutResp.data || []).map((p: any) => ({
      id: p.id,
      amount: p.amount,
      arrival_date: p.arrival_date,
      status: p.status,
    }));

    // Group activity rows into each payout. Prefer bt.payout when populated;
    // otherwise fall back to matching SETTLED rows (status==='available') by
    // available_on === payout.arrival_date (the probe showed bt.payout was null
    // even for settled rows while available_on was set). grouped_net should tie
    // to payout.amount — the penny-proof.
    const payout_groups = payouts.map((p: any) => {
      let rows = activityRows.filter((bt: any) => bt.payout === p.id);
      if (rows.length === 0) {
        rows = activityRows.filter(
          (bt: any) => bt.status === "available" && bt.available_on === p.arrival_date
        );
      }
      const grouped_net = rows.reduce((s: number, bt: any) => s + bt.net, 0);
      return {
        payout_id: p.id,
        payout_amount: p.amount,
        grouped_net,
        count: rows.length,
        ties: grouped_net === p.amount,
      };
    });

    // Pending bucket: activity rows not yet in any payout (available_on beyond
    // the last payout → status 'pending').
    const pendingRows = activityRows.filter((bt: any) => bt.status === "pending");
    const pending = {
      pending_count: pendingRows.length,
      pending_net: pendingRows.reduce((s: number, bt: any) => s + bt.net, 0),
    };

    return new Response(
      JSON.stringify({
        range: { start, end, startUnix, endUnix },
        activity,
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
