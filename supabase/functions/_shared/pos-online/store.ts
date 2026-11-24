/**
 * Migration 109 persistence: print register, exactly-once print claims, device actions. Every call is ONE
 * plpgsql function (one transaction). MemoryOnlineStore mirrors the SQL for tests — keep the two in step
 * (109_smoke.sql runs the same scenarios against Postgres).
 *
 * The order is NOT checked here (109 never touches orders): the caller first confirms the order belongs to
 * the principal's restaurant (and, for an auto-print claim, that items_written_at is set).
 */

export const PRINT_LEASE_MS = 60_000;
export const MAX_AUTO_PRINT_ATTEMPTS = 3;

export type ClaimOutcome =
  | { outcome: 'claimed'; attempt: number; lease_expires_at: string; takeover: boolean }
  | { outcome: 'held'; device_id: string; lease_expires_at: string }
  | { outcome: 'already_printed'; device_id: string; attempt: number }
  | { outcome: 'attempts_exhausted'; attempt: number }
  | { outcome: 'not_print_register'; print_register_device_id: string | null }
  | { outcome: 'device_not_allowed' }
  | { outcome: 'restaurant_mismatch' };

export type FinishOutcome =
  | { outcome: 'recorded' | 'duplicate'; result: 'printed' | 'failed'; attempt: number }
  | { outcome: 'lease_lost'; device_id: string; attempt: number; result: 'claimed' | 'printed' | 'failed' }
  | { outcome: 'not_claimed' }
  | { outcome: 'restaurant_mismatch' };

export type ActionBeginOutcome =
  | { outcome: 'started' | 'pending' | 'action_id_reused' }
  | { outcome: 'duplicate'; result: Record<string, unknown>; http_status: number };

export type ActionCompleteOutcome =
  | { outcome: 'completed' | 'not_found' | 'device_mismatch' }
  | { outcome: 'already_completed'; result: Record<string, unknown>; http_status: number };

export interface ActionBegin {
  actionId: string;
  restaurantId: string;
  deviceId: string;
  staffId: string | null;
  orderId: string;
  action: string;
  request: Record<string, unknown>;
}

export interface OnlineStore {
  setPrintRegister(restaurantId: string, deviceId: string | null, updatedBy: string): Promise<void>;
  claimPrint(restaurantId: string, orderId: string, deviceId: string): Promise<ClaimOutcome>;
  finishPrint(restaurantId: string, orderId: string, deviceId: string, attempt: number, result: 'printed' | 'failed', detail?: Record<string, unknown>): Promise<FinishOutcome>;
  beginAction(a: ActionBegin): Promise<ActionBeginOutcome>;
  completeAction(actionId: string, deviceId: string, result: Record<string, unknown>, httpStatus: number): Promise<ActionCompleteOutcome>;
}

export class OnlineStoreError extends Error {
  readonly code: 'invalid_print_register' | 'invalid_input';
  constructor(code: OnlineStoreError['code'], message: string) {
    super(message);
    this.name = 'OnlineStoreError';
    this.code = code;
  }
}

// ---- memory (tests) ----------------------------------------------------------------------------------

export interface MemDevice { id: string; restaurant_id: string; status: 'active' | 'revoked' }
export interface MemClaim { order_id: string; restaurant_id: string; device_id: string; result: 'claimed' | 'printed' | 'failed'; attempt: number; claimed_at: number; finished_at: number | null }
export interface MemLog { order_id: string; restaurant_id: string; device_id: string; result: 'claimed' | 'printed' | 'failed'; attempt: number; at: number; detail: Record<string, unknown> }
export interface MemAction extends Omit<ActionBegin, 'actionId'> { action_id: string; result: Record<string, unknown> | null; http_status: number | null; created_at: number; completed_at: number | null }

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

export class MemoryOnlineStore implements OnlineStore {
  readonly devices = new Map<string, MemDevice>();
  readonly settings = new Map<string, { print_register_device_id: string | null; updated_at: number; updated_by: string }>();
  readonly claims = new Map<string, MemClaim>();
  readonly log: MemLog[] = [];
  readonly actions = new Map<string, MemAction>();

  constructor(private readonly now: () => number = Date.now) {}

  setPrintRegister(restaurantId: string, deviceId: string | null, updatedBy: string): Promise<void> {
    if (updatedBy.length < 1 || updatedBy.length > 200) return Promise.reject(new OnlineStoreError('invalid_input', 'updated_by length 1–200'));
    if (deviceId !== null) {
      const d = this.devices.get(deviceId);
      if (!d || d.restaurant_id !== restaurantId || d.status !== 'active') {
        return Promise.reject(new OnlineStoreError('invalid_print_register', 'print register must be an active register of this restaurant'));
      }
    }
    this.settings.set(restaurantId, { print_register_device_id: deviceId, updated_at: this.now(), updated_by: updatedBy });
    return Promise.resolve();
  }

  private addLog(c: Omit<MemLog, 'at'> & { at?: number }) {
    this.log.push({ ...c, at: c.at ?? this.now(), detail: structuredClone(c.detail) });
  }

  claimPrint(restaurantId: string, orderId: string, deviceId: string): Promise<ClaimOutcome> {
    const now = this.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const d = this.devices.get(deviceId);
    if (!d || d.restaurant_id !== restaurantId || d.status !== 'active') return Promise.resolve({ outcome: 'device_not_allowed' });
    const register = this.settings.get(restaurantId)?.print_register_device_id ?? null;
    if (register === null || register !== deviceId) return Promise.resolve({ outcome: 'not_print_register', print_register_device_id: register });

    const c = this.claims.get(orderId);
    if (!c) {
      this.claims.set(orderId, { order_id: orderId, restaurant_id: restaurantId, device_id: deviceId, result: 'claimed', attempt: 1, claimed_at: now, finished_at: null });
      this.addLog({ order_id: orderId, restaurant_id: restaurantId, device_id: deviceId, result: 'claimed', attempt: 1, at: now, detail: {} });
      return Promise.resolve({ outcome: 'claimed', attempt: 1, lease_expires_at: iso(now + PRINT_LEASE_MS), takeover: false });
    }
    if (c.restaurant_id !== restaurantId) return Promise.resolve({ outcome: 'restaurant_mismatch' });
    if (c.result === 'printed') return Promise.resolve({ outcome: 'already_printed', device_id: c.device_id, attempt: c.attempt });
    if (c.result === 'claimed' && c.claimed_at + PRINT_LEASE_MS > now) {
      return Promise.resolve(c.device_id === deviceId
        ? { outcome: 'claimed', attempt: c.attempt, lease_expires_at: iso(c.claimed_at + PRINT_LEASE_MS), takeover: false }
        : { outcome: 'held', device_id: c.device_id, lease_expires_at: iso(c.claimed_at + PRINT_LEASE_MS) });
    }
    if (c.attempt >= MAX_AUTO_PRINT_ATTEMPTS) return Promise.resolve({ outcome: 'attempts_exhausted', attempt: c.attempt });

    const takeover = c.result === 'claimed';
    const prev = { device_id: c.device_id, result: c.result };
    Object.assign(c, { device_id: deviceId, result: 'claimed', attempt: c.attempt + 1, claimed_at: now, finished_at: null });
    this.addLog({ order_id: orderId, restaurant_id: restaurantId, device_id: deviceId, result: 'claimed', attempt: c.attempt, at: now,
      detail: { takeover, previous_device_id: prev.device_id, previous_result: prev.result } });
    return Promise.resolve({ outcome: 'claimed', attempt: c.attempt, lease_expires_at: iso(now + PRINT_LEASE_MS), takeover });
  }

  finishPrint(restaurantId: string, orderId: string, deviceId: string, attempt: number, result: 'printed' | 'failed', detail: Record<string, unknown> = {}): Promise<FinishOutcome> {
    if (result !== 'printed' && result !== 'failed') return Promise.reject(new OnlineStoreError('invalid_input', 'result must be printed or failed'));
    const now = this.now();
    const c = this.claims.get(orderId);
    if (!c) return Promise.resolve({ outcome: 'not_claimed' });
    if (c.restaurant_id !== restaurantId) return Promise.resolve({ outcome: 'restaurant_mismatch' });
    if (c.device_id === deviceId && c.attempt === attempt && c.result === result) return Promise.resolve({ outcome: 'duplicate', result, attempt });
    if (c.device_id === deviceId && c.attempt === attempt && c.result === 'claimed') {
      c.result = result;
      c.finished_at = now;
      this.addLog({ order_id: orderId, restaurant_id: restaurantId, device_id: deviceId, result, attempt, at: now, detail });
      return Promise.resolve({ outcome: 'recorded', result, attempt });
    }
    this.addLog({ order_id: orderId, restaurant_id: restaurantId, device_id: deviceId, result, attempt: Math.max(1, Math.min(attempt || 1, 100)), at: now,
      detail: { ...detail, lease_lost: true } });
    return Promise.resolve({ outcome: 'lease_lost', device_id: c.device_id, attempt: c.attempt, result: c.result });
  }

  beginAction(a: ActionBegin): Promise<ActionBeginOutcome> {
    if (!ACTION_NAME.test(a.action)) return Promise.reject(new OnlineStoreError('invalid_input', 'action name'));
    const cur = this.actions.get(a.actionId);
    if (!cur) {
      this.actions.set(a.actionId, {
        action_id: a.actionId, restaurantId: a.restaurantId, deviceId: a.deviceId, staffId: a.staffId, orderId: a.orderId, action: a.action,
        request: structuredClone(a.request), result: null, http_status: null, created_at: this.now(), completed_at: null,
      });
      return Promise.resolve({ outcome: 'started' });
    }
    if (cur.restaurantId !== a.restaurantId || cur.deviceId !== a.deviceId || cur.staffId !== a.staffId || cur.orderId !== a.orderId ||
        cur.action !== a.action || !jsonEq(cur.request, a.request)) {
      return Promise.resolve({ outcome: 'action_id_reused' });
    }
    if (cur.result === null) return Promise.resolve({ outcome: 'pending' });
    return Promise.resolve({ outcome: 'duplicate', result: structuredClone(cur.result), http_status: cur.http_status! });
  }

  completeAction(actionId: string, deviceId: string, result: Record<string, unknown>, httpStatus: number): Promise<ActionCompleteOutcome> {
    const cur = this.actions.get(actionId);
    if (!cur) return Promise.resolve({ outcome: 'not_found' });
    if (cur.deviceId !== deviceId) return Promise.resolve({ outcome: 'device_mismatch' });
    if (cur.result !== null) return Promise.resolve({ outcome: 'already_completed', result: structuredClone(cur.result), http_status: cur.http_status! });
    cur.result = structuredClone(result);
    cur.http_status = httpStatus;
    cur.completed_at = this.now();
    return Promise.resolve({ outcome: 'completed' });
  }
}

// ---- Postgres (service role) -------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Client = { rpc(fn: string, args: Record<string, unknown>): any };

export class PgOnlineStore implements OnlineStore {
  constructor(private readonly db: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (fn === 'pos_set_print_register' && error.code === '23514') throw new OnlineStoreError('invalid_print_register', error.message);
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return data as T;
  }

  async setPrintRegister(restaurantId: string, deviceId: string | null, updatedBy: string) {
    await this.call('pos_set_print_register', { p_restaurant_id: restaurantId, p_device_id: deviceId, p_updated_by: updatedBy });
  }
  claimPrint(restaurantId: string, orderId: string, deviceId: string) {
    return this.call<ClaimOutcome>('pos_claim_online_print', { p_restaurant_id: restaurantId, p_order_id: orderId, p_device_id: deviceId });
  }
  finishPrint(restaurantId: string, orderId: string, deviceId: string, attempt: number, result: 'printed' | 'failed', detail: Record<string, unknown> = {}) {
    return this.call<FinishOutcome>('pos_finish_online_print', {
      p_restaurant_id: restaurantId, p_order_id: orderId, p_device_id: deviceId, p_attempt: attempt, p_result: result, p_detail: detail,
    });
  }
  beginAction(a: ActionBegin) {
    return this.call<ActionBeginOutcome>('pos_online_action_begin', {
      p_action_id: a.actionId, p_restaurant_id: a.restaurantId, p_device_id: a.deviceId, p_staff_id: a.staffId, p_order_id: a.orderId,
      p_action: a.action, p_request: a.request,
    });
  }
  completeAction(actionId: string, deviceId: string, result: Record<string, unknown>, httpStatus: number) {
    return this.call<ActionCompleteOutcome>('pos_online_action_complete', { p_action_id: actionId, p_device_id: deviceId, p_result: result, p_http_status: httpStatus });
  }
}
