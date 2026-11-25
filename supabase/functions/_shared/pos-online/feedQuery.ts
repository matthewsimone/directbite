/**
 * POS online-orders feed: the snapshot queries (SYNC-CONTRACT §3c `pos-v1-online-orders`, ordr-pos @ 7798d52
 * :494-505; CP17b parts 1 + 2). Raw rows only — the wire shape is wire.ts.
 *
 * Membership (each table = one PostgREST request = one SQL statement = one consistent snapshot):
 *   (a) every non-terminal order created in the last 7 days;
 *   (b) every order whose created_at, scheduled_for or refunded_at is in the current or previous business day
 *       (any status) — SYNC-CONTRACT §3c:499-500. Part 1 had (a) "or scheduled_for ≥ W" and (b) created_at /
 *       refunded_at only, so a TERMINAL order created earlier but scheduled into the window was missing; (b) now
 *       carries scheduled_for, which also covers (a)'s scheduled clause.
 *   KitchenHub (external_orders, only when restaurants.dsp_orders_enabled): the same with its statuses
 *   (new | accepted are non-terminal) and no refunded_at; created_at = ingestion time (placed_at is served).
 * Business day: 04:00 restaurant-local cutoff (BUSINESS_DAY_CUTOFF, menuSnapshot.ts) in restaurants.timezone
 * (099), using pos-eod/rules.ts businessDate. Window start W = the previous business day at 04:00 local.
 * History (§3c:519-523, read-only): one business day D — scheduled_for in [D 04:00, D+1 04:00), or no
 * scheduled_for and created_at in it.
 *
 * Never truncated: each request sends Prefer: count=exact; more than ONLINE_FEED_ROW_CAP (500, §3c:505) in total,
 * or more than PostgREST returned (its max-rows), throws feed_too_large — a cut snapshot would look like orders
 * vanished. Ordr rows with items_written_at NULL are fetched (and counted) but not served (wire.ts, D6).
 *
 * Statuses: the full set is the tablet's (useOrderPolling.js:399) — terminal = complete | cancelled.
 */
import { businessDate } from '../pos-eod/rules.ts';
import { BUSINESS_DAY_CUTOFF } from '../pos-sync/menuSnapshot.ts';
import { sha256HexOfText } from '../pos-sync/canonicalJson.ts';
import { isValidTimeZone } from '../pos-v1/loader.ts';

export const OPEN_STATUSES = ['new', 'in_progress', 'scheduled', 'self_delivering'] as const;
/** external_orders.status (khNormalize.ts normalizeStatus): new | accepted are live. */
export const KH_OPEN_STATUSES = ['new', 'accepted'] as const;
export const OPEN_LOOKBACK_DAYS = 7;
/** §3c:505 — over this many rows (both channels) → 503 feed_too_large. */
export const ONLINE_FEED_ROW_CAP = 500;
/**
 * orders + items (+ each item's CURRENT menu category: order_items stores menu_item_id, 001:142 / 082:20, but no
 * category) + toppings + adjustment_requests (001:177-191), embedded = one statement.
 */
export const FEED_SELECT = '*,order_items(*,menu_items(category_id),order_item_toppings(*)),adjustment_requests(*)';
/** external_orders without `raw` (the whole KitchenHub payload, never served). 090:37-77, 092:6. */
export const KH_FEED_SELECT =
  'id,restaurant_id,kh_order_id,provider_id,provider_name,order_number,daily_number,order_type,status,kh_status_raw,asap,' +
  'scheduled_for,pickup_at,placed_at,customer_name,customer_phone,customer_phone_code,notes,delivery_type,delivery,items,' +
  'charges,total,payment_method,prep_time_minutes,acknowledged_at,accepted_at,completed_at,cancelled_at,cancelled_by,' +
  'print_status,print_attempts,printed_at,last_print_error,paid,created_at';

export class FeedError extends Error {
  readonly code: 'restaurant_not_found' | 'feed_config_invalid' | 'feed_query_failed' | 'feed_too_large';
  constructor(code: FeedError['code'], message: string) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
  }
}

// ---- business-day window ---------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Offset (ms) of `timeZone` at instant `epochMs`: local wall clock − UTC. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads `date` `hhmm`. DST-safe; a time inside a
 * spring-forward gap resolves to the instant after the gap (04:00 is never in a US gap).
 */
export function localTimeToEpochMs(date: string, hhmm: string, timeZone: string): number {
  const d = DATE.exec(date);
  const t = HHMM.exec(hhmm);
  if (!d || !t) throw new RangeError(`bad local time ${date} ${hhmm}`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // Fixed point of t = wall − offset(t): two refinements settle it; none exists inside a gap.
  const g1 = wall - zoneOffsetMs(wall, timeZone);
  const g2 = wall - zoneOffsetMs(g1, timeZone);
  if (g2 === g1) return g1;
  const g3 = wall - zoneOffsetMs(g2, timeZone);
  if (g3 === g2) return g2;
  return Math.max(g1, g2);
}

/** `date` (YYYY-MM-DD) plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const d = DATE.exec(date);
  if (!d) throw new RangeError(`bad date ${date}`);
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days)).toISOString().slice(0, 10);
}

export interface FeedWindow {
  /** Current business date (restaurant-local, 04:00 cutoff). */
  business_date: string;
  previous_business_date: string;
  /** W: start of the previous business day (UTC ISO). */
  window_start: string;
  /** now − 7 days (UTC ISO): the created_at floor for non-terminal orders. */
  open_since: string;
}

export function feedWindow(nowMs: number, timeZone: string, cutoff: string = BUSINESS_DAY_CUTOFF): FeedWindow {
  const today = businessDate(nowMs, timeZone, cutoff);
  const previous = addDays(today, -1);
  return {
    business_date: today,
    previous_business_date: previous,
    window_start: new Date(localTimeToEpochMs(previous, cutoff, timeZone)).toISOString(),
    open_since: new Date(nowMs - OPEN_LOOKBACK_DAYS * 86_400_000).toISOString(),
  };
}

/** PostgREST `or=` logic tree for the membership rule (timestamps double-quoted: they contain ':' and '.'). */
export function feedOrFilter(w: FeedWindow): string {
  const W = `"${w.window_start}"`;
  const open = `"${w.open_since}"`;
  return `and(status.in.(${OPEN_STATUSES.join(',')}),created_at.gte.${open}),` +
    `created_at.gte.${W},scheduled_for.gte.${W},refunded_at.gte.${W}`;
}

/** The same for external_orders (no refund columns). */
export function khFeedOrFilter(w: FeedWindow): string {
  const W = `"${w.window_start}"`;
  const open = `"${w.open_since}"`;
  return `and(status.in.(${KH_OPEN_STATUSES.join(',')}),created_at.gte.${open}),created_at.gte.${W},scheduled_for.gte.${W}`;
}

export interface HistoryRange { business_date: string; start: string; end: string }

/** One business day [D cutoff, D+1 cutoff) in the restaurant's zone. `date` must be a real YYYY-MM-DD. */
export function historyRange(date: string, timeZone: string, cutoff: string = BUSINESS_DAY_CUTOFF): HistoryRange {
  const d = DATE.exec(date);
  if (!d || addDays(date, 0) !== date) throw new RangeError(`bad business date ${date}`);
  return {
    business_date: date,
    start: new Date(localTimeToEpochMs(date, cutoff, timeZone)).toISOString(),
    end: new Date(localTimeToEpochMs(addDays(date, 1), cutoff, timeZone)).toISOString(),
  };
}

/** History membership: scheduled_for ?? created_at inside the day (both tables). */
export function historyOrFilter(h: HistoryRange): string {
  const S = `"${h.start}"`;
  const E = `"${h.end}"`;
  return `and(scheduled_for.gte.${S},scheduled_for.lt.${E}),and(scheduled_for.is.null,created_at.gte.${S},created_at.lt.${E})`;
}

// ---- stable hash -------------------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted (UTF-16 order), arrays in order, numbers / strings as JSON.stringify.
 * Not canonicalJson.ts (that one refuses fractional numbers and non-snake keys; orders carry numeric dollars
 * and jsonb columns with arbitrary keys).
 */
export function stableJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('stableJson: non-finite number');
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  throw new TypeError(`stableJson: ${typeof v} is not allowed`);
}

// ---- rows --------------------------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export type FeedRow = Record<string, any> & { id: string; created_at: string };

const byCreatedThenId = (desc: boolean) => (a: { created_at?: string | null; id?: string }, b: { created_at?: string | null; id?: string }) => {
  const ta = Date.parse(a.created_at ?? '') || 0;
  const tb = Date.parse(b.created_at ?? '') || 0;
  if (ta !== tb) return desc ? tb - ta : ta - tb;
  return String(a.id ?? '') < String(b.id ?? '') ? -1 : String(a.id ?? '') > String(b.id ?? '') ? 1 : 0;
};

/**
 * Deterministic order (the DB's tie order is not): orders created_at DESC then id; items created_at then id
 * (the tablet prints items by created_at, useOrderPolling.js:225); toppings by id (no ordering column);
 * adjustment_requests created_at then id (§3c:555 "oldest first"). Returns new arrays; the input is not mutated.
 */
export function normalizeFeedRows(rows: readonly FeedRow[]): FeedRow[] {
  return [...rows].sort(byCreatedThenId(true)).map((o) => {
    const items = Array.isArray(o.order_items) ? o.order_items : [];
    const out: FeedRow = {
      ...o,
      // deno-lint-ignore no-explicit-any
      order_items: [...items].sort(byCreatedThenId(false)).map((it: any) => ({
        ...it,
        order_item_toppings: Array.isArray(it.order_item_toppings)
          // deno-lint-ignore no-explicit-any
          ? [...it.order_item_toppings].sort((a: any, b: any) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
          : [],
      })),
    };
    if (Array.isArray(o.adjustment_requests)) out.adjustment_requests = [...o.adjustment_requests].sort(byCreatedThenId(false));
    return out;
  });
}

/** SHA-256 (hex) of the stable JSON of `v` (the not-modified token is this over the served wire). */
export function feedHash(v: unknown): Promise<string> {
  return sha256HexOfText(stableJson(v));
}

// ---- query -------------------------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export type FeedClient = { from(table: string): any };

export type FeedScope = { kind: 'live'; window: FeedWindow } | { kind: 'history'; range: HistoryRange };

export interface FeedRows {
  /** orders rows (+ items, toppings, adjustments), normalized; items_written_at NOT filtered here. */
  orders: FeedRow[];
  /** external_orders rows ([] when KitchenHub is off for the restaurant), created_at DESC then id. */
  kitchenhub: FeedRow[];
  /** Exact totals from PostgREST (orders + external_orders). */
  count: number;
}

async function readTable(
  db: FeedClient, table: 'orders' | 'external_orders', select: string, restaurantId: string, filter: string,
): Promise<{ rows: FeedRow[]; count: number }> {
  const { data, error, count } = await db
    .from(table)
    .select(select, { count: 'exact' })
    .eq('restaurant_id', restaurantId)
    .or(filter)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });
  if (error) throw new FeedError('feed_query_failed', `${table} read failed: ${error.message}`);
  const rows: FeedRow[] = Array.isArray(data) ? data : [];
  if (typeof count !== 'number') throw new FeedError('feed_query_failed', `${table} read returned no exact count`);
  if (count > rows.length) throw new FeedError('feed_too_large', `${table}: ${count} rows but only ${rows.length} were returned (PostgREST max rows)`);
  return { rows, count };
}

/** One restaurant's rows for `scope` (timezone already validated by the caller). Throws FeedError. */
export async function loadOnlineRows(db: FeedClient, restaurantId: string, scope: FeedScope, opts: { kitchenHub: boolean }): Promise<FeedRows> {
  const ordrFilter = scope.kind === 'live' ? feedOrFilter(scope.window) : historyOrFilter(scope.range);
  const khFilter = scope.kind === 'live' ? khFeedOrFilter(scope.window) : historyOrFilter(scope.range);
  const [o, k] = await Promise.all([
    readTable(db, 'orders', FEED_SELECT, restaurantId, ordrFilter),
    opts.kitchenHub ? readTable(db, 'external_orders', KH_FEED_SELECT, restaurantId, khFilter) : Promise.resolve({ rows: [], count: 0 }),
  ]);
  const count = o.count + k.count;
  if (count > ONLINE_FEED_ROW_CAP) throw new FeedError('feed_too_large', `${count} orders in scope (cap ${ONLINE_FEED_ROW_CAP})`);
  return { orders: normalizeFeedRows(o.rows), kitchenhub: [...k.rows].sort(byCreatedThenId(true)), count };
}

export interface FeedSnapshot extends FeedRows {
  window: FeedWindow;
}

/** Live snapshot, reading the restaurant's timezone itself (part 1 entry point; the handler reads more columns). */
export async function loadFeed(db: FeedClient, restaurantId: string, nowMs: number, opts: { kitchenHub?: boolean } = {}): Promise<FeedSnapshot> {
  const { data: rest, error: restErr } = await db.from('restaurants').select('id, timezone').eq('id', restaurantId).maybeSingle();
  if (restErr) throw new FeedError('feed_query_failed', `restaurants read failed: ${restErr.message}`);
  if (!rest) throw new FeedError('restaurant_not_found', `restaurant ${restaurantId} not found`);
  if (!isValidTimeZone(rest.timezone)) throw new FeedError('feed_config_invalid', `restaurants.timezone is not a valid IANA zone`);
  const window = feedWindow(nowMs, rest.timezone);
  return { window, ...(await loadOnlineRows(db, restaurantId, { kind: 'live', window }, { kitchenHub: opts.kitchenHub ?? false })) };
}
