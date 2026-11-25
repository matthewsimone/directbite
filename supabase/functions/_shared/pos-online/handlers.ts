/**
 * pos-v1-online-orders + pos-v1-online-print (ordr-pos @ 7798d52 docs/SYNC-CONTRACT.md §3c :481-591, :673-732;
 * reference test/support/fakeOnline.ts poll :501-537, print :273-316, served :540-545)
 * + pos-v1-online-order-action + pos-v1-online-settings (CP18; ordr-pos @ 86c558d §3c :593-671; reference
 * fakeOnline.ts settingsChange :331-350, action :354-433; src/dev/onlineActionRules.ts, onlineSettingsRules.ts);
 * CP19 money: cancel_refund = admin-refund {type: full} via adminRefundGlue.ts (hash-pinned copy), adjustment_request =
 * the tablet's ADJUST insert (113).
 *
 * Both run the device middleware (§1a) and the body restaurant rule (400 restaurant_mismatch). Handlers are pure
 * over their deps (DeviceRequest → DeviceResult) so tests run without a server.
 *
 * Feed: the FULL current state every poll (feedQuery.ts + wire.ts), opaque token = SHA-256 of the served orders
 * (same token back → not_modified, orders []), 503 feed_too_large (never truncated), settings unless
 * if_none_match_settings equals their hash, history { business_date } (read-only).
 * Print: claim / result per STATION (110 SQL via store.ts), idempotent by action_id (pos_online_actions, 111 shape),
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
import { ACK_ACTIONS, ONLINE_ACTIONS, type Cp18Action } from './actionRules.ts';
import { adminRefundFull, type AdminRefundGlueDeps } from './adminRefundGlue.ts';
import { containsCardNumber } from '../ordr-core-ext/cardData.ts';
import { buildMenuSnapshot, type SnapshotDb } from '../pos-sync/menuSnapshot.ts';
import { writeTabletPrintColumns, type PrintClient } from './printColumns.ts';
import { tabletWrite, type OnlineStationRef, type PrintResult, type PrintVariant } from './printRules.ts';
import { DEFAULT_POS_SETTINGS, OnlineStoreError, stationRefProblem, type OnlinePosSettings, type OnlineStore, type OrderChannel } from './store.ts';
import { intIn, MARKETPLACE_LABELS, servedOrders, type OnlineOrderWire, type OnlineSettingsWire } from './wire.ts';

export interface OnlineDeps extends AuthDeps {
  /** Service-role supabase-js client (reads orders / external_orders / restaurants; the tablet's print write). */
  db: FeedClient & PrintClient;
  online: OnlineStore;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The ready email after an applied accept with a quoted time, once per order: call the EXISTING send-ready-email
   * function exactly as the tablet does (OrdersTab.jsx :711-718 — POST {order_id}, anon bearer, not awaited).
   * Fire-and-forget: never throws, never delays the answer (the entry point hands it to EdgeRuntime.waitUntil).
   */
  readyEmail?: (orderId: string) => void;
  /**
   * The menu-snapshot reads (pos-v1-menu-snapshot's own builder, _shared/pos-sync/menuSnapshot.ts): after an
   * item_availability change the answer carries the current snapshot hash so the register pulls it (§3c:666-667).
   * Absent → menu_snapshot_hash null (the register picks the change up on its next menu pull).
   */
  snapshotDb?: SnapshotDb;
  /**
   * Cancel & Refund (CP19): what admin-refund's glue needs besides the service-role client (`db`) — the platform
   * Stripe client and the two shared modules, imported unchanged by the entry point. Absent → cancel_refund 501.
   */
  refund?: Pick<AdminRefundGlueDeps, 'stripe' | 'cancelUberDelivery' | 'refundUberAppFee'>;
}

const nullableString = (v: unknown) => v === null || v === undefined || typeof v === 'string';
/** device_time → ISO (null when absent / unparseable: an audit value, never trusted for logic). */
const isoOrNullTime = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
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

// ---- logging -----------------------------------------------------------------------------------------------

/**
 * TEMPORARY — REMOVE AFTER CP19. Live bug (Test Pizza, 2026-11-24): every pos-v1-online-print RESULT call answered
 * 400. While true, each RESULT call logs one line: the raw request body (no token — headers are never logged; the
 * device id comes from x-ordr-device-id), the response status + body, tagged device_id and action_id.
 */
export const RESULT_DEBUG_LOG = true;
const DEBUG_BODY_MAX = 8192;

/**
 * Every 4xx / 5xx answer of a pos-v1-online-* function — incl. the ones handleDeviceHttp gives itself (405, the
 * version gate, an oversized body, 500 internal_error): one log line with the status, the error code and the field.
 * Never a body, a token or PII. Never throws, never changes the response.
 */
export async function logErrorResponse(log: (event: string, data?: Record<string, unknown>) => void, res: Response): Promise<Response> {
  if (res.status >= 400) {
    let code: string | null = null;
    let field: string | null = null;
    try {
      const e = (await res.clone().json())?.error;
      code = typeof e?.code === 'string' ? e.code : null;
      field = typeof e?.field === 'string' ? e.field : null;
    } catch {
      // not JSON: status only
    }
    try {
      log('error_response', { status: res.status, code, field });
    } catch {
      // a broken logger must never break a request
    }
  }
  return res;
}

export async function handleOnlinePrint(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
  const res = await handleOnlinePrintInner(req, deps);
  if (RESULT_DEBUG_LOG) {
    let body: Row | null = null;
    try {
      const v = JSON.parse(req.bodyText);
      body = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      body = null;
    }
    if (body?.op === 'result') {
      deps.log('print_result_debug', {
        device_id: req.headers.get('x-ordr-device-id'),
        action_id: typeof body.action_id === 'string' ? body.action_id : null,
        status: res.status,
        request: req.bodyText.slice(0, DEBUG_BODY_MAX),
        response: res.body,
      });
    }
  }
  return res;
}

async function handleOnlinePrintInner(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
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
    actionId, fn: 'print', restaurantId: pr.restaurant_id, deviceId: pr.device_id, channel: one.channel, orderId,
    action: body.op === 'claim' ? 'print_claim' : 'print_result', request, actor: null, approver: null,
    deviceTime: isoOrNullTime(body.device_time),
  });
  if (begin.outcome === 'action_id_reused') return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
  if (begin.outcome === 'duplicate') {
    if (begin.stored === 'error') return errorResult(begin.error_status ?? 500, begin.error_code ?? 'error', begin.error_message ?? '');
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
        deviceTime: isoOrNullTime(body.device_time),
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
  await deps.online.completeAction(actionId, pr.device_id, result);
  const order = await orderWire(deps, pr.restaurant_id, (await readOneOrder(deps.db, orderId))!);
  return okResult({ result, claimed: order.print.claimed_by_device_id === pr.device_id, order, server_time: new Date(deps.now()).toISOString() });
}

// ---- shared: the settings wire, actor / approver ------------------------------------------------------------

/** OnlineSettingsWire as the feed serves it (buildSettings over the restaurant + pos_restaurant_settings). */
export async function loadSettingsWire(deps: OnlineDeps, rid: string): Promise<OnlineSettingsWire> {
  const restaurant = await readRestaurant(deps.db, rid);
  const dsp = restaurant.dsp_orders_enabled === true;
  const [pos, hours, providers] = await Promise.all([
    deps.online.getSettings(rid),
    readRows<HoursRow>('hours', deps.db.from('hours').select('day_of_week, is_open, open_time, close_time').eq('restaurant_id', rid).order('day_of_week')),
    dsp
      ? readRows<{ provider_id: string; pause_until: string | null }>('dsp_provider_status', deps.db.from('dsp_provider_status').select('provider_id, pause_until').eq('restaurant_id', rid))
      : Promise.resolve([]),
  ]);
  return buildSettings(restaurant, hours, pos ?? DEFAULT_POS_SETTINGS, providers);
}

/**
 * actor_staff_id: a staff uuid or 'register' (onlineContract.ts :568-569; null tolerated = not sent);
 * approver_staff_id: uuid | null. Recorded in pos_online_actions as sent — the manager approval is the DEVICE's
 * (§3c:669-670 "Manager-approved on the device … actor + approver go in pos_online_actions").
 */
function whoOf(body: Row): { actor: string | null; approver: string | null } | DeviceResult {
  const a = body.actor_staff_id;
  if (!(a === null || a === undefined || a === 'register' || (typeof a === 'string' && UUID_RE.test(a)))) {
    return bad('actor_staff_id', "actor_staff_id must be a staff id or 'register'");
  }
  const p = body.approver_staff_id;
  if (!(p === null || p === undefined || (typeof p === 'string' && UUID_RE.test(p)))) return bad('approver_staff_id', 'approver_staff_id must be a staff id or null');
  if (!nullableString(body.device_time)) return bad('device_time', 'device_time must be a string');
  return { actor: typeof a === 'string' ? a.toLowerCase() : null, approver: typeof p === 'string' ? p.toLowerCase() : null };
}
const isResult = (v: unknown): v is DeviceResult => !!v && typeof v === 'object' && 'status' in v && 'body' in v;

// ---- pos-v1-online-order-action --------------------------------------------------------------------------

/** Not built yet → 501 (the POS reads 501 as "Ordr can't do this yet", onlineActions.ts :66, :224). */
const LATER: Record<string, string> = {
  dispatch_delivery: 'CP20', self_deliver: 'CP20',
  ext_ack: 'CP21', ext_accept: 'CP21', ext_ready: 'CP21', ext_cancel: 'CP21',
};

/** Served orders by id (Ordr; FEED_SELECT, chunks of 100 ids). Unwritten rows are never served. */
async function ordrWires(deps: OnlineDeps, rid: string, ids: string[]): Promise<OnlineOrderWire[]> {
  if (!ids.length) return [];
  const rows: FeedRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await deps.db.from('orders').select(FEED_SELECT).eq('restaurant_id', rid).in('id', chunk);
    if (error) throw new Error(`orders read failed: ${error.message}`);
    rows.push(...normalizeFeedRows(Array.isArray(data) ? data : []));
  }
  return servedOrders({ orders: rows, kitchenhub: [] }, await deps.online.printState(rid, ids));
}

async function currentWire(deps: OnlineDeps, rid: string, orderId: string): Promise<OnlineOrderWire | null> {
  const one = await readOneOrder(deps.db, orderId);
  return one ? (await orderWire(deps, rid, one)) ?? null : null;
}

export async function handleOnlineOrderAction(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const mismatch = restaurantIdentity(body, a.principal);
  if (mismatch) return mismatch;
  const pr = a.principal;
  const rid = pr.restaurant_id;

  // fakeOnline.ts :361-367: action_id / action, order_id ⇔ not bulk, unknown_order, restaurant_mismatch
  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  if (typeof body.action !== 'string' || !(ONLINE_ACTIONS as readonly string[]).includes(body.action)) return bad('action', 'unknown action');
  if (LATER[body.action]) return errorResult(501, 'not_implemented', `${body.action} is not available on Ordr yet (${LATER[body.action]})`);
  const action = body.action as Cp18Action;
  const bulk = action === 'complete_all_in_progress';
  if (bulk ? body.order_id !== null && body.order_id !== undefined : typeof body.order_id !== 'string' || !UUID_RE.test(body.order_id)) {
    return bad('order_id', bulk ? 'complete_all_in_progress takes order_id null' : 'order_id is required');
  }
  if (!nullableString(body.expected_status)) return bad('expected_status', 'expected_status must be a string or null');
  if (!bulk && !ACK_ACTIONS.includes(action) && typeof body.expected_status !== 'string') return bad('expected_status', 'expected_status is required');
  const q = body.quoted_ready_minutes;
  if (!(q === null || q === undefined || typeof q === 'number')) return bad('quoted_ready_minutes', 'quoted_ready_minutes must be a number or null');
  const who = whoOf(body);
  if (isResult(who)) return who;
  const actionId = body.action_id.toLowerCase();
  const orderId = bulk ? null : String(body.order_id).toLowerCase();

  if (orderId !== null) {
    const one = await readOneOrder(deps.db, orderId);
    if (!one || (one.channel === 'ordr' && !one.row.items_written_at)) return errorResult(400, 'unknown_order', 'no such order');
    if (one.row.restaurant_id !== rid) return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant', { field: 'order_id' });
    // onlineActionRules.ts :120 — an Ordr action on a KitchenHub order
    if (one.channel === 'kitchenhub') return errorResult(400, 'action_not_allowed', `${action} on a kitchenhub order`);
  }
  // CP19: the money actions (orderId is set — not bulk)
  if ((body.action === 'cancel_refund' || body.action === 'adjustment_request') && orderId !== null) {
    const { device_time: _d, ...req } = body;
    void _d;
    const m: MoneyCall = { deps, rid, deviceId: pr.device_id, actionId, orderId, expected: String(body.expected_status), request: req, who, deviceTime: isoOrNullTime(body.device_time) };
    return body.action === 'cancel_refund' ? cancelRefund(m) : adjustmentRequest(m, body);
  }

  // the quoted time only matters to accept; a non-integer reaches the rule as 0 → invalid_payload at its point
  const quoted = action !== 'accept' || q === null || q === undefined ? null : Number.isSafeInteger(q) && Math.abs(q as number) < 2 ** 31 ? (q as number) : 0;
  const { device_time: _dt, ...request } = body;
  void _dt;
  let out;
  try {
    out = await deps.online.orderAction({
      actionId, restaurantId: rid, deviceId: pr.device_id, orderId, action, expectedStatus: bulk || ACK_ACTIONS.includes(action) ? null : body.expected_status as string,
      quotedReadyMinutes: quoted, request, actor: who.actor, approver: who.approver, deviceTime: isoOrNullTime(body.device_time),
    });
  } catch (err) {
    if (err instanceof OnlineStoreError) return bad('action', err.message);
    throw err;
  }
  const serverTime = () => new Date(deps.now()).toISOString();
  const withOrder = async () => (orderId ? { order: await currentWire(deps, rid, orderId) } : {});
  switch (out.outcome) {
    case 'device_not_allowed':
      return errorResult(403, 'device_not_allowed', 'this register is not active');
    case 'action_id_reused':
      return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
    case 'unknown_order':
      return errorResult(400, 'unknown_order', 'no such order');
    case 'restaurant_mismatch':
      return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant', { field: 'order_id' });
    case 'status_conflict':
      return errorResult(409, 'status_conflict', `the order is ${out.status}`, await withOrder());
    case 'not_allowed':
      return errorResult(400, 'action_not_allowed', out.message);
    case 'invalid':
      return bad('quoted_ready_minutes', out.message);
    case 'duplicate': {
      if (out.stored === 'error') return errorResult(out.error_status ?? 500, out.error_code ?? 'error', out.error_message ?? '', await withOrder());
      return okResult({
        result: 'duplicate', order: orderId ? await currentWire(deps, rid, orderId) : null,
        orders: bulk ? await ordrWires(deps, rid, out.order_ids) : [], server_time: serverTime(),
      });
    }
  }
  if (out.ready_email && orderId) {
    if (deps.readyEmail) deps.readyEmail(orderId);
    else deps.log('online_ready_email_not_configured', { order_id: orderId });
  }
  return okResult({
    result: out.outcome, order: orderId ? await currentWire(deps, rid, orderId) : null,
    orders: bulk ? await ordrWires(deps, rid, out.order_ids) : [], server_time: serverTime(),
  });
}

// ---- pos-v1-online-settings --------------------------------------------------------------------------------

const ESTIMATE_MIN = 1;
const ESTIMATE_MAX = 240;
/** onlineSettingsRules.ts :41 — whole minutes 1–240 (an input check; onlineContract.ts ESTIMATE_MIN/MAX_MINUTES). */
const isMinutes = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= ESTIMATE_MIN && n <= ESTIMATE_MAX;

/** The current menu snapshot hash (null when no snapshotDb / the menu doesn't build — logged). */
async function currentMenuHash(deps: OnlineDeps, rid: string): Promise<string | null> {
  if (!deps.snapshotDb) return null;
  try {
    return (await buildMenuSnapshot(deps.snapshotDb, rid, new Date(deps.now()))).hash;
  } catch (err) {
    deps.log('online_settings_menu_hash_failed', { restaurant_id: rid, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function handleOnlineSettings(req: DeviceRequest, deps: OnlineDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const mismatch = restaurantIdentity(body, a.principal);
  if (mismatch) return mismatch;
  const pr = a.principal;
  const rid = pr.restaurant_id;

  if (typeof body.action_id !== 'string' || !UUID_RE.test(body.action_id)) return bad('action_id', 'action_id must be a UUID');
  const change = body.change;
  // onlineSettingsRules.ts :51-85
  if (!change || typeof change !== 'object' || Array.isArray(change)) return bad('change', 'change is required');
  const kind = (change as Row).kind;
  if (kind === 'estimates' || kind === 'delivery_available' || kind === 'item_availability') return tabletSetting(deps, pr, body, change as Row, kind);
  if (kind !== 'online_print_device' && kind !== 'online_auto_print' && kind !== 'kitchenhub_auto_print') return bad('change.kind', `unknown change ${String(kind)}`);
  let printDeviceId: string | null = null;
  let on: boolean | null = null;
  if (kind === 'online_print_device') {
    const d = (change as Row).device_id;
    if (!(d === null || (typeof d === 'string' && UUID_RE.test(d)))) return bad('change.device_id', 'device_id must be a device id or null');
    printDeviceId = d === null ? null : d.toLowerCase();
  } else {
    if (typeof (change as Row).on !== 'boolean') return bad('change.on', 'on must be true or false');
    on = (change as Row).on;
  }
  const who = whoOf(body);
  if (isResult(who)) return who;
  const { device_time: _dt, ...request } = body;
  void _dt;

  let out;
  try {
    out = await deps.online.settingsChange({
      actionId: body.action_id.toLowerCase(), restaurantId: rid, deviceId: pr.device_id, kind, printDeviceId, on, request,
      actor: who.actor, approver: who.approver, deviceTime: isoOrNullTime(body.device_time),
    });
  } catch (err) {
    if (err instanceof OnlineStoreError) return bad('change', err.message);
    throw err;
  }
  if (out.outcome === 'device_not_allowed') return errorResult(403, 'device_not_allowed', 'this register is not active');
  if (out.outcome === 'action_id_reused') return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
  if (out.outcome === 'invalid_print_register') return bad('change.device_id', 'the print register must be an active register of this restaurant');
  let settings: OnlineSettingsWire;
  try {
    settings = await loadSettingsWire(deps, rid);
  } catch (err) {
    if (err instanceof FeedError && err.code !== 'feed_query_failed') {
      deps.log('online_settings_failed', { restaurant_id: rid, code: err.code });
      return errorResult(500, 'feed_config_invalid', 'the restaurant is not configured for online orders');
    }
    throw err;
  }
  return okResult({ result: out.outcome, settings, menu_snapshot_hash: null, server_time: new Date(deps.now()).toISOString() });
}

/**
 * estimates / delivery_available / item_availability — the web tablet's own settings (112): validation =
 * onlineSettingsRules.ts :55-70 (400 invalid_payload; item not on the current menu → 404 item_not_found), the write =
 * the tablet's exact columns (SettingsTab.jsx :414-421, OrdersTab.jsx :1873-1878, MenuTab.jsx :81-84).
 */
async function tabletSetting(
  deps: OnlineDeps, pr: { restaurant_id: string; device_id: string }, body: Row, change: Row,
  kind: 'estimates' | 'delivery_available' | 'item_availability',
): Promise<DeviceResult> {
  const rid = pr.restaurant_id;
  let pickup: number | null = null;
  let delivery: number | null = null;
  let on: boolean | null = null;
  let itemId: string | null = null;
  if (kind === 'estimates') {
    if (!isMinutes(change.estimated_pickup_minutes) || !isMinutes(change.estimated_delivery_minutes)) {
      return bad('change', `estimates are whole minutes ${ESTIMATE_MIN}–${ESTIMATE_MAX}`);
    }
    pickup = change.estimated_pickup_minutes;
    delivery = change.estimated_delivery_minutes;
  } else if (kind === 'delivery_available') {
    if (typeof change.on !== 'boolean') return bad('change.on', 'on must be true or false');
    on = change.on;
  } else {
    if (typeof change.item_id !== 'string' || typeof change.available !== 'boolean') return bad('change', 'item_id and available are required');
    // not an id → not on the menu (the reference looks it up and answers 404, onlineSettingsRules.ts :66-67)
    if (!UUID_RE.test(change.item_id)) return errorResult(404, 'item_not_found', 'no such item on the current menu');
    itemId = change.item_id.toLowerCase();
    on = change.available;
  }
  const who = whoOf(body);
  if (isResult(who)) return who;
  const { device_time: _dt, ...request } = body;
  void _dt;
  let out;
  try {
    out = await deps.online.tabletSettingChange({
      actionId: String(body.action_id).toLowerCase(), restaurantId: rid, deviceId: pr.device_id, kind, pickupMinutes: pickup,
      deliveryMinutes: delivery, on, itemId, request, actor: who.actor, approver: who.approver, deviceTime: isoOrNullTime(body.device_time),
    });
  } catch (err) {
    if (err instanceof OnlineStoreError) return bad('change', err.message);
    throw err;
  }
  if (out.outcome === 'device_not_allowed') return errorResult(403, 'device_not_allowed', 'this register is not active');
  if (out.outcome === 'action_id_reused') return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
  if (out.outcome === 'item_not_found') return errorResult(404, 'item_not_found', 'no such item on the current menu');
  let settings: OnlineSettingsWire;
  try {
    settings = await loadSettingsWire(deps, rid);
  } catch (err) {
    if (err instanceof FeedError && err.code !== 'feed_query_failed') {
      deps.log('online_settings_failed', { restaurant_id: rid, code: err.code });
      return errorResult(500, 'feed_config_invalid', 'the restaurant is not configured for online orders');
    }
    throw err;
  }
  return okResult({
    result: out.outcome, settings, menu_snapshot_hash: kind === 'item_availability' ? await currentMenuHash(deps, rid) : null,
    server_time: new Date(deps.now()).toISOString(),
  });
}

// ---- money (CP19): Cancel & Refund = admin-refund unchanged; Adjust = the tablet's adjustment request -------------

interface MoneyCall {
  deps: OnlineDeps;
  rid: string;
  deviceId: string;
  actionId: string;
  orderId: string;
  expected: string;
  request: Record<string, unknown>;
  who: { actor: string | null; approver: string | null };
  deviceTime: string | null;
}

/** A pending cancel_refund older than this is a crashed attempt: re-run it (safe — adminRefundGlue.ts header). */
export const PENDING_STALE_MS = 10 * 60_000;
/** The live statuses the tablet offers Cancel & Refund from (onlineActionRules.ts :244). */
const CANCEL_FROM = ['new', 'scheduled', 'in_progress', 'self_delivering'];
/** delivery_failed's reason travels in the stored message as a `[reason] ` prefix (pos_online_actions.error_message). */
const REASON_PREFIX = /^\[([a-z_]+)\] /;

/** A money error as the wire answers it (fresh or replayed): + the order now (status_conflict / refund_failed), + reason. */
async function moneyError(m: MoneyCall, status: number, code: string, message: string): Promise<DeviceResult> {
  const extra: Record<string, unknown> = {};
  let msg = message;
  if (code === 'delivery_failed') {
    const r = REASON_PREFIX.exec(message);
    extra.reason = r ? r[1] : 'provider_error';
    if (r) msg = message.slice(r[0].length);
  }
  if (code === 'status_conflict' || code === 'refund_failed') extra.order = await currentWire(m.deps, m.rid, m.orderId);
  return errorResult(status, code, msg, extra);
}

async function moneyOk(m: MoneyCall, result: 'applied' | 'noop' | 'duplicate'): Promise<DeviceResult> {
  return okResult({ result, order: await currentWire(m.deps, m.rid, m.orderId), orders: [], server_time: new Date(m.deps.now()).toISOString() });
}

/**
 * cancel_refund — §3c:627 + onlineActionRules.ts :159-160, :243-258, run as admin-refund {type:'full'}:
 * begin (a PENDING pos_online_actions row: a concurrent resend gets 503 action_pending, a crashed one is re-run after
 * PENDING_STALE_MS) → the order now (select *) → compare-and-set + the statuses the tablet offers it from → the
 * admin-refund glue (Uber first, then Stripe, the orders writes) → finish: applied, noop, or the error STORED (the
 * resend answers the same error — never a second Stripe / Uber call, §3c:608-610).
 */
async function cancelRefund(m: MoneyCall): Promise<DeviceResult> {
  const { deps } = m;
  if (!deps.refund) return errorResult(501, 'not_implemented', 'cancel_refund is not configured on this server');
  const begin = await deps.online.beginAction({
    actionId: m.actionId, fn: 'order_action', restaurantId: m.rid, deviceId: m.deviceId, channel: 'ordr', orderId: m.orderId,
    action: 'cancel_refund', request: m.request, actor: m.who.actor, approver: m.who.approver, deviceTime: m.deviceTime,
  });
  if (begin.outcome === 'action_id_reused') return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
  if (begin.outcome === 'duplicate') {
    if (begin.stored === 'error') return moneyError(m, begin.error_status ?? 500, begin.error_code ?? 'internal_error', begin.error_message ?? '');
    return moneyOk(m, 'duplicate');
  }
  if (begin.outcome === 'pending') {
    const since = Date.parse(begin.since ?? '');
    if (!Number.isFinite(since) || deps.now() - since < PENDING_STALE_MS) {
      return errorResult(503, 'action_pending', 'this refund is still being processed — try again in a moment', { retryAfterMs: 5_000 });
    }
    deps.log('online_refund_rerun', { action_id: m.actionId, order_id: m.orderId });
  }
  const fail = async (status: number, code: string, message: string) => {
    await deps.online.finishAction(m.actionId, m.deviceId, 'error', { status, code, message });
    return moneyError(m, status, code, message);
  };
  const { data: order, error } = await deps.db.from('orders').select('*').eq('id', m.orderId).maybeSingle();
  if (error) throw new Error(`orders read failed: ${error.message}`);
  if (!order || order.restaurant_id !== m.rid) return fail(400, 'unknown_order', 'no such order');
  if (order.status !== m.expected) return fail(409, 'status_conflict', `the order is ${order.status}`);
  if (!CANCEL_FROM.includes(order.status)) return fail(400, 'action_not_allowed', `cancel from ${order.status}`);

  const r = await adminRefundFull({ supabase: deps.db, log: deps.log, ...deps.refund }, order, m.actionId);
  switch (r.kind) {
    case 'idempotent':
      await deps.online.finishAction(m.actionId, m.deviceId, 'noop');
      return moneyOk(m, 'noop');
    case 'already_delivered':
      return fail(400, 'already_delivered', 'the order was already delivered — no refund');
    case 'no_payment_intent':
    case 'no_stripe_account':
      return fail(400, 'action_not_allowed', r.message);
    case 'uber_cancel_failed': {
      // admin-refund :168-180 — nothing refunded; uberCancel.ts 'uber_cancel_failed' = Uber refused (driver has the food)
      const reason = r.error === 'uber_cancel_failed' ? 'cannot_cancel' : 'provider_error';
      deps.log('online_refund_uber_cancel_failed', { action_id: m.actionId, order_id: m.orderId, error: r.error });
      return fail(502, 'delivery_failed', `[${reason}] Uber could not cancel the delivery — NOT refunded`);
    }
    case 'stripe_failed':
      return fail(502, 'refund_failed', r.message || 'the card refund did not go through');
    case 'refunded':
      await deps.online.finishAction(m.actionId, m.deviceId, 'applied');
      return moneyOk(m, 'applied');
  }
}

/**
 * adjustment_request — the tablet's ADJUST (OrdersTab.jsx :725-736; Matt: extra charge / refund after Complete =
 * this request, an admin approves in /admin → admin-approve-adjustment moves the money). onlineActionRules.ts
 * :161-170: type charge | refund, amount_cents > 0 (400 amount_invalid), a note 1–200 characters (trimmed, as the
 * tablet), no card numbers (vendored ordr-core-ext/cardData.ts → 400 card_data_rejected); complete orders only,
 * compare-and-set (113 SQL, one transaction with the insert + the action row).
 */
async function adjustmentRequest(m: MoneyCall, body: Row): Promise<DeviceResult> {
  const type = body.adjustment_type;
  if (type !== 'charge' && type !== 'refund') return bad('adjustment_type', 'adjustment_type must be charge or refund');
  const cents = body.amount_cents;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents < 1) return errorResult(400, 'amount_invalid', 'amount_cents must be > 0', { field: 'amount_cents' });
  const note = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (note.length < 1 || note.length > 200) return bad('reason', 'a note (1–200 characters) is required');
  if (containsCardNumber(note)) return errorResult(400, 'card_data_rejected', 'card-number-like text in the note', { field: 'reason' });
  let out;
  try {
    out = await m.deps.online.adjustmentRequest({
      actionId: m.actionId, restaurantId: m.rid, deviceId: m.deviceId, orderId: m.orderId, expectedStatus: m.expected, type, amountCents: cents,
      note, request: m.request, actor: m.who.actor, approver: m.who.approver, deviceTime: m.deviceTime,
    });
  } catch (err) {
    if (err instanceof OnlineStoreError) return bad('reason', err.message);
    throw err;
  }
  switch (out.outcome) {
    case 'device_not_allowed':
      return errorResult(403, 'device_not_allowed', 'this register is not active');
    case 'action_id_reused':
      return errorResult(409, 'action_id_reused', 'this action_id was used for another request');
    case 'unknown_order':
      return errorResult(400, 'unknown_order', 'no such order');
    case 'restaurant_mismatch':
      return errorResult(400, 'restaurant_mismatch', 'the order belongs to another restaurant', { field: 'order_id' });
    case 'error':
      return moneyError(m, out.error_status, out.error_code, out.error_message);
    case 'duplicate':
      if (out.stored === 'error') return moneyError(m, out.error_status ?? 500, out.error_code ?? 'internal_error', out.error_message ?? '');
      return moneyOk(m, 'duplicate');
    case 'applied':
      return moneyOk(m, 'applied');
  }
}
