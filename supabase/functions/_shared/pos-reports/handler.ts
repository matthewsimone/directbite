/**
 * Owner Reports v1 — pos-reports (web tablet, NOT device-authed). Read-only, cents only, no customer data.
 *
 * Auth = stripe-settlement-report/index.ts :79-133 (copied): the Authorization bearer is validated with getUser; the
 * caller must be THIS restaurant's tablet user (restaurants.tablet_email) or a fleet admin (admin_users). Same access
 * as the existing Sales Report (tablet login, no PIN). The data reads are service role (pos_* has no RLS policies).
 *
 * Body: { restaurant_id, preset } | { restaurant_id, from, to } (business dates; range.ts). 200 → the report
 * (build.ts). Errors: 401 Unauthorized, 400 { error, field }, 403 not authorized, 404 Restaurant not found,
 * 500 restaurant misconfigured / read failed.
 */
import { BUSINESS_DAY_CUTOFF } from '../pos-sync/menuSnapshot.ts';
import { isValidTimeZone } from '../pos-v1/loader.ts';
import type { FeedClient } from '../pos-online/feedQuery.ts';
import { buildReport } from './build.ts';
import { resolveRange } from './range.ts';
import { loadReportRows, ReportReadError, type ReportRows } from './store.ts';
import type { ReportRange } from './range.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export interface ReportsDeps {
  /** Service-role client. */
  db: FeedClient & { auth: { getUser(token: string): Promise<{ data: { user: { email?: string | null } | null }; error: unknown }> } };
  now: () => number;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Tests inject rows; production reads them (store.ts). */
  load?: (rid: string, range: ReportRange, timeZone: string, opts: { kitchenHub: boolean }) => Promise<ReportRows>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

export async function handleReports(req: Request, deps: ReportsDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const supabase = deps.db;

  // --- Auth: validate the caller with getUser (stripe-settlement-report :79-94) ---
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { error: 'Unauthorized' });
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json(401, { error: 'Unauthorized' });

  // --- Body (:96-103) ---
  let body: Record<string, unknown>;
  try {
    const b = await req.json();
    body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  } catch {
    return json(400, { error: 'body must be JSON', field: 'body' });
  }
  const restaurantId = body.restaurant_id;
  if (typeof restaurantId !== 'string' || !restaurantId) return json(400, { error: 'restaurant_id is required', field: 'restaurant_id' });

  // --- The restaurant + owning tablet (:105-117) ---
  const { data: restaurant, error: restErr } = await supabase
    .from('restaurants')
    .select('id, tablet_email, timezone, dsp_orders_enabled')
    .eq('id', restaurantId)
    .maybeSingle();
  if (restErr || !restaurant) return json(404, { error: 'Restaurant not found' });

  // --- Ownership (:119-133): THIS restaurant's tablet user, or a fleet admin ---
  const { data: adminUser } = await supabase.from('admin_users').select('email').eq('email', user.email).maybeSingle();
  const isTabletOwner = !!user.email && user.email === restaurant.tablet_email;
  if (!adminUser && !isTabletOwner) return json(403, { error: 'not authorized for this restaurant' });

  if (!isValidTimeZone(restaurant.timezone)) return json(500, { error: 'the restaurant has no valid time zone' });
  const nowMs = deps.now();
  const r = resolveRange({ preset: body.preset, from: body.from, to: body.to }, nowMs, restaurant.timezone, BUSINESS_DAY_CUTOFF);
  if (!r.ok) return json(400, { error: r.message, field: r.field });

  const opts = { kitchenHub: restaurant.dsp_orders_enabled === true };
  let rows: ReportRows;
  try {
    rows = deps.load
      ? await deps.load(restaurantId, r.range, restaurant.timezone, opts)
      : await loadReportRows(supabase, restaurantId, r.range, restaurant.timezone, opts);
  } catch (err) {
    deps.log('pos_reports_read_failed', { restaurant_id: restaurantId, error: err instanceof ReportReadError ? err.message : String(err) });
    return json(500, { error: 'the report could not be read — try again' });
  }
  const report = buildReport(rows, r.range, { timeZone: restaurant.timezone, cutoff: BUSINESS_DAY_CUTOFF, nowMs });
  deps.log('pos_reports_served', { restaurant_id: restaurantId, from: r.range.from, to: r.range.to, admin: !!adminUser });
  return json(200, report);
}
