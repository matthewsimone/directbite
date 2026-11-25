/**
 * POS online persistence — migrations 109 + 110 + 111: print register + flags, per-station print claims / results,
 * the print state read, device actions (idempotency, pos_online_actions in the handoff shape), the Ordr order
 * actions and the POS settings changes. Every write is ONE plpgsql function (one transaction).
 * MemoryOnlineStore mirrors the SQL for tests — keep the two in step (110_smoke.sql / 111_smoke.sql run the same
 * scenarios against Postgres; tests/store.test.ts and tests/actions.test.ts check the mirror against the ported
 * reference rules, printRules.ts / actionRules.ts).
 *
 * Print: the order is NOT checked here (110 never touches orders / external_orders): the caller first confirms the
 * order belongs to the principal's restaurant, is written (items_written_at), and passes its print_status.
 * Order actions (111): the function locks + re-checks the order itself and makes the web tablet's write.
 */
import { ordrActionRule, type Cp18Action } from './actionRules.ts';
import { orderPrintResult, type OnlineStationRef, type PrintResult, type PrintVariant } from './printRules.ts';

export type OrderChannel = 'ordr' | 'kitchenhub';

export interface OnlinePosSettings {
  print_register_device_id: string | null;
  pos_online_orders_enabled: boolean;
  online_auto_print_enabled: boolean;
  kitchenhub_auto_print_enabled: boolean;
}
/** No pos_restaurant_settings row = every default (handoff DDL). */
export const DEFAULT_POS_SETTINGS: OnlinePosSettings = {
  print_register_device_id: null,
  pos_online_orders_enabled: false,
  online_auto_print_enabled: false,
  kitchenhub_auto_print_enabled: false,
};

export type ClaimOutcome =
  | { outcome: 'ok'; applied: boolean; claimed: boolean }
  | { outcome: 'device_not_allowed' | 'not_designated' | 'auto_print_off' | 'restaurant_mismatch' };

export type RecordOutcome =
  | { outcome: 'recorded'; order_result: PrintResult | null; claimed_by: string | null }
  | { outcome: 'duplicate' | 'device_not_allowed' | 'restaurant_mismatch' };

export interface ClaimInput {
  restaurantId: string;
  channel: OrderChannel;
  orderId: string;
  deviceId: string;
  stations: OnlineStationRef[];
  /** The order's own print_status is 'printed' (the tablet printed it) → never claimed. */
  printStatusPrinted: boolean;
}

export interface RecordInput {
  restaurantId: string;
  channel: OrderChannel;
  orderId: string;
  deviceId: string;
  actionId: string;
  variant: PrintVariant;
  result: PrintResult;
  station: OnlineStationRef;
  error: string | null;
  deviceTime: string | null;
}

export interface ClaimRow { order_channel: OrderChannel; order_id: string; device_id: string; claimed_at: string; result: PrintResult | null; printed_at: string | null }
export interface StationRow { order_channel: OrderChannel; order_id: string; station: string; name: string; lines: number[]; position: number; result: PrintResult | null; printed_at: string | null }
export interface LogRow { order_channel: OrderChannel; order_id: string; at: string; device_id: string; variant: PrintVariant; result: PrintResult; error: string | null; station: string | null }
export interface PrintState { claims: ClaimRow[]; stations: StationRow[]; log: LogRow[] }

export type ActionFunction = 'order_action' | 'print' | 'settings';
export type StoredOutcome = 'applied' | 'noop' | 'error';

/** A stored action replayed: its outcome (+ the error it answered, + complete_all_in_progress's orders). */
export interface StoredAction {
  stored: StoredOutcome;
  error_status: number | null;
  error_code: string | null;
  error_message: string | null;
  order_ids: string[];
}

export type ActionBeginOutcome =
  | { outcome: 'started' | 'pending' | 'action_id_reused' }
  | ({ outcome: 'duplicate' } & StoredAction);

export type ActionCompleteOutcome =
  | { outcome: 'completed' | 'not_found' | 'device_mismatch' }
  | { outcome: 'already_completed'; stored: StoredOutcome };

/** pos_online_action_begin (the print function's idempotency: a pending row, completed after the work). */
export interface ActionBegin {
  actionId: string;
  fn: ActionFunction;
  restaurantId: string;
  deviceId: string;
  channel: OrderChannel | null;
  orderId: string | null;
  action: string;
  /** The request minus device_time (same id + another request → action_id_reused). */
  request: Record<string, unknown>;
  actor: string | null;
  approver: string | null;
  deviceTime: string | null;
}

/** pos_online_order_action (111). orderId null ⇔ complete_all_in_progress. */
export interface OrderActionInput {
  actionId: string;
  restaurantId: string;
  deviceId: string;
  orderId: string | null;
  action: Cp18Action;
  expectedStatus: string | null;
  quotedReadyMinutes: number | null;
  request: Record<string, unknown>;
  actor: string | null;
  approver: string | null;
  deviceTime: string | null;
}

export type OrderActionOutcome =
  | { outcome: 'applied' | 'noop'; ready_email: boolean; order_ids: string[] }
  | ({ outcome: 'duplicate' } & StoredAction)
  | { outcome: 'status_conflict'; status: string }
  | { outcome: 'not_allowed' | 'invalid'; message: string }
  | { outcome: 'device_not_allowed' | 'action_id_reused' | 'unknown_order' | 'restaurant_mismatch' };

export type SettingsKind = 'online_print_device' | 'online_auto_print' | 'kitchenhub_auto_print';

/** pos_online_settings_change (111). */
export interface SettingsChangeInput {
  actionId: string;
  restaurantId: string;
  deviceId: string;
  kind: SettingsKind;
  /** online_print_device: the register (null = none). */
  printDeviceId: string | null;
  /** online_auto_print / kitchenhub_auto_print. */
  on: boolean | null;
  request: Record<string, unknown>;
  actor: string | null;
  approver: string | null;
  deviceTime: string | null;
}

export type SettingsChangeOutcome =
  | { outcome: 'applied' | 'noop' | 'device_not_allowed' | 'action_id_reused' | 'invalid_print_register' }
  | { outcome: 'duplicate'; stored: StoredOutcome };

export interface OnlineStore {
  setPrintRegister(restaurantId: string, deviceId: string | null, updatedBy: string): Promise<void>;
  /** pos_restaurant_settings (null = no row). */
  getSettings(restaurantId: string): Promise<OnlinePosSettings | null>;
  claimPrint(c: ClaimInput): Promise<ClaimOutcome>;
  recordPrint(r: RecordInput): Promise<RecordOutcome>;
  printState(restaurantId: string, orderIds: string[]): Promise<PrintState>;
  beginAction(a: ActionBegin): Promise<ActionBeginOutcome>;
  completeAction(actionId: string, deviceId: string, outcome: 'applied' | 'noop'): Promise<ActionCompleteOutcome>;
  orderAction(a: OrderActionInput): Promise<OrderActionOutcome>;
  settingsChange(c: SettingsChangeInput): Promise<SettingsChangeOutcome>;
}

export class OnlineStoreError extends Error {
  readonly code: 'invalid_print_register' | 'invalid_input';
  constructor(code: OnlineStoreError['code'], message: string) {
    super(message);
    this.name = 'OnlineStoreError';
    this.code = code;
  }
}

/** The input checks 110's functions make (22023), shared by the memory mirror and the handler's validation. */
export function stationRefProblem(s: unknown): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  const o = s as Record<string, unknown>;
  if (typeof o.station !== 'string' || o.station.length < 1 || o.station.length > 200) return 'station (1–200 chars)';
  if (typeof o.name !== 'string' || o.name.length < 1 || o.name.length > 200) return 'name (1–200 chars)';
  if (!Array.isArray(o.lines) || o.lines.length > 1000 || !o.lines.every((n) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 2_147_483_647)) {
    return 'lines (non-negative integers)';
  }
  return null;
}

// ---- memory (tests) ----------------------------------------------------------------------------------

export interface MemDevice { id: string; restaurant_id: string; status: 'active' | 'revoked' }
interface MemClaim { order_channel: OrderChannel; order_id: string; restaurant_id: string; device_id: string; claimed_at: number; result: PrintResult | null; printed_at: number | null }
interface MemStation { order_channel: OrderChannel; order_id: string; station: string; restaurant_id: string; name: string; lines: number[]; position: number; result: PrintResult | null; printed_at: number | null }
interface MemLog { order_channel: OrderChannel; order_id: string; restaurant_id: string; device_id: string; action_id: string; variant: PrintVariant; result: PrintResult; station: string | null; error: string | null; device_time: string | null; at: number; seq: number }
export interface MemAction {
  action_id: string; fn: ActionFunction; restaurant_id: string; device_id: string; channel: OrderChannel | null; order_id: string | null;
  action: string; request: Record<string, unknown>; outcome: StoredOutcome | null; error_status: number | null; error_code: string | null;
  error_message: string | null; order_ids: string[]; ready_email_sent: boolean; actor: string | null; approver: string | null;
  device_time: string | null; created_at: number; completed_at: number | null;
}
/** The live tables the order actions read / write (tests: FakeSupabase rows). */
// deno-lint-ignore no-explicit-any
export interface MemLiveTables { orders: () => Record<string, any>[]; restaurants: () => Record<string, any>[] }

/** Deep-equal for JSON values (jsonb `=` compares semantically, key order irrelevant). */
function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => jsonEq(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const ACTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const key = (channel: string, orderId: string) => `${channel}:${orderId}`;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export class MemoryOnlineStore implements OnlineStore {
  readonly devices = new Map<string, MemDevice>();
  readonly settings = new Map<string, OnlinePosSettings & { updated_at: number; updated_by: string }>();
  readonly claims = new Map<string, MemClaim>();
  readonly stations: MemStation[] = [];
  readonly log: MemLog[] = [];
  readonly actions = new Map<string, MemAction>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now, private readonly live: MemLiveTables | null = null) {}

  setPrintRegister(restaurantId: string, deviceId: string | null, updatedBy: string): Promise<void> {
    if (updatedBy.length < 1 || updatedBy.length > 200) return Promise.reject(new OnlineStoreError('invalid_input', 'updated_by length 1–200'));
    if (deviceId !== null) {
      const d = this.devices.get(deviceId);
      if (!d || d.restaurant_id !== restaurantId || d.status !== 'active') {
        return Promise.reject(new OnlineStoreError('invalid_print_register', 'print register must be an active register of this restaurant'));
      }
    }
    const cur = this.settings.get(restaurantId) ?? { ...DEFAULT_POS_SETTINGS, updated_at: 0, updated_by: updatedBy };
    this.settings.set(restaurantId, { ...cur, print_register_device_id: deviceId, updated_at: this.now(), updated_by: updatedBy });
    return Promise.resolve();
  }

  /** Test control: the flags directly (pos-v1-online-settings → settingsChange is the real path). */
  setFlags(restaurantId: string, flags: Partial<Omit<OnlinePosSettings, 'print_register_device_id'>>): void {
    const cur = this.settings.get(restaurantId) ?? { ...DEFAULT_POS_SETTINGS, updated_at: this.now(), updated_by: 'test' };
    this.settings.set(restaurantId, { ...cur, ...flags });
  }

  getSettings(restaurantId: string): Promise<OnlinePosSettings | null> {
    const s = this.settings.get(restaurantId);
    if (!s) return Promise.resolve(null);
    const { print_register_device_id, pos_online_orders_enabled, online_auto_print_enabled, kitchenhub_auto_print_enabled } = s;
    return Promise.resolve({ print_register_device_id, pos_online_orders_enabled, online_auto_print_enabled, kitchenhub_auto_print_enabled });
  }

  private activeDevice(deviceId: string, restaurantId: string): boolean {
    const d = this.devices.get(deviceId);
    return !!d && d.restaurant_id === restaurantId && d.status === 'active';
  }

  private stationsOf(channel: OrderChannel, orderId: string): MemStation[] {
    return this.stations.filter((s) => s.order_channel === channel && s.order_id === orderId).sort((a, b) => a.position - b.position);
  }

  claimPrint(c: ClaimInput): Promise<ClaimOutcome> {
    if (c.channel !== 'ordr' && c.channel !== 'kitchenhub') return Promise.reject(new OnlineStoreError('invalid_input', 'order_channel'));
    if (!Array.isArray(c.stations) || c.stations.length > 200 || c.stations.some((s) => stationRefProblem(s) !== null)) {
      return Promise.reject(new OnlineStoreError('invalid_input', 'stations'));
    }
    if (!this.activeDevice(c.deviceId, c.restaurantId)) return Promise.resolve({ outcome: 'device_not_allowed' });
    const s = this.settings.get(c.restaurantId);
    if (!s || s.print_register_device_id !== c.deviceId) return Promise.resolve({ outcome: 'not_designated' });
    if ((c.channel === 'ordr' && !s.online_auto_print_enabled) || (c.channel === 'kitchenhub' && !s.kitchenhub_auto_print_enabled)) {
      return Promise.resolve({ outcome: 'auto_print_off' });
    }
    const k = key(c.channel, c.orderId);
    const cur = this.claims.get(k);
    if (cur) {
      if (cur.restaurant_id !== c.restaurantId) return Promise.resolve({ outcome: 'restaurant_mismatch' });
      return Promise.resolve({ outcome: 'ok', applied: false, claimed: cur.device_id === c.deviceId });
    }
    const existing = this.stationsOf(c.channel, c.orderId);
    if (existing.some((x) => x.restaurant_id !== c.restaurantId)) return Promise.resolve({ outcome: 'restaurant_mismatch' });
    if (orderPrintResult(existing) !== null || c.printStatusPrinted) return Promise.resolve({ outcome: 'ok', applied: false, claimed: false });
    if (new Set(c.stations.map((x) => x.station)).size !== c.stations.length) {
      return Promise.reject(new OnlineStoreError('invalid_input', 'duplicate station (23505)'));
    }
    // applyClaim: the unclaimed order's stations are replaced by the claim's
    for (let i = this.stations.length - 1; i >= 0; i--) {
      if (this.stations[i].order_channel === c.channel && this.stations[i].order_id === c.orderId) this.stations.splice(i, 1);
    }
    const now = this.now();
    this.claims.set(k, { order_channel: c.channel, order_id: c.orderId, restaurant_id: c.restaurantId, device_id: c.deviceId, claimed_at: now, result: null, printed_at: null });
    c.stations.forEach((x, i) => this.stations.push({
      order_channel: c.channel, order_id: c.orderId, station: x.station, restaurant_id: c.restaurantId, name: x.name, lines: [...x.lines], position: i, result: null, printed_at: null,
    }));
    return Promise.resolve({ outcome: 'ok', applied: true, claimed: true });
  }

  recordPrint(r: RecordInput): Promise<RecordOutcome> {
    if ((r.channel !== 'ordr' && r.channel !== 'kitchenhub') || !['auto', 'manual', 'reprint'].includes(r.variant) ||
        !['printed', 'printed_unconfirmed', 'failed'].includes(r.result) || stationRefProblem(r.station) !== null || !r.actionId) {
      return Promise.reject(new OnlineStoreError('invalid_input', 'bad input'));
    }
    if (r.error !== null && r.error.length > 500) return Promise.reject(new OnlineStoreError('invalid_input', 'error > 500 chars'));
    if (!this.activeDevice(r.deviceId, r.restaurantId)) return Promise.resolve({ outcome: 'device_not_allowed' });
    if (this.log.some((l) => l.action_id === r.actionId)) return Promise.resolve({ outcome: 'duplicate' });
    const k = key(r.channel, r.orderId);
    let c = this.claims.get(k);
    if ((c && c.restaurant_id !== r.restaurantId) || this.stationsOf(r.channel, r.orderId).some((x) => x.restaurant_id !== r.restaurantId)) {
      return Promise.resolve({ outcome: 'restaurant_mismatch' });
    }
    const now = this.now();
    this.log.push({
      order_channel: r.channel, order_id: r.orderId, restaurant_id: r.restaurantId, device_id: r.deviceId, action_id: r.actionId, variant: r.variant,
      result: r.result, station: r.station.station, error: r.error, device_time: r.deviceTime, at: now, seq: ++this.seq,
    });
    if (r.variant === 'manual' && !c) {
      c = { order_channel: r.channel, order_id: r.orderId, restaurant_id: r.restaurantId, device_id: r.deviceId, claimed_at: now, result: null, printed_at: null };
      this.claims.set(k, c);
    }
    let st = this.stations.find((x) => x.order_channel === r.channel && x.order_id === r.orderId && x.station === r.station.station);
    if (!st) {
      const existing = this.stationsOf(r.channel, r.orderId);
      st = {
        order_channel: r.channel, order_id: r.orderId, station: r.station.station, restaurant_id: r.restaurantId, name: r.station.name, lines: [...r.station.lines],
        position: existing.length ? Math.max(...existing.map((x) => x.position)) + 1 : 0, result: null, printed_at: null,
      };
      this.stations.push(st);
    }
    if (r.result === 'printed') {
      st.result = 'printed';
      st.printed_at = now;
    } else if (r.variant === 'auto' && c && c.device_id === r.deviceId && st.result !== 'printed') st.result = r.result;
    else if (r.variant !== 'reprint' && st.result === null) st.result = r.result;
    const orderResult = orderPrintResult(this.stationsOf(r.channel, r.orderId));
    if (c) {
      c.result = orderResult;
      if (orderResult === 'printed') c.printed_at = now;
    }
    return Promise.resolve({ outcome: 'recorded', order_result: orderResult, claimed_by: c ? c.device_id : null });
  }

  printState(restaurantId: string, orderIds: string[]): Promise<PrintState> {
    const ids = new Set(orderIds);
    const claims = [...this.claims.values()].filter((c) => c.restaurant_id === restaurantId && ids.has(c.order_id))
      .sort((a, b) => a.order_channel.localeCompare(b.order_channel) || a.order_id.localeCompare(b.order_id))
      .map((c) => ({ order_channel: c.order_channel, order_id: c.order_id, device_id: c.device_id, claimed_at: iso(c.claimed_at)!, result: c.result, printed_at: iso(c.printed_at) }));
    const stations = this.stations.filter((s) => s.restaurant_id === restaurantId && ids.has(s.order_id))
      .sort((a, b) => a.order_channel.localeCompare(b.order_channel) || a.order_id.localeCompare(b.order_id) || a.position - b.position || a.station.localeCompare(b.station))
      .map((s) => ({ order_channel: s.order_channel, order_id: s.order_id, station: s.station, name: s.name, lines: [...s.lines], position: s.position, result: s.result, printed_at: iso(s.printed_at) }));
    const log = this.log.filter((l) => l.restaurant_id === restaurantId && ids.has(l.order_id))
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .map((l) => ({ order_channel: l.order_channel, order_id: l.order_id, at: iso(l.at)!, device_id: l.device_id, variant: l.variant, result: l.result, error: l.error, station: l.station }));
    return Promise.resolve(structuredClone({ claims, stations, log }));
  }

  private stored(cur: MemAction): StoredAction {
    return { stored: cur.outcome!, error_status: cur.error_status, error_code: cur.error_code, error_message: cur.error_message, order_ids: [...cur.order_ids] };
  }

  private newAction(a: Omit<MemAction, 'created_at' | 'completed_at' | 'error_status' | 'error_code' | 'error_message'>): MemAction {
    const now = this.now();
    const row: MemAction = { ...a, request: structuredClone(a.request), error_status: null, error_code: null, error_message: null, created_at: now, completed_at: a.outcome === null ? null : now };
    this.actions.set(a.action_id, row);
    return row;
  }

  beginAction(a: ActionBegin): Promise<ActionBeginOutcome> {
    if (!ACTION_NAME.test(a.action)) return Promise.reject(new OnlineStoreError('invalid_input', 'action name'));
    const cur = this.actions.get(a.actionId);
    if (!cur) {
      this.newAction({
        action_id: a.actionId, fn: a.fn, restaurant_id: a.restaurantId, device_id: a.deviceId, channel: a.channel, order_id: a.orderId, action: a.action,
        request: a.request, outcome: null, order_ids: [], ready_email_sent: false, actor: a.actor, approver: a.approver, device_time: a.deviceTime,
      });
      return Promise.resolve({ outcome: 'started' });
    }
    if (cur.fn !== a.fn || cur.restaurant_id !== a.restaurantId || cur.device_id !== a.deviceId || cur.channel !== a.channel || cur.order_id !== a.orderId ||
        cur.action !== a.action || !jsonEq(cur.request, a.request)) {
      return Promise.resolve({ outcome: 'action_id_reused' });
    }
    if (cur.outcome === null) return Promise.resolve({ outcome: 'pending' });
    return Promise.resolve({ outcome: 'duplicate', ...this.stored(cur) });
  }

  completeAction(actionId: string, deviceId: string, outcome: 'applied' | 'noop'): Promise<ActionCompleteOutcome> {
    const cur = this.actions.get(actionId);
    if (!cur) return Promise.resolve({ outcome: 'not_found' });
    if (cur.device_id !== deviceId) return Promise.resolve({ outcome: 'device_mismatch' });
    if (cur.outcome !== null) return Promise.resolve({ outcome: 'already_completed', stored: cur.outcome });
    cur.outcome = outcome;
    cur.completed_at = this.now();
    return Promise.resolve({ outcome: 'completed' });
  }

  /** 111 pos_online_order_action, mirrored (actionRules.ts = its rule). */
  orderAction(a: OrderActionInput): Promise<OrderActionOutcome> {
    if (!this.live) return Promise.reject(new Error('MemoryOnlineStore: no live tables bound (orders)'));
    if ((a.orderId === null) !== (a.action === 'complete_all_in_progress')) return Promise.reject(new OnlineStoreError('invalid_input', 'order_id'));
    if (a.action !== 'ack' && a.action !== 'stuck_ack' && a.action !== 'complete_all_in_progress' && a.expectedStatus === null) return Promise.reject(new OnlineStoreError('invalid_input', 'expected_status'));
    if (!this.activeDevice(a.deviceId, a.restaurantId)) return Promise.resolve({ outcome: 'device_not_allowed' });
    const cur = this.actions.get(a.actionId);
    if (cur) {
      if (cur.fn !== 'order_action' || cur.restaurant_id !== a.restaurantId || cur.device_id !== a.deviceId || cur.order_id !== a.orderId ||
          cur.action !== a.action || !jsonEq(cur.request, a.request)) {
        return Promise.resolve({ outcome: 'action_id_reused' });
      }
      return Promise.resolve({ outcome: 'duplicate', ...this.stored(cur) });
    }
    const nowMs = this.now();
    let out: 'applied' | 'noop';
    let ids: string[] = [];
    let email = false;
    if (a.action === 'complete_all_in_progress') {
      const rows = this.live.orders().filter((o) => o.restaurant_id === a.restaurantId && o.status === 'in_progress');
      for (const o of rows) o.status = 'complete';
      ids = rows.map((o) => String(o.id)).sort();
      out = ids.length ? 'applied' : 'noop';
    } else {
      const o = this.live.orders().find((x) => x.id === a.orderId);
      if (!o || o.items_written_at == null) return Promise.resolve({ outcome: 'unknown_order' });
      if (o.restaurant_id !== a.restaurantId) return Promise.resolve({ outcome: 'restaurant_mismatch' });
      const est = this.live.restaurants().find((x) => x.id === a.restaurantId)?.estimated_pickup_minutes ?? null;
      const r = ordrActionRule(o, { action: a.action, expected_status: a.expectedStatus, quoted_ready_minutes: a.quotedReadyMinutes }, nowMs, est);
      if (r.kind === 'status_conflict') return Promise.resolve({ outcome: 'status_conflict', status: r.status });
      if (r.kind === 'not_allowed' || r.kind === 'invalid') return Promise.resolve({ outcome: r.kind, message: r.message });
      if (r.kind === 'applied') {
        Object.assign(o, structuredClone(r.set));
        out = 'applied';
        email = r.readyEmail && ![...this.actions.values()].some((x) => x.order_id === a.orderId && x.ready_email_sent);
      } else out = 'noop';
    }
    this.newAction({
      action_id: a.actionId, fn: 'order_action', restaurant_id: a.restaurantId, device_id: a.deviceId, channel: a.orderId === null ? null : 'ordr',
      order_id: a.orderId, action: a.action, request: a.request, outcome: out, order_ids: ids, ready_email_sent: email, actor: a.actor,
      approver: a.approver, device_time: a.deviceTime,
    });
    return Promise.resolve({ outcome: out, ready_email: email, order_ids: ids });
  }

  /** 111 pos_online_settings_change, mirrored. */
  settingsChange(c: SettingsChangeInput): Promise<SettingsChangeOutcome> {
    if (!['online_print_device', 'online_auto_print', 'kitchenhub_auto_print'].includes(c.kind)) return Promise.reject(new OnlineStoreError('invalid_input', 'kind'));
    if (c.kind !== 'online_print_device' && typeof c.on !== 'boolean') return Promise.reject(new OnlineStoreError('invalid_input', 'on'));
    if (!this.activeDevice(c.deviceId, c.restaurantId)) return Promise.resolve({ outcome: 'device_not_allowed' });
    const cur = this.actions.get(c.actionId);
    if (cur) {
      if (cur.fn !== 'settings' || cur.restaurant_id !== c.restaurantId || cur.device_id !== c.deviceId || cur.action !== c.kind || !jsonEq(cur.request, c.request)) {
        return Promise.resolve({ outcome: 'action_id_reused' });
      }
      return Promise.resolve({ outcome: 'duplicate', stored: cur.outcome! });
    }
    const s = this.settings.get(c.restaurantId) ?? null;
    const by = c.actor ?? 'register';
    let out: 'applied' | 'noop';
    if (c.kind === 'online_print_device') {
      if (c.printDeviceId !== null && !this.activeDevice(c.printDeviceId, c.restaurantId)) return Promise.resolve({ outcome: 'invalid_print_register' });
      out = (s ? s.print_register_device_id === c.printDeviceId : c.printDeviceId === null) ? 'noop' : 'applied';
      if (out === 'applied') this.settings.set(c.restaurantId, { ...(s ?? DEFAULT_POS_SETTINGS), print_register_device_id: c.printDeviceId, updated_at: this.now(), updated_by: by });
    } else {
      const col = c.kind === 'online_auto_print' ? 'online_auto_print_enabled' : 'kitchenhub_auto_print_enabled';
      out = (s?.[col] ?? false) === c.on ? 'noop' : 'applied';
      if (out === 'applied') this.settings.set(c.restaurantId, { ...(s ?? DEFAULT_POS_SETTINGS), [col]: c.on, updated_at: this.now(), updated_by: by });
    }
    this.newAction({
      action_id: c.actionId, fn: 'settings', restaurant_id: c.restaurantId, device_id: c.deviceId, channel: null, order_id: null, action: c.kind,
      request: c.request, outcome: out, order_ids: [], ready_email_sent: false, actor: c.actor, approver: c.approver, device_time: c.deviceTime,
    });
    return Promise.resolve({ outcome: out });
  }
}

// ---- Postgres (service role) -------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Client = { rpc(fn: string, args: Record<string, unknown>): any; from(table: string): any };

/** Timestamps from jsonb (`2026-11-24T14:00:00.123456+00:00`) → ISO ms (`…T14:00:00.123Z`). */
function isoOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export class PgOnlineStore implements OnlineStore {
  constructor(private readonly db: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (fn === 'pos_set_print_register' && error.code === '23514') throw new OnlineStoreError('invalid_print_register', error.message);
      if (['22023', '23505', '22P02', '23514'].includes(error.code)) throw new OnlineStoreError('invalid_input', `${fn}: ${error.message}`);
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return data as T;
  }

  async setPrintRegister(restaurantId: string, deviceId: string | null, updatedBy: string) {
    await this.call('pos_set_print_register', { p_restaurant_id: restaurantId, p_device_id: deviceId, p_updated_by: updatedBy });
  }
  async getSettings(restaurantId: string): Promise<OnlinePosSettings | null> {
    const { data, error } = await this.db
      .from('pos_restaurant_settings')
      .select('print_register_device_id, pos_online_orders_enabled, online_auto_print_enabled, kitchenhub_auto_print_enabled')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error) throw new Error(`pos_restaurant_settings read failed: ${error.message}`);
    return data ?? null;
  }
  claimPrint(c: ClaimInput) {
    return this.call<ClaimOutcome>('pos_claim_online_print', {
      p_restaurant_id: c.restaurantId, p_order_channel: c.channel, p_order_id: c.orderId, p_device_id: c.deviceId,
      p_stations: c.stations.map((s) => ({ station: s.station, name: s.name, lines: s.lines })), p_print_status_printed: c.printStatusPrinted,
    });
  }
  recordPrint(r: RecordInput) {
    return this.call<RecordOutcome>('pos_record_online_print', {
      p_restaurant_id: r.restaurantId, p_order_channel: r.channel, p_order_id: r.orderId, p_device_id: r.deviceId, p_action_id: r.actionId,
      p_variant: r.variant, p_result: r.result, p_station: { station: r.station.station, name: r.station.name, lines: r.station.lines },
      p_error: r.error, p_device_time: r.deviceTime,
    });
  }
  async printState(restaurantId: string, orderIds: string[]): Promise<PrintState> {
    if (orderIds.length === 0) return { claims: [], stations: [], log: [] };
    const raw = await this.call<{ claims: ClaimRow[]; stations: StationRow[]; log: LogRow[] }>('pos_online_print_state', { p_restaurant_id: restaurantId, p_order_ids: orderIds });
    return {
      claims: (raw?.claims ?? []).map((c) => ({ ...c, claimed_at: isoOf(c.claimed_at)!, printed_at: isoOf(c.printed_at) })),
      stations: (raw?.stations ?? []).map((s) => ({ ...s, printed_at: isoOf(s.printed_at) })),
      log: (raw?.log ?? []).map((l) => ({ ...l, at: isoOf(l.at)! })),
    };
  }
  async beginAction(a: ActionBegin): Promise<ActionBeginOutcome> {
    const r = await this.call<Record<string, unknown>>('pos_online_action_begin', {
      p_action_id: a.actionId, p_function: a.fn, p_restaurant_id: a.restaurantId, p_device_id: a.deviceId, p_order_channel: a.channel,
      p_order_id: a.orderId, p_action: a.action, p_request: a.request, p_actor: a.actor, p_approver: a.approver, p_device_time: a.deviceTime,
    });
    return r.outcome === 'duplicate' ? { outcome: 'duplicate', ...storedOf(r) } : (r as ActionBeginOutcome);
  }
  completeAction(actionId: string, deviceId: string, outcome: 'applied' | 'noop') {
    return this.call<ActionCompleteOutcome>('pos_online_action_complete', { p_action_id: actionId, p_device_id: deviceId, p_outcome: outcome });
  }
  async orderAction(a: OrderActionInput): Promise<OrderActionOutcome> {
    const r = await this.call<Record<string, unknown>>('pos_online_order_action', {
      p_action_id: a.actionId, p_restaurant_id: a.restaurantId, p_device_id: a.deviceId, p_order_id: a.orderId, p_action: a.action,
      p_expected_status: a.expectedStatus, p_quoted_ready_minutes: a.quotedReadyMinutes, p_request: a.request, p_actor: a.actor,
      p_approver: a.approver, p_device_time: a.deviceTime,
    });
    if (r.outcome === 'duplicate') return { outcome: 'duplicate', ...storedOf(r) };
    if (r.outcome === 'applied' || r.outcome === 'noop') return { outcome: r.outcome, ready_email: r.ready_email === true, order_ids: idsOf(r.order_ids) };
    return r as OrderActionOutcome;
  }
  settingsChange(c: SettingsChangeInput) {
    return this.call<SettingsChangeOutcome>('pos_online_settings_change', {
      p_action_id: c.actionId, p_restaurant_id: c.restaurantId, p_device_id: c.deviceId, p_kind: c.kind, p_print_device_id: c.printDeviceId,
      p_on: c.on, p_request: c.request, p_actor: c.actor, p_approver: c.approver, p_device_time: c.deviceTime,
    });
  }
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
function storedOf(r: Record<string, unknown>): StoredAction {
  return {
    stored: r.stored as StoredOutcome,
    error_status: typeof r.error_status === 'number' ? r.error_status : null,
    error_code: typeof r.error_code === 'string' ? r.error_code : null,
    error_message: typeof r.error_message === 'string' ? r.error_message : null,
    order_ids: idsOf(r.order_ids),
  };
}
