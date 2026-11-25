/**
 * End-of-day persistence (migration 106). Each apply is ONE plpgsql call (pos_apply_shift,
 * pos_apply_refund, pos_apply_day_close): lock, idempotency (type, id, version), the entity's rules
 * again, the writes, the idempotency row — one transaction. MemoryEodStore mirrors them for tests and
 * reads payments from the MemoryOrderStore (payments are written by submit-order).
 */
import type { MemoryOrderStore } from '../pos-sync/orderStore.ts';
import type { DayClosePayload, EntityType, RefundPayload, ShiftPayload } from './payloads.ts';
import type { DayCloseCovered } from './rules.ts';

export interface EntityResponse {
  result: 'applied' | 'duplicate' | 'stale_ignored';
  id: string;
  version: number;
  server_version: number;
  flags: Record<string, boolean>;
  server_time: string;
}

export interface StoredShift {
  shift_id: string;
  restaurant_id: string;
  device_id: string;
  version: number;
  status: 'open' | 'closed';
  flags: Record<string, boolean>;
  payload: ShiftPayload;
}

export interface PaymentFacts { method: string; amount_cents: number; order_id: string; status: string }

export type EodOutcome =
  | { outcome: 'applied'; response: EntityResponse }
  | { outcome: 'duplicate'; response: EntityResponse }
  | { outcome: 'idempotency_key_reuse' }
  | { outcome: 'stale_ignored'; server_version: number; flags: Record<string, boolean> }
  | { outcome: 'shift_closed' }
  | { outcome: 'unknown_payment' }
  | { outcome: 'day_close_sequence_taken' }
  | { outcome: 'restaurant_mismatch' }
  | { outcome: 'invalid_payload'; message: string; field: string | null };

export interface ApplyEntity<P> {
  payload: P;
  /** The principal's device. */
  deviceId: string;
  restaurantId: string;
  response: EntityResponse;
  receivedAt: string;
}

export interface EodStore {
  submission(type: EntityType, id: string, version: number): Promise<{ content_hash: string; response: EntityResponse } | null>;
  shift(id: string): Promise<StoredShift | null>;
  movements(ids: readonly string[]): Promise<Map<string, { shift_id: string; kind: string; amount_cents: number }>>;
  refundRestaurant(id: string): Promise<string | null>;
  dayCloseRestaurant(id: string): Promise<string | null>;
  /** Payments of THIS restaurant by id. */
  payments(restaurantId: string, ids: readonly string[]): Promise<Map<string, PaymentFacts>>;
  /** Refunds of THIS restaurant by id. */
  refunds(restaurantId: string, ids: readonly string[]): Promise<Map<string, { method: string; amount_cents: number }>>;
  /** Amounts of every stored refund of a payment. */
  refundAmountsOfPayment(paymentId: string): Promise<number[]>;
  /** The Zs a register made for a business day. */
  zs(deviceId: string, businessDate: string): Promise<{ sequence: number; covered: DayCloseCovered }[]>;
  /** Closed shifts of the restaurant still flagged drawer_unverified. */
  unverifiedShifts(restaurantId: string): Promise<StoredShift[]>;
  setDrawerFlags(shiftId: string, flags: { drawer_mismatch: boolean; drawer_unverified: boolean }): Promise<void>;
  applyShift(i: ApplyEntity<ShiftPayload>): Promise<EodOutcome>;
  applyRefund(i: ApplyEntity<RefundPayload>): Promise<EodOutcome>;
  applyDayClose(i: ApplyEntity<DayClosePayload>): Promise<EodOutcome>;
}

// ---- memory (tests) ------------------------------------------------------------------------------

export class MemoryEodStore implements EodStore {
  readonly shifts = new Map<string, StoredShift>();
  readonly movementRows = new Map<string, { shift_id: string; kind: string; amount_cents: number }>();
  readonly movementInserts = new Map<string, number>();
  readonly refundRows = new Map<string, RefundPayload & { restaurant_id: string; flags: Record<string, boolean> }>();
  readonly dayCloses = new Map<string, DayClosePayload & { restaurant_id: string; flags: Record<string, boolean> }>();
  readonly submissions = new Map<string, { content_hash: string; response: EntityResponse }>();
  /** Every entity request that reached an apply, in order (reference: entityRequests). */
  readonly applied: { type: EntityType; id: string; version: number }[] = [];

  constructor(private readonly orders: MemoryOrderStore) {}

  private key = (t: EntityType, id: string, v: number) => `${t}:${id}:${v}`;
  private idem(t: EntityType, id: string, v: number, hash: string): EodOutcome | null {
    const s = this.submissions.get(this.key(t, id, v));
    if (!s) return null;
    return s.content_hash === hash ? { outcome: 'duplicate', response: structuredClone(s.response) } : { outcome: 'idempotency_key_reuse' };
  }
  private store(t: EntityType, id: string, v: number, hash: string, response: EntityResponse): EodOutcome {
    this.submissions.set(this.key(t, id, v), { content_hash: hash, response: structuredClone(response) });
    this.applied.push({ type: t, id, version: v });
    return { outcome: 'applied', response: structuredClone(response) };
  }

  submission(type: EntityType, id: string, version: number) {
    const s = this.submissions.get(this.key(type, id, version));
    return Promise.resolve(s ? structuredClone(s) : null);
  }
  shift(id: string) { return Promise.resolve(structuredClone(this.shifts.get(id) ?? null)); }
  movements(ids: readonly string[]) {
    return Promise.resolve(new Map(ids.filter((i) => this.movementRows.has(i)).map((i) => [i, { ...this.movementRows.get(i)! }])));
  }
  refundRestaurant(id: string) { return Promise.resolve(this.refundRows.get(id)?.restaurant_id ?? null); }
  dayCloseRestaurant(id: string) { return Promise.resolve(this.dayCloses.get(id)?.restaurant_id ?? null); }
  payments(restaurantId: string, ids: readonly string[]) {
    const out = new Map<string, PaymentFacts>();
    for (const id of ids) {
      const p = this.orders.payments.get(id);
      if (p && this.orders.orders.get(p.order_id)?.restaurant_id === restaurantId) out.set(id, { method: p.method, amount_cents: p.amount_cents, order_id: p.order_id, status: p.status });
    }
    return Promise.resolve(out);
  }
  refunds(restaurantId: string, ids: readonly string[]) {
    const out = new Map<string, { method: string; amount_cents: number }>();
    for (const id of ids) {
      const r = this.refundRows.get(id);
      if (r && r.restaurant_id === restaurantId) out.set(id, { method: r.method, amount_cents: r.amount_cents });
    }
    return Promise.resolve(out);
  }
  refundAmountsOfPayment(paymentId: string) {
    return Promise.resolve([...this.refundRows.values()].filter((r) => r.payment_id === paymentId).map((r) => r.amount_cents));
  }
  zs(deviceId: string, businessDate: string) {
    return Promise.resolve([...this.dayCloses.values()].filter((z) => z.device_id === deviceId && z.business_date === businessDate).map((z) => ({ sequence: z.sequence, covered: structuredClone(z.covered) })));
  }
  unverifiedShifts(restaurantId: string) {
    return Promise.resolve([...this.shifts.values()].filter((s) => s.restaurant_id === restaurantId && s.status === 'closed' && s.flags.drawer_unverified).map((s) => structuredClone(s)));
  }
  setDrawerFlags(shiftId: string, flags: { drawer_mismatch: boolean; drawer_unverified: boolean }) {
    const s = this.shifts.get(shiftId);
    if (s) Object.assign(s.flags, flags);
    return Promise.resolve();
  }

  applyShift(i: ApplyEntity<ShiftPayload>): Promise<EodOutcome> {
    const p = i.payload;
    const dup = this.idem('shift', p.shift_id, p.version, p.content_hash);
    if (dup) return Promise.resolve(dup);
    const cur = this.shifts.get(p.shift_id);
    if (cur && cur.restaurant_id !== i.restaurantId) return Promise.resolve({ outcome: 'restaurant_mismatch' });
    if (cur && p.version <= cur.version) return Promise.resolve({ outcome: 'stale_ignored', server_version: cur.version, flags: structuredClone(cur.flags) });
    if (cur && cur.status === 'closed') return Promise.resolve({ outcome: 'shift_closed' });
    for (const m of p.movements) {
      const prev = this.movementRows.get(m.id);
      if (prev && (prev.shift_id !== p.shift_id || prev.amount_cents !== m.amount_cents || prev.kind !== m.kind)) {
        return Promise.resolve({ outcome: 'invalid_payload', message: `movement ${m.id} changed`, field: 'movements' });
      }
    }
    for (const m of p.movements) {
      if (!this.movementRows.has(m.id)) {
        this.movementRows.set(m.id, { shift_id: p.shift_id, kind: m.kind, amount_cents: m.amount_cents });
        this.movementInserts.set(m.id, (this.movementInserts.get(m.id) ?? 0) + 1);
      }
    }
    this.shifts.set(p.shift_id, { shift_id: p.shift_id, restaurant_id: i.restaurantId, device_id: i.deviceId, version: p.version, status: p.status, flags: structuredClone(i.response.flags), payload: structuredClone(p) });
    return Promise.resolve(this.store('shift', p.shift_id, p.version, p.content_hash, i.response));
  }

  applyRefund(i: ApplyEntity<RefundPayload>): Promise<EodOutcome> {
    const p = i.payload;
    const dup = this.idem('refund', p.refund_id, 1, p.content_hash);
    if (dup) return Promise.resolve(dup);
    if (this.refundRows.has(p.refund_id)) return Promise.resolve({ outcome: 'idempotency_key_reuse' });
    const pay = this.orders.payments.get(p.payment_id);
    if (!pay || pay.order_id !== p.order_id || this.orders.orders.get(pay.order_id)?.restaurant_id !== i.restaurantId) return Promise.resolve({ outcome: 'unknown_payment' });
    if (pay.method !== p.method) return Promise.resolve({ outcome: 'invalid_payload', message: 'refund method must equal the payment method', field: 'method' });
    if (!(p.amount_cents > 0)) return Promise.resolve({ outcome: 'invalid_payload', message: 'amount must be > 0', field: 'amount_cents' });
    this.refundRows.set(p.refund_id, { ...structuredClone(p), restaurant_id: i.restaurantId, flags: structuredClone(i.response.flags) });
    return Promise.resolve(this.store('refund', p.refund_id, 1, p.content_hash, i.response));
  }

  applyDayClose(i: ApplyEntity<DayClosePayload>): Promise<EodOutcome> {
    const p = i.payload;
    const dup = this.idem('day_close', p.day_close_id, 1, p.content_hash);
    if (dup) return Promise.resolve(dup);
    if (this.dayCloses.has(p.day_close_id)) return Promise.resolve({ outcome: 'idempotency_key_reuse' });
    if ([...this.dayCloses.values()].some((z) => z.device_id === i.deviceId && z.business_date === p.business_date && z.sequence === p.sequence)) {
      return Promise.resolve({ outcome: 'day_close_sequence_taken' });
    }
    if (p.supplemental !== p.sequence > 1) return Promise.resolve({ outcome: 'invalid_payload', message: 'supplemental must equal sequence > 1', field: 'supplemental' });
    this.dayCloses.set(p.day_close_id, { ...structuredClone(p), device_id: i.deviceId, restaurant_id: i.restaurantId, flags: structuredClone(i.response.flags) });
    return Promise.resolve(this.store('day_close', p.day_close_id, 1, p.content_hash, i.response));
  }
}

// ---- Postgres (service role) ---------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Client = { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any };

export class PgEodStore implements EodStore {
  constructor(private readonly db: Client) {}

  private async q<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
    const { data, error } = await p;
    if (error) throw new Error(`${what} failed: ${error.message}`);
    return data;
  }

  submission(type: EntityType, id: string, version: number) {
    return this.q<{ content_hash: string; response: EntityResponse } | null>(this.db.from('pos_entity_submissions').select('content_hash, response').eq('entity_type', type).eq('entity_id', id).eq('version', version).maybeSingle(), 'pos_entity_submissions read');
  }
  shift(id: string) {
    return this.q<StoredShift | null>(this.db.from('pos_shifts').select('shift_id, restaurant_id, device_id, version, status, flags, payload').eq('shift_id', id).maybeSingle(), 'pos_shifts read');
  }
  async movements(ids: readonly string[]) {
    if (!ids.length) return new Map();
    const rows = await this.q<{ id: string; shift_id: string; kind: string; amount_cents: number }[]>(this.db.from('pos_cash_movements').select('id, shift_id, kind, amount_cents').in('id', ids), 'pos_cash_movements read');
    return new Map(rows.map((r) => [r.id, { shift_id: r.shift_id, kind: r.kind, amount_cents: Number(r.amount_cents) }]));
  }
  async refundRestaurant(id: string) {
    return (await this.q<{ restaurant_id: string } | null>(this.db.from('pos_refunds').select('restaurant_id').eq('refund_id', id).maybeSingle(), 'pos_refunds read'))?.restaurant_id ?? null;
  }
  async dayCloseRestaurant(id: string) {
    return (await this.q<{ restaurant_id: string } | null>(this.db.from('pos_day_closes').select('restaurant_id').eq('day_close_id', id).maybeSingle(), 'pos_day_closes read'))?.restaurant_id ?? null;
  }
  async payments(restaurantId: string, ids: readonly string[]) {
    if (!ids.length) return new Map();
    const rows = await this.q<{ id: string; method: string; amount_cents: number; order_id: string; status: string }[]>(
      this.db.from('pos_payments').select('id, method, amount_cents, order_id, status').eq('restaurant_id', restaurantId).in('id', ids), 'pos_payments read');
    return new Map(rows.map((r) => [r.id, { method: r.method, amount_cents: Number(r.amount_cents), order_id: r.order_id, status: r.status }]));
  }
  async refunds(restaurantId: string, ids: readonly string[]) {
    if (!ids.length) return new Map();
    const rows = await this.q<{ refund_id: string; method: string; amount_cents: number }[]>(
      this.db.from('pos_refunds').select('refund_id, method, amount_cents').eq('restaurant_id', restaurantId).in('refund_id', ids), 'pos_refunds read');
    return new Map(rows.map((r) => [r.refund_id, { method: r.method, amount_cents: Number(r.amount_cents) }]));
  }
  async refundAmountsOfPayment(paymentId: string) {
    const rows = await this.q<{ amount_cents: number }[]>(this.db.from('pos_refunds').select('amount_cents').eq('payment_id', paymentId), 'pos_refunds read');
    return rows.map((r) => Number(r.amount_cents));
  }
  zs(deviceId: string, businessDate: string) {
    return this.q<{ sequence: number; covered: DayCloseCovered }[]>(this.db.from('pos_day_closes').select('sequence, covered').eq('device_id', deviceId).eq('business_date', businessDate), 'pos_day_closes read');
  }
  unverifiedShifts(restaurantId: string) {
    return this.q<StoredShift[]>(
      this.db.from('pos_shifts').select('shift_id, restaurant_id, device_id, version, status, flags, payload').eq('restaurant_id', restaurantId).eq('status', 'closed').eq('flags->>drawer_unverified', 'true'),
      'pos_shifts read');
  }
  async setDrawerFlags(shiftId: string, flags: { drawer_mismatch: boolean; drawer_unverified: boolean }) {
    await this.q(this.db.rpc('pos_set_shift_drawer_flags', { p_shift_id: shiftId, p_drawer_mismatch: flags.drawer_mismatch, p_drawer_unverified: flags.drawer_unverified }), 'pos_set_shift_drawer_flags');
  }
  private apply(fn: string, i: ApplyEntity<unknown>): Promise<EodOutcome> {
    return this.q<EodOutcome>(this.db.rpc(fn, { p_payload: i.payload, p_device_id: i.deviceId, p_restaurant_id: i.restaurantId, p_response: i.response, p_received_at: i.receivedAt }), fn);
  }
  applyShift(i: ApplyEntity<ShiftPayload>) { return this.apply('pos_apply_shift', i); }
  applyRefund(i: ApplyEntity<RefundPayload>) { return this.apply('pos_apply_refund', i); }
  applyDayClose(i: ApplyEntity<DayClosePayload>) { return this.apply('pos_apply_day_close', i); }
}
