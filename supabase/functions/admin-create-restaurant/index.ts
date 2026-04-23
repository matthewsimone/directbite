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
    // Verify caller is admin
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

    // Check admin status
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

    const {
      name,
      slug,
      phone,
      address,
      hours,
      delivery_available,
      delivery_fee,
      delivery_note,
      estimated_pickup_minutes,
      estimated_delivery_minutes,
      tax_rate,
      tablet_email,
      tablet_password,
      stripe_account_id,
      printnode_printer_id,
    } = await req.json();

    if (!name || !slug || !tablet_email || !tablet_password) {
      return new Response(
        JSON.stringify({ error: "name, slug, tablet_email, and tablet_password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate stripe_account_id format if provided
    if (stripe_account_id && !/^acct_[A-Za-z0-9]+$/.test(stripe_account_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid Stripe account ID format. Must start with acct_" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check slug uniqueness
    const { data: existing } = await supabase
      .from("restaurants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (existing) {
      return new Response(
        JSON.stringify({ error: "A restaurant with this slug already exists" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase Auth user for tablet login
    const { data: authData, error: createAuthErr } = await supabase.auth.admin.createUser({
      email: tablet_email,
      password: tablet_password,
      email_confirm: true,
    });

    if (createAuthErr) {
      return new Response(
        JSON.stringify({ error: `Failed to create tablet user: ${createAuthErr.message}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create restaurant
    const { data: restaurant, error: restErr } = await supabase
      .from("restaurants")
      .insert({
        name,
        slug,
        phone: phone || null,
        address: address || null,
        delivery_available: delivery_available || false,
        delivery_fee: delivery_fee || 0,
        delivery_note: delivery_note || null,
        estimated_pickup_minutes: estimated_pickup_minutes || 30,
        estimated_delivery_minutes: estimated_delivery_minutes || 60,
        tax_rate: tax_rate || 0,
        tablet_email,
        stripe_account_id: stripe_account_id || null,
        printnode_printer_id: printnode_printer_id || null,
      })
      .select()
      .single();

    if (restErr) {
      // Clean up auth user if restaurant creation fails
      if (authData?.user?.id) {
        await supabase.auth.admin.deleteUser(authData.user.id);
      }
      return new Response(
        JSON.stringify({ error: `Failed to create restaurant: ${restErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create hours records
    if (hours && Array.isArray(hours)) {
      const hoursRows = hours.map((h: any) => ({
        restaurant_id: restaurant.id,
        day_of_week: h.day_of_week,
        is_open: h.is_open,
        open_time: h.open_time || null,
        close_time: h.close_time || null,
      }));

      const { error: hoursErr } = await supabase.from("hours").insert(hoursRows);
      if (hoursErr) {
        console.error("Failed to create hours:", hoursErr.message);
      }
    }

    // Auto-register Apple Pay domain on connected account
    if (stripe_account_id) {
      try {
        await stripe.applePayDomains.create(
          { domain_name: "directbite.co" },
          { stripeAccount: stripe_account_id }
        );
        await supabase
          .from("restaurants")
          .update({ apple_pay_registered: true })
          .eq("id", restaurant.id);
        console.log(`Apple Pay domain registered for ${stripe_account_id}`);
      } catch (apErr: any) {
        console.error(`Apple Pay domain registration failed for ${stripe_account_id}:`, apErr.message);
        // Don't block restaurant creation — can be retried
      }
    }

    console.log(`Restaurant created: ${restaurant.name} (${restaurant.slug})`);

    return new Response(
      JSON.stringify({ success: true, restaurant }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("admin-create-restaurant error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
