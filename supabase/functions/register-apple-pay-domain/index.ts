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

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify admin
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

    const { data: adminUser } = await supabase
      .from("admin_users")
      .select("email")
      .eq("email", user.email)
      .single();

    if (!adminUser) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { stripe_account_id, domain } = await req.json();
    const domainName = domain || "directbite.co";

    if (!stripe_account_id) {
      return new Response(
        JSON.stringify({ error: "stripe_account_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Register Apple Pay domain on the connected account
    const result = await stripe.applePayDomains.create(
      { domain_name: domainName },
      { stripeAccount: stripe_account_id }
    );

    console.log(`Registered Apple Pay domain ${domainName} on ${stripe_account_id}: ${result.id}`);

    return new Response(
      JSON.stringify({ success: true, domain: domainName, id: result.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("register-apple-pay-domain error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
