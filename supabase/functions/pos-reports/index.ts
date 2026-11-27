// ============================================================================
// pos-reports — Owner Reports v1 for the web tablet: POS + online on the POS business day (restaurants.timezone,
// 04:00 cutoff) — day summary across registers + online, sales by type / channel / register, payments by method,
// refunds, shifts & drawer, Z history (incl. supplementals, Σ Z vs recompute ✓/⚠), live "today so far".
// ============================================================================
// Read-only. Web-authed like stripe-settlement-report (tablet_email or admin_users), NOT device-authed.
// verify_jwt = false (supabase/config.toml; the handler validates the bearer itself with getUser).
// Logic: _shared/pos-reports/ (handler.ts, store.ts, build.ts, range.ts, ports.ts); money: the vendored
// ordr-core-ext/eod.ts buildDayReport. Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Index: migration 120.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.102.1";
import { handleReports } from "../_shared/pos-reports/handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const deps = {
  db: supabase,
  now: () => Date.now(),
  // facts only — never a body, a token or customer data
  log: (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ fn: "pos-reports", event, ...data })),
};

Deno.serve(async (req: Request) => {
  try {
    return await handleReports(req, deps);
  } catch (err) {
    deps.log("internal_error", { error: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
