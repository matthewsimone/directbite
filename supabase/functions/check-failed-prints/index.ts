import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";

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
    // Find orders that failed to print and have fewer than 3 attempts
    const { data: failedOrders, error } = await supabase
      .from("orders")
      .select("id, order_number, print_attempts")
      .eq("print_status", "failed")
      .lt("print_attempts", 3)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Failed to query orders:", error.message);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!failedOrders || failedOrders.length === 0) {
      return new Response(
        JSON.stringify({ message: "No failed prints to retry", retried: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${failedOrders.length} failed print(s) to retry`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const results = [];

    for (const order of failedOrders) {
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/retry-print`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ order_id: order.id }),
        });

        const result = await response.json();
        results.push({
          order_id: order.id,
          order_number: order.order_number,
          attempt: (order.print_attempts || 0) + 1,
          success: result.success || false,
        });

        console.log(`Retry for order #${order.order_number}: ${result.success ? "success" : "failed"}`);
      } catch (err: any) {
        console.error(`Retry failed for order #${order.order_number}:`, err.message);
        results.push({
          order_id: order.id,
          order_number: order.order_number,
          error: err.message,
        });
      }
    }

    return new Response(
      JSON.stringify({ retried: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("check-failed-prints error:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
