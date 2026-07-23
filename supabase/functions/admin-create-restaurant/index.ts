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
      restaurant_id,
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
      printer_ip,
      recoup_enabled,
      recoup_rate,
      latitude,
      longitude,
    } = await req.json();

    // ── Geocode address ──
    async function geocodeAddress(addr: string): Promise<{ lat: number; lon: number } | null> {
      const gmapsKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
      if (!gmapsKey || !addr) return null;
      try {
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${gmapsKey}`
        );
        const geoData = await geoRes.json();
        if (geoData.status === "OK" && geoData.results?.length > 0) {
          const loc = geoData.results[0].geometry.location;
          console.log(`Geocoded "${addr}" → ${loc.lat}, ${loc.lng}`);
          return { lat: loc.lat, lon: loc.lng };
        }
        console.warn("Geocoding returned no results for:", addr, geoData.status);
      } catch (geoErr: any) {
        console.error("Geocoding failed:", geoErr.message);
      }
      return null;
    }

    // ── UPDATE existing restaurant ──
    if (restaurant_id) {
      // Fetch existing to check if address changed or lat/lon missing
      const { data: existingRest } = await supabase
        .from("restaurants")
        .select("address, latitude, longitude")
        .eq("id", restaurant_id)
        .single();

      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (phone !== undefined) updateData.phone = phone || null;
      if (address !== undefined) updateData.address = address || null;
      if (delivery_available !== undefined) updateData.delivery_available = delivery_available;
      if (delivery_fee !== undefined) updateData.delivery_fee = delivery_fee || 0;
      if (delivery_note !== undefined) updateData.delivery_note = delivery_note || null;
      if (estimated_pickup_minutes !== undefined) updateData.estimated_pickup_minutes = estimated_pickup_minutes;
      if (estimated_delivery_minutes !== undefined) updateData.estimated_delivery_minutes = estimated_delivery_minutes;
      if (tax_rate !== undefined) updateData.tax_rate = tax_rate || 0;
      if (stripe_account_id !== undefined) updateData.stripe_account_id = stripe_account_id || null;
      if (printer_ip !== undefined) updateData.printer_ip = printer_ip || null;
      // Migration 061. Guarded by !== undefined so the onboarding wizard —
      // which never sends these — cannot touch them, and the CREATE path below
      // is unaffected. Rate clamped to the DB CHECK ceiling (0.10).
      if (recoup_enabled !== undefined) updateData.recoup_enabled = recoup_enabled === true;
      if (recoup_rate !== undefined) updateData.recoup_rate = Math.min(Math.max(Number(recoup_rate) || 0, 0), 0.10);

      // Use provided coords or geocode if address changed/lat/lon missing
      if (latitude && longitude) {
        updateData.latitude = latitude;
        updateData.longitude = longitude;
      } else {
        const needsGeocode = address && (
          address !== existingRest?.address ||
          !existingRest?.latitude ||
          !existingRest?.longitude
        );
        if (needsGeocode) {
          const coords = await geocodeAddress(address);
          if (coords) {
            updateData.latitude = coords.lat;
            updateData.longitude = coords.lon;
          }
        }
      }

      const { data: updated, error: updateErr } = await supabase
        .from("restaurants")
        .update(updateData)
        .eq("id", restaurant_id)
        .select()
        .single();

      if (updateErr) {
        return new Response(
          JSON.stringify({ error: `Failed to update restaurant: ${updateErr.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`Restaurant updated: ${updated.name} (${updated.slug})`);
      return new Response(
        JSON.stringify({ success: true, restaurant: updated }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── CREATE new restaurant ──
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

    // Reserved slugs — collide with app routes (admin, api, _next) or
    // middleware paths (r → /r/:slug QR redirect).
    const RESERVED_SLUGS = new Set(["admin", "api", "_next", "r"]);
    if (RESERVED_SLUGS.has(slug)) {
      return new Response(
        JSON.stringify({ error: `Slug '${slug}' is reserved` }),
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

    // Use provided coords or geocode address for new restaurant
    let restLat = latitude || null;
    let restLon = longitude || null;
    if (!restLat && !restLon && address) {
      const coords = await geocodeAddress(address);
      if (coords) { restLat = coords.lat; restLon = coords.lon; }
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
        printer_ip: printer_ip || null,
        latitude: restLat,
        longitude: restLon,
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

    // Configure connected account: capabilities + Apple Pay domains
    if (stripe_account_id) {
      // Request all necessary capabilities
      try {
        await stripe.accounts.update(
          stripe_account_id,
          {
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
          }
        );
        console.log(`Capabilities requested for ${stripe_account_id}`);
      } catch (capErr: any) {
        console.error(`Capabilities request failed for ${stripe_account_id}:`, capErr.message);
      }

      // Register Apple Pay domains (both root and www)
      let applePayOk = false;
      for (const domain of ["directbite.co", "www.directbite.co"]) {
        try {
          await stripe.applePayDomains.create(
            { domain_name: domain },
            { stripeAccount: stripe_account_id }
          );
          console.log(`Apple Pay domain ${domain} registered for ${stripe_account_id}`);
          applePayOk = true;
        } catch (apErr: any) {
          console.error(`Apple Pay domain ${domain} registration failed:`, apErr.message);
        }
      }
      if (applePayOk) {
        await supabase
          .from("restaurants")
          .update({ apple_pay_registered: true })
          .eq("id", restaurant.id);
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
