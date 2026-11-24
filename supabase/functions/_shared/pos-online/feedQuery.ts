/**
 * POS online-orders feed: the snapshot query (CP17a v2 §1, CP17b part 1). Wire format NOT here — this returns
 * the raw `orders` rows (+ embedded items / toppings) and a stable hash for the not-modified token.
 *
 * Membership (one PostgREST request = one SQL statement = one consistent snapshot, read from the primary):
 *   (a) non-terminal orders (new | in_progress | scheduled | self_delivering) created in the last 7 days
 *       OR scheduled for the start of the previous business day or later;
 *   (b) every order created in the current or previous business day (any status);
 *   (c) every order refunded in that window (refunded_at ≥ start of the previous business day).
 * Business day: 04:00 restaurant-local cutoff (BUSINESS_DAY_CUTOFF, menuSnapshot.ts) in restaurants.timezone
 * (099), using pos-eod/rules.ts businessDate. Window start W = the previous business day at 04:00 local.
 *
 * Never truncated: the request sends Prefer: count=exact; if the total is more than the rows returned (the
 * PostgREST max-rows cap) it throws feed_too_large — a cut snapshot would look like orders vanished.
 *
 * Statuses: the full set is the tablet's (useOrderPolling.js:399) — terminal = complete | cancelled.
 * Rows are NOT gated on items_written_at here (legacy orders have it NULL; 050:8); the column is in the row.
 */
import { businessDate } from '../pos-eod/rules.ts';
import { BUSINESS_DAY_CUTOFF } from '../pos-sync/menuSnapshot.ts';
import { sha256HexOfText } from '../pos-sync/canonicalJson.ts';
import { isValidTimeZone } from '../pos-v1/loader.ts';

export const OPEN_STATUSES = ['new', 'in_progress', 'scheduled', 'self_delivering'] as const;
export const OPEN_LOOKBACK_DAYS = 7;
export const FEED_SELECT = '*,order_items(*,order_item_toppings(*))';

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
  return `and(status.in.(${OPEN_STATUSES.join(',')}),or(created_at.gte.${open},scheduled_for.gte.${W})),` +
    `created_at.gte.${W},refunded_at.gte.${W}`;
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
 * (the tablet prints items by created_at, useOrderPolling.js:225); toppings by id (no ordering column).
 * Returns new arrays; the input is not mutated.
 */
export function normalizeFeedRows(rows: readonly FeedRow[]): FeedRow[] {
  return [...rows].sort(byCreatedThenId(true)).map((o) => {
    const items = Array.isArray(o.order_items) ? o.order_items : [];
    return {
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
  });
}

/** Not-modified token: SHA-256 (hex) of the stable JSON of the normalized rows. */
export function feedHash(rows: readonly FeedRow[]): Promise<string> {
  return sha256HexOfText(stableJson(rows));
}

// ---- query -------------------------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export type FeedClient = { from(table: string): any };

export interface FeedSnapshot {
  window: FeedWindow;
  orders: FeedRow[];
  /** Exact total from PostgREST (= orders.length; otherwise feed_too_large was thrown). */
  count: number;
  hash: string;
}

/** One restaurant's feed snapshot. Throws FeedError. `db` is a service-role supabase-js client on the primary. */
export async function loadFeed(db: FeedClient, restaurantId: string, nowMs: number): Promise<FeedSnapshot> {
  const { data: rest, error: restErr } = await db.from('restaurants').select('id, timezone').eq('id', restaurantId).maybeSingle();
  if (restErr) throw new FeedError('feed_query_failed', `restaurants read failed: ${restErr.message}`);
  if (!rest) throw new FeedError('restaurant_not_found', `restaurant ${restaurantId} not found`);
  if (!isValidTimeZone(rest.timezone)) throw new FeedError('feed_config_invalid', `restaurants.timezone is not a valid IANA zone`);

  const window = feedWindow(nowMs, rest.timezone);
  const { data, error, count } = await db
    .from('orders')
    .select(FEED_SELECT, { count: 'exact' })
    .eq('restaurant_id', restaurantId)
    .or(feedOrFilter(window))
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });
  if (error) throw new FeedError('feed_query_failed', `orders read failed: ${error.message}`);
  const rows: FeedRow[] = Array.isArray(data) ? data : [];
  if (typeof count !== 'number') throw new FeedError('feed_query_failed', 'orders read returned no exact count');
  if (count > rows.length) throw new FeedError('feed_too_large', `feed has ${count} orders but only ${rows.length} were returned (PostgREST max rows)`);

  const orders = normalizeFeedRows(rows);
  return { window, orders, count, hash: await feedHash(orders) };
}
