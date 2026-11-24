/**
 * pos-v1-online-orders + pos-v1-online-print (ordr-pos @ 7798d52 docs/SYNC-CONTRACT.md §3c :481-591, :673-732;
 * reference test/support/fakeOnline.ts poll :501-537, print :273-316, served :540-545).
 *
 * Both run the device middleware (§1a) and the body restaurant rule (400 restaurant_mismatch). Handlers are pure
 * over their deps (DeviceRequest → DeviceResult) so tests run without a server.
 *
 * Feed: the FULL current state every poll (feedQuery.ts + wire.ts), opaque token = SHA-256 of the served orders
 * (same token back → not_modified, orders []), 503 feed_too_large (never truncated), settings unless
 * if_none_match_settings equals their hash, history { business_date } (read-only).
 * Print: claim / result per STATION (110 SQL via store.ts), idempotent by action_id (pos_online_actions, 109),
 * every recorded result also writes the tablet's columns (printColumns.ts), the response carries the order.
 */
import { authenticateDevice, type AuthDeps } from '../pos-device/auth.ts';
import { restaurantIdentity } from '../pos-device/identity.ts';
import { contentHash } from '../pos-sync/canonicalJson.ts';
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from '../pos-sync/http.ts';
import { UUID_RE } from '../pos-sync/orderPayload.ts';
import { BUSINESS_DAY_CUTOFF } from '../pos-sync/menuSnapshot.ts';
import { getEffectiveSchedule, type HoursRow } from '../hours/serviceHours.ts';
import { isValidTimeZone } from '../pos-v1/loader.ts';
import {
  FEED_SELECT, FeedError, feedHash, feedWindow, historyRange, KH_FEED_SELECT, loadOnlineRows, normalizeFeedRows,
  type FeedClient, type FeedRow, type FeedScope,
} from './feedQuery.ts';
import { writeTabletPrintColumns, type PrintClient } from './printColumns.ts';
import { tabletWrite, type OnlineStationRef, type PrintResult, type PrintVariant } from './printRules.ts';
import { DEFAULT_POS_SETTINGS, OnlineStoreError, stationRefProblem, type OnlinePosSettings, type OnlineStore, type OrderChannel } from './store.ts';
import { intIn, MARKETPLACE_LABELS, servedOrders, type OnlineOrderWire, type OnlineSettingsWire } from './wire.ts';

export interface OnlineDeps extends AuthDeps {
  /** Service-role supabase-js client (reads orders / external_orders / restaurants; the tablet's print write). */
  db: FeedClient & PrintClient;
  online: OnlineStore;
  sleep?: (ms: number) => Promise<void>;
}

const nullableString = (v: unknown) => v === null || v === undefined || typeof v === 'string';
const bad = (field: string, message: string) => errorResult(400, 'invalid_payload', message, { field });

// ---- restaurant + settings ---------------------------------------------------------------------------

export const ONLINE_RESTAURANT_COLUMNS =
  'id,timezone,pickup_schedule,delivery_schedule,estimated_pickup_minutes,estimated_delivery_minutes,ready_time_confirmation_enabled,' +
  'delivery_available,print_trigger,auto_print_copies,receipt_font,dsp_orders_enabled,delivery_fulfillment,uber_direct_active';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function readRestaurant(db: FeedClient, restaurantId: string): Promise<Row> {
  const { data, error } = await db.from('restaurants').select(ONLINE_RESTAURANT_COLUMNS).eq('id', restaurantId).maybeSingle();
  if (error) throw new FeedError('feed_query_failed', `restaurants read failed: ${error.message}`);
  if (!data) throw new FeedError('restaurant_not_found', 'restaurant not found');
  if (!isValidTimeZone(data.timezone)) throw new FeedError('feed_config_invalid', 'restaurants.timezone is not a valid IANA zone');
  return data;
}

async function readRows<T>(what: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new FeedError('feed_query_failed', `${what} read failed: ${error.message}`);
  return (Array.isArray(data) ? data : []) as T[];
}

/**
 * OnlineSettingsWire (§3c:582-591): the web's own columns + pos_restaurant_settings (no row = defaults). Effective
 * schedules = getEffectiveSchedule (pickup = pickup_schedule ?? hours; delivery = delivery_schedule ?? pickup).
 * hash = canonical-JSON SHA-256 (§7) of the object without `hash`.
 */
export async function buildSettings(
  r: Row, hours: HoursRow[], pos: OnlinePosSettings, providers: { provider_id: string; pause_until: string | null }[],
): Promise<OnlineSettingsWire> {
  const fulfillment = r.delivery_fulfillment === 'uber_direct' || r.delivery_fulfillment === 'both' ? r.delivery_fulfillment : 'in_house';
  const dsp = r.dsp_orders_enabled === true;
  const body: Omit<OnlineSettingsWire, 'hash'> = {
    timezone: r.timezone,
    business_day_cutoff: BUSINESS_DAY_CUTOFF,
    service_windows: { pickup: getEffectiveSchedule(r, hours, 'pickup'), delivery: getEffectiveSchedule(r, hours, 'delivery') },
    estimated_pickup_minutes: intIn(r.estimated_pickup_minutes, 0, 100_000, 30),
    estimated_delivery_minutes: intIn(r.estimated_delivery_minutes, 0, 100_000, 60),
    ready_time_confirmation_enabled: r.ready_time_confirmation_enabled === true,
    delivery_available: r.delivery_available !== false,
    print_trigger: r.print_trigger === 'in_progress' ? 'in_progress' : 'received',
    auto_print_copies: intIn(r.auto_print_copies, 1, 5, 1),
    receipt_font: r.receipt_font === 'large' ? 'large' : 'normal',
    online_print_device_id: pos.print_register_device_id,
    online_auto_print_enabled: pos.online_auto_print_enabled,
    kitchenhub_auto_print_enabled: pos.kitchenhub_auto_print_enabled,
    pos_online_orders_enabled: pos.pos_online_orders_enabled,
    dsp_orders_enabled: dsp,
    delivery_providers: [
      { id: 'in_house', label: 'In-house', active: fulfillment === 'in_house' || fulfillment === 'both' },
      { id: 'uber_direct', label: 'Uber Direct', active: fulfillment === 'uber_direct' || (fulfillment === 'both' && r.uber_direct_active === true) },
    ],
    capabilities: { kitchenhub_menu_sync: false },
    kitchenhub_providers: dsp
      ? [...providers]
        .sort((a, b) => (a.provider_id < b.provider_id ? -1 : 1))
        .map((p) => {
          const id = String(p.provider_id).toLowerCase().replace(/[^a-z]/g, '').includes('doordash') ? 'doordash'
            : String(p.provider_id).toLowerCase().includes('grubhub') ? 'grubhub'
            : String(p.provider_id).toLowerCase().includes('uber') ? 'uber' : String(p.provider_id);
          const t = p.pause_until ? Date.parse(p.pause_until) : NaN;
          return { id, label: MARKETPLACE_LABELS[id] ?? String(p.provider_id), paused_until: Number.isFinite(t) ? new Date(t).toISOString() : null };
        })
      : [],
  };
  return { ...body, hash: await contentHash(body as unknown as Record<string, unknown>, []) };
}

// ---- pos-v1-online-orders -------------------------------------------------------------------------------

export async function handleOnlineOrders(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const mismatch = restaurantIdentity(body, a.principal);
  if (mismatch) return mismatch;
  if (!nullableString(body.if_none_match)) return bad('if_none_match', 'if_none_match must be a string or null');
  if (!nullableString(body.if_none_match_settings)) return bad('if_none_match_settings', 'if_none_match_settings must be a string or null');
  const hist = body.history;
  if (hist !== undefined && hist !== null && (typeof hist !== 'object' || Array.isArray(hist) || typeof (hist as Row).business_date !== 'string')) {
    return bad('history.business_date', 'history must be { business_date: "YYYY-MM-DD" } or null');
  }
  const rid = a.principal.restaurant_id;
  const nowMs = deps.now();

  let restaurant: Row;
  try {
    restaurant = await readRestaurant(deps.db, rid);
  } catch (err) {
    if (err instanceof FeedError && err.code !== 'feed_query_failed') {
      deps.log('online_feed_failed', { restaurant_id: rid, code: err.code });
      return errorResult(500, 'feed_config_invalid', 'the restaurant is not configured for online orders');
    }
    throw err;
  }
  let scope: FeedScope;
  if (hist) {
    try {
      scope = { kind: 'history', range: historyRange((hist as Row).business_date, restaurant.timezone) };
    } catch {
      return bad('history.business_date', 'history.business_date must be a real YYYY-MM-DD date');
    }
  } else scope = { kind: 'live', window: feedWindow(nowMs, restaurant.timezone) };

  const dsp = restaurant.dsp_orders_enabled === true;
  let rows;
  try {
    rows = await loadOnlineRows(deps.db, rid, scope, { kitchenHub: dsp });
  } catch (err) {
    if (err instanceof FeedError && err.code === 'feed_too_large') {
      deps.log('online_feed_too_large', { restaurant_id: rid, message: err.message });
      return errorResult(503, 'feed_too_large', 'too many online orders to send at once');
    }
    throw err;
  }
  const ids = [...rows.orders, ...rows.kitchenhub].map((r) => String(r.id));
  const [state, pos, hours, providers] = await Promise.all([
    deps.online.printState(rid, ids),
    deps.online.getSettings(rid),
    readRows<HoursRow>('hours', deps.db.from('hours').select('day_of_week, is_open, open_time, close_time').eq('restaurant_id', rid).order('day_of_week')),
    dsp
      ? readRows<{ provider_id: string; pause_until: string | null }>('dsp_provider_status', deps.db.from('dsp_provider_status').select('provider_id, pause_until').eq('restaurant_id', rid))
      : Promise.resolve([]),
  ]);
  const orders = servedOrders(rows, state);
  const settings = await buildSettings(restaurant, hours, pos ?? DEFAULT_POS_SETTINGS, providers);
  const token = scope.kind === 'history' ? `history:${scope.range.business_date}` : `v1.${await feedHash(orders)}`;
  const notModified = scope.kind === 'live' && body.if_none_match === token;
  return okResult({
    not_modified: notModified,
    orders: notModified ? [] : orders,
    token,
    settings: body.if_none_match_settings === settings.hash ? { not_modified: true, hash: settings.hash } : settings,
    menu_snapshot_hash: null,
    server_time: new Date(nowMs).toISOString(),
  });
}

// ---- one order (print response) --------------------------------------------------------------------------

export interface OneOrder { channel: OrderChannel; row: FeedRow }

/** The order by id from either table (service role; NOT restaurant-scoped — the caller compares). */
export async function readOneOrder(db: FeedClient, orderId: string): Promise<OneOrder | null> {
  const o = await db.from('orders').select(FEED_SELECT).eq('id', orderId).maybeSingle();
  if (o.error) throw new Error(`orders read failed: ${o.error.message}`);
  if (o.data) return { channel: 'ordr', row: normalizeFeedRows([o.data])[0] };
  const k = await db.from('external_orders').select(KH_FEED_SELECT).eq('id', orderId).maybeSingle();
  if (k.error) throw new Error(`external_orders read failed: ${k.error.message}`);
  return k.data ? { channel: 'kitchenhub', row: k.data } : null;
}

export async function orderWire(deps: OnlineDeps, restaurantId: string, one: OneOrder): Promise<OnlineOrderWire> {
  const state = await deps.online.printState(restaurantId, [one.row.id]);
  const rows = one.channel === 'ordr' ? { orders: [one.row], kitchenhub: [] } : { orders: [], kitchenhub: [one.row] };
  return servedOrders(rows, state)[0];
}

function itemCount(one: OneOrder): number {
  const items = one.channel === 'ordr' ? one.row.order_items : one.row.items;
  return Array.isArray(items) ? items.filter((x: unknown) => x && typeof x === 'object').length : 0;
}

// ---- pos-v1-online-print ----------------------------------------------------------------------------------

const VARIANTS: readonly PrintVariant[] = ['auto', 'manual', 'reprint'];
const RESULTS: readonly PrintResult[] = ['printed', 'printed_unconfirmed', 'failed'];
export const PRINT_ERROR_MAX = 500;

function stationProblem(s: unknown, items: number, field: string): DeviceResult | null {
  const p = stationRefProblem(s);
  if (p) return bad(field, `${field}: ${p}`);
  if ((s as OnlineStationRef).lines.some((n) => n >= items)) return bad(field, `${field}.lines: an index is past the order's ${items} items`);
  return null;
}

export async function handleOnlinePrint(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const mismatch = restaurantIdentity(body, a.principal);
  if (mismatch) return mismatch;
  const pr = a.principal;

  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  if (typeof body.order_id !== 'string' || !UUID_RE.test(body.order_id)) return bad('order_id', 'order_id must be a UUID');
  if (body.op !== 'claim' && body.op !== 'result') return bad('op', 'op must be claim or result');
  if (!nullableString(body.error)) return bad('error', 'error must be a string or null');
  if (!nullableString(body.device_time)) return bad('device_time', 'device_time must be a string');
  const actionId = body.action_id.toLowerCase();
  const orderId = body.order_id.toLowerCase();

  const one = await readOneOrder(deps.db, orderId);
  if (!one || (one.channel === 'ordr' && !one.row.items_written_at)) return errorResult(400, 'unknown_order', 'no such order');
  if (one.row.restaurant_id !== pr.restaurant_id) return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant', { field: 'order_id' });
  const items = itemCount(one);

  let stations: OnlineStationRef[] = [];
  let station: OnlineStationRef | null = null;
  if (body.op === 'claim') {
    if (!Array.isArray(body.stations) || body.stations.length < 1 || body.stations.length > 200) return bad('stations', 'stations: 1–200 stations (the counter ticket first)');
    for (const [i, s] of body.stations.entries()) {
      const p = stationProblem(s, items, `stations[${i}]`);
      if (p) return p;
    }
    stations = (body.stations as OnlineStationRef[]).map((s) => ({ station: s.station, name: s.name, lines: [...s.lines] }));
    if (new Set(stations.map((s) => s.station)).size !== stations.length) return bad('stations', 'stations: a station appears twice');
  } else {
    if (!VARIANTS.includes(body.variant as PrintVariant)) return bad('variant', 'variant must be auto | manual | reprint');
    if (!RESULTS.includes(body.result as PrintResult)) return bad('result', 'result must be printed | printed_unconfirmed | failed');
    if (body.station === null || body.station === undefined) return bad('station', 'station is required on a result (station routing)');
    const p = stationProblem(body.station, items, 'station');
    if (p) return p;
    const s = body.station as OnlineStationRef;
    station = { station: s.station, name: s.name, lines: [...s.lines] };
  }

  // idempotency: pos_online_actions by action_id; the request = the body minus device_time (§3c:732, fakeOnline.ts:282-292)
  const { device_time: _dt, ...request } = body;
  void _dt;
  const begin = await deps.online.beginAction({
    actionId, restaurantId: pr.restaurant_id, deviceId: pr.device_id, staffId: null, orderId,
    action: body.op === 'claim' ? 'print_claim' : 'print_result', request,
  });
  if (begin.outcome === 'action_id_reused') return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
  if (begin.outcome === 'duplicate') {
    if (begin.http_status !== 200) return { status: begin.http_status, body: begin.result };
    const order = await orderWire(deps, pr.restaurant_id, (await readOneOrder(deps.db, orderId))!);
    return okResult({ result: 'duplicate', claimed: order.print.claimed_by_device_id === pr.device_id, order, server_time: new Date(deps.now()).toISOString() });
  }

  let result: 'applied' | 'noop';
  try {
    if (body.op === 'claim') {
      const c = await deps.online.claimPrint({
        restaurantId: pr.restaurant_id, channel: one.channel, orderId, deviceId: pr.device_id, stations,
        printStatusPrinted: one.row.print_status === 'printed',
      });
      // errors leave the action pending: a resend re-evaluates (the reference stores no error for print, fakeOnline.ts:295-298)
      if (c.outcome !== 'ok') {
        if (c.outcome === 'not_designated') return errorResult(400, 'not_designated', 'this register does not auto-print online orders');
        if (c.outcome === 'auto_print_off') return errorResult(400, 'auto_print_off', 'online auto-print is off');
        if (c.outcome === 'restaurant_mismatch') return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant');
        return errorResult(403, 'device_not_allowed', 'this register is not active');
      }
      result = c.applied ? 'applied' : 'noop';
    } else {
      const rec = await deps.online.recordPrint({
        restaurantId: pr.restaurant_id, channel: one.channel, orderId, deviceId: pr.device_id, actionId,
        variant: body.variant as PrintVariant, result: body.result as PrintResult, station: station!,
        error: typeof body.error === 'string' ? body.error.slice(0, PRINT_ERROR_MAX) : null,
        deviceTime: typeof body.device_time === 'string' && Number.isFinite(Date.parse(body.device_time)) ? new Date(Date.parse(body.device_time)).toISOString() : null,
      });
      if (rec.outcome === 'restaurant_mismatch') return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant');
      if (rec.outcome === 'device_not_allowed') return errorResult(403, 'device_not_allowed', 'this register is not active');
      if (rec.outcome === 'recorded') {
        // the tablet's columns, truthfully (§3c:719-731): print_trigger from the restaurant, status as the row has it
        const { data: rest } = await deps.db.from('restaurants').select('print_trigger').eq('id', pr.restaurant_id).maybeSingle();
        const status = one.channel === 'ordr' ? String(one.row.status) : ({ new: 'new', accepted: 'in_progress', completed: 'complete', cancelled: 'cancelled' } as Record<string, string>)[one.row.status] ?? 'new';
        const w = tabletWrite(
          { variant: body.variant as PrintVariant, result: body.result as PrintResult, error: typeof body.error === 'string' ? body.error.slice(0, PRINT_ERROR_MAX) : null },
          rec.order_result, rest?.print_trigger === 'in_progress' ? 'in_progress' : 'received', status,
        );
        const out = await writeTabletPrintColumns(deps.db, { restaurantId: pr.restaurant_id, channel: one.channel, orderId, write: w, nowIso: new Date(deps.now()).toISOString() }, { sleep: deps.sleep });
        if (out.log_error || out.status_error) deps.log('online_print_tablet_write_failed', { order_id: orderId, log_error: out.log_error, status_error: out.status_error });
      }
      // 'duplicate' = a resend of a pending action whose SQL already committed: the tablet write is not repeated
      result = 'applied';
    }
  } catch (err) {
    if (err instanceof OnlineStoreError) return bad(body.op === 'claim' ? 'stations' : 'station', err.message);
    throw err;
  }
  await deps.online.completeAction(actionId, pr.device_id, { result }, 200);
  const order = await orderWire(deps, pr.restaurant_id, (await readOneOrder(deps.db, orderId))!);
  return okResult({ result, claimed: order.print.claimed_by_device_id === pr.device_id, order, server_time: new Date(deps.now()).toISOString() });
}
