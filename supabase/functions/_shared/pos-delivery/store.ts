/**
 * POS delivery persistence — migration 115 (pos_delivery_quotes, pos_delivery_provider_quotes, pos_deliveries,
 * pos_delivery_actions, pos_restaurant_settings.pos_delivery_dispatch_enabled) + the POS order reads
 * (pos_orders / pos_order_lines / pos_payments, 104). Pg = PostgREST + the three action functions;
 * MemoryDeliveryStore mirrors the SQL guards for tests (115_smoke.sql runs the same scenarios against Postgres).
 * Nothing here reads or writes orders / order_items / uber_quotes.
 */
// deno-lint-ignore-file no-explicit-any

export type Provider = 'uber_direct';
export type DeliveryState = 'booking' | 'booked' | 'delivered' | 'canceled' | 'failed';

export interface DeliveryQuoteRow {
  id: string; restaurant_id: string; device_id: string; address: Record<string, unknown>; normalized_address: string;
  lat: string; lng: string; distance_miles: string; in_radius: boolean; tier: number | null; fee_cents: number | null;
  needs_confirmation: boolean; menu_snapshot_hash: string; created_at: string; expires_at: string;
}

export interface ProviderQuoteRow {
  id: string; provider: Provider; provider_quote_id: string; restaurant_id: string; device_id: string; delivery_quote_id: string;
  provider_fee_cents: number; customer_fee_cents: number; restaurant_absorbs_cents: number; passthrough_mode: string;
  passthrough_value: number; billing_mode: 'self' | 'platform'; provider_environment: 'sandbox' | 'production';
  pickup_ready_dt: string | null; dropoff_eta: string | null; expires_at: string; created_at: string;
}

export interface DeliveryRow {
  id: string; pos_order_id: string; restaurant_id: string; provider: Provider; state: DeliveryState; action_id: string;
  provider_quote_ref: string | null; provider_quote_id: string | null; provider_delivery_id: string | null;
  tracking_url: string | null; provider_status: string | null; status_updated_at: string | null; dispatched_at: string | null;
  pickup_ready_dt: string | null; courier: { name: string | null; phone: string | null } | null; pickup_eta: string | null;
  dropoff_eta: string | null; provider_fee_cents: number | null; customer_fee_cents: number; restaurant_absorbs_cents: number | null;
  /** 116: the provider fee quoted at the phone call (the order's quote) — fee_delta = provider_fee_cents − this. null before 116. */
  quoted_provider_fee_cents: number | null;
  driver_tip_cents: number; cancellation_fee_cents: number | null; billing_mode: 'self' | 'platform';
  /** 116: who canceled ('restaurant' = a POS cancel, 'provider' = Uber canceled / returned); set with state canceled. */
  canceled_by: 'restaurant' | 'provider' | null;
  provider_environment: 'sandbox' | 'production'; failure_code: string | null; failure_message: string | null;
  last_polled_at: string | null; delivered_at: string | null; canceled_at: string | null; created_at: string; updated_at: string;
}

export type NewDelivery = Pick<DeliveryRow, 'pos_order_id' | 'restaurant_id' | 'provider' | 'action_id' | 'provider_quote_ref' |
  'provider_quote_id' | 'customer_fee_cents' | 'quoted_provider_fee_cents' | 'driver_tip_cents' | 'billing_mode' | 'provider_environment'>;
export type DeliveryPatch = Partial<Omit<DeliveryRow, 'id' | 'pos_order_id' | 'restaurant_id' | 'provider' | 'action_id' | 'quoted_provider_fee_cents' | 'created_at' | 'updated_at'>>;

/** The POS order as dispatch reads it (pos_orders + active lines + payments). */
export interface PosOrderForDelivery {
  order_id: string; restaurant_id: string; order_type: string; channel: string; status: string; total_cents: number;
  subtotal_cents: number; delivery: Record<string, any> | null; customer_name: string | null; customer_phone_e164: string | null;
  note: string | null; ticket_label: string;
  lines: { item_name: string; quantity: number; base_price_cents: number }[];
  payments: { method: string; amount_cents: number; status: string }[];
}

export interface StoredAction { stored: 'applied' | 'noop' | 'error'; error_status: number | null; error_code: string | null; error_message: string | null }
export type ActionBeginOutcome =
  | { outcome: 'started' | 'action_id_reused' }
  | { outcome: 'pending'; since?: string }
  | ({ outcome: 'duplicate' } & StoredAction);

export interface DeliveryStore {
  insertQuote(q: DeliveryQuoteRow): Promise<void>;
  getQuote(restaurantId: string, id: string): Promise<DeliveryQuoteRow | null>;
  insertProviderQuote(q: ProviderQuoteRow): Promise<void>;
  getProviderQuote(restaurantId: string, id: string): Promise<ProviderQuoteRow | null>;
  dispatchEnabled(restaurantId: string): Promise<boolean>;
  getPosOrder(restaurantId: string, orderId: string): Promise<PosOrderForDelivery | null>;
  /** One live booking per order (115 unique index): a second → active_exists with the live one. */
  claimDelivery(d: NewDelivery): Promise<{ outcome: 'claimed'; delivery: DeliveryRow } | { outcome: 'active_exists'; delivery: DeliveryRow }>;
  /** Under the 115 guard (state machine, set-once ids / money): a violation throws. */
  updateDelivery(id: string, patch: DeliveryPatch): Promise<DeliveryRow>;
  deliveryByAction(actionId: string): Promise<DeliveryRow | null>;
  /** The order's most recent delivery (any state). */
  latestDelivery(restaurantId: string, orderId: string): Promise<DeliveryRow | null>;
  /** Claim the right to refresh from the provider: last_polled_at null or older than `cutoffIso` → set to now, true. */
  claimPoll(id: string, cutoffIso: string, nowIso: string): Promise<boolean>;
  beginAction(a: { actionId: string; restaurantId: string; deviceId: string; orderId: string; action: 'dispatch' | 'cancel'; request: Record<string, unknown>; actor: string | null; approver: string | null; deviceTime: string | null }): Promise<ActionBeginOutcome>;
  finishAction(actionId: string, deviceId: string, outcome: 'applied' | 'noop' | 'error', error?: { status: number; code: string; message: string } | null): Promise<void>;
  releaseAction(actionId: string, deviceId: string): Promise<void>;
}

export class DeliveryStoreError extends Error {
  constructor(readonly code: 'invalid_input' | 'guard', message: string) {
    super(message);
    this.name = 'DeliveryStoreError';
  }
}

/** Ticket label as the POS prints it: PREFIX-001. */
export const ticketLabel = (prefix: string, counter: number) => `${prefix}-${String(counter).padStart(3, '0')}`;

// ---- memory (tests) --------------------------------------------------------------------------------------------

function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => jsonEq(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEq((a as any)[k], (b as any)[k]));
}

interface MemAction {
  action_id: string; restaurant_id: string; device_id: string; order_id: string; action: string; request: Record<string, unknown>;
  outcome: 'applied' | 'noop' | 'error' | null; error: { status: number; code: string; message: string } | null; created_at: number;
}

const SET_ONCE: (keyof DeliveryRow)[] = ['provider_delivery_id', 'provider_fee_cents', 'restaurant_absorbs_cents', 'cancellation_fee_cents', 'provider_quote_id', 'canceled_by'];
const NEXT: Record<DeliveryState, DeliveryState[]> = { booking: ['booked', 'failed'], booked: ['delivered', 'canceled'], delivered: [], canceled: [], failed: [] };

export class MemoryDeliveryStore implements DeliveryStore {
  readonly quotes = new Map<string, DeliveryQuoteRow>();
  readonly providerQuotes = new Map<string, ProviderQuoteRow>();
  readonly deliveries: DeliveryRow[] = [];
  readonly actions = new Map<string, MemAction>();
  readonly enabled = new Set<string>();
  readonly posOrders = new Map<string, PosOrderForDelivery>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private iso = () => new Date(this.now()).toISOString();

  insertQuote(q: DeliveryQuoteRow) {
    this.quotes.set(q.id, structuredClone(q));
    return Promise.resolve();
  }
  getQuote(rid: string, id: string) {
    const q = this.quotes.get(id);
    return Promise.resolve(q && q.restaurant_id === rid ? structuredClone(q) : null);
  }
  insertProviderQuote(q: ProviderQuoteRow) {
    if (q.customer_fee_cents + q.restaurant_absorbs_cents !== q.provider_fee_cents) return Promise.reject(new DeliveryStoreError('invalid_input', 'fee split'));
    if ([...this.providerQuotes.values()].some((x) => x.provider === q.provider && x.provider_quote_id === q.provider_quote_id)) {
      return Promise.reject(new DeliveryStoreError('invalid_input', 'duplicate provider quote'));
    }
    this.providerQuotes.set(q.id, structuredClone(q));
    return Promise.resolve();
  }
  getProviderQuote(rid: string, id: string) {
    const q = this.providerQuotes.get(id);
    return Promise.resolve(q && q.restaurant_id === rid ? structuredClone(q) : null);
  }
  dispatchEnabled(rid: string) {
    return Promise.resolve(this.enabled.has(rid));
  }
  getPosOrder(rid: string, orderId: string) {
    const o = this.posOrders.get(orderId);
    return Promise.resolve(o && o.restaurant_id === rid ? structuredClone(o) : null);
  }
  claimDelivery(d: NewDelivery) {
    const live = this.deliveries.find((x) => x.pos_order_id === d.pos_order_id && ['booking', 'booked', 'delivered'].includes(x.state));
    if (live) return Promise.resolve({ outcome: 'active_exists' as const, delivery: structuredClone(live) });
    const now = this.iso();
    const row: DeliveryRow = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`, state: 'booking', provider_delivery_id: null, tracking_url: null,
      provider_status: null, status_updated_at: null, dispatched_at: null, pickup_ready_dt: null, courier: null, pickup_eta: null, dropoff_eta: null,
      provider_fee_cents: null, restaurant_absorbs_cents: null, cancellation_fee_cents: null, failure_code: null, failure_message: null,
      canceled_by: null, last_polled_at: null, delivered_at: null, canceled_at: null, created_at: now, updated_at: now, ...structuredClone(d),
    };
    this.deliveries.push(row);
    return Promise.resolve({ outcome: 'claimed' as const, delivery: structuredClone(row) });
  }
  updateDelivery(id: string, patch: DeliveryPatch) {
    const row = this.deliveries.find((x) => x.id === id);
    if (!row) return Promise.reject(new DeliveryStoreError('invalid_input', 'no such delivery'));
    for (const k of SET_ONCE) {
      if (k in patch && row[k] !== null && (patch as any)[k] !== row[k]) return Promise.reject(new DeliveryStoreError('guard', `${k} is set once`));
    }
    if (patch.state && patch.state !== row.state && !NEXT[row.state].includes(patch.state)) {
      return Promise.reject(new DeliveryStoreError('guard', `${row.state} → ${patch.state}`));
    }
    if ((row.state === 'failed' || row.state === 'canceled') && Object.keys(patch).some((k) => k !== 'last_polled_at')) {
      return Promise.reject(new DeliveryStoreError('guard', `${row.state} is final`));
    }
    Object.assign(row, structuredClone(patch), { updated_at: this.iso() });
    if (row.state === 'booked' && !row.provider_delivery_id) return Promise.reject(new DeliveryStoreError('guard', 'booked without an id'));
    // 116 checks: canceled ⇔ canceled_by; absorbs = provider fee − customer fee (signed: negative when the provider got cheaper)
    if (row.state === 'canceled' && !row.canceled_by) return Promise.reject(new DeliveryStoreError('guard', 'canceled without canceled_by'));
    if (row.provider_fee_cents !== null && row.restaurant_absorbs_cents !== null && row.restaurant_absorbs_cents !== row.provider_fee_cents - row.customer_fee_cents) {
      return Promise.reject(new DeliveryStoreError('guard', 'absorbs is not provider − customer'));
    }
    return Promise.resolve(structuredClone(row));
  }
  deliveryByAction(actionId: string) {
    const r = this.deliveries.find((x) => x.action_id === actionId);
    return Promise.resolve(r ? structuredClone(r) : null);
  }
  latestDelivery(rid: string, orderId: string) {
    const rows = this.deliveries.filter((x) => x.pos_order_id === orderId && x.restaurant_id === rid);
    return Promise.resolve(rows.length ? structuredClone(rows[rows.length - 1]) : null);
  }
  claimPoll(id: string, cutoffIso: string, nowIso: string) {
    const row = this.deliveries.find((x) => x.id === id);
    if (!row || (row.last_polled_at !== null && row.last_polled_at >= cutoffIso)) return Promise.resolve(false);
    row.last_polled_at = nowIso;
    return Promise.resolve(true);
  }
  beginAction(a: Parameters<DeliveryStore['beginAction']>[0]): Promise<ActionBeginOutcome> {
    const cur = this.actions.get(a.actionId);
    if (!cur) {
      this.actions.set(a.actionId, {
        action_id: a.actionId, restaurant_id: a.restaurantId, device_id: a.deviceId, order_id: a.orderId, action: a.action,
        request: structuredClone(a.request), outcome: null, error: null, created_at: this.now(),
      });
      return Promise.resolve({ outcome: 'started' });
    }
    if (cur.restaurant_id !== a.restaurantId || cur.device_id !== a.deviceId || cur.order_id !== a.orderId || cur.action !== a.action || !jsonEq(cur.request, a.request)) {
      return Promise.resolve({ outcome: 'action_id_reused' });
    }
    if (cur.outcome === null) return Promise.resolve({ outcome: 'pending', since: new Date(cur.created_at).toISOString() });
    return Promise.resolve({ outcome: 'duplicate', stored: cur.outcome, error_status: cur.error?.status ?? null, error_code: cur.error?.code ?? null, error_message: cur.error?.message ?? null });
  }
  finishAction(actionId: string, deviceId: string, outcome: 'applied' | 'noop' | 'error', error: { status: number; code: string; message: string } | null = null) {
    const cur = this.actions.get(actionId);
    if (cur && cur.device_id === deviceId && cur.outcome === null) {
      cur.outcome = outcome;
      cur.error = outcome === 'error' ? error : null;
    }
    return Promise.resolve();
  }
  releaseAction(actionId: string, deviceId: string) {
    const cur = this.actions.get(actionId);
    if (cur && cur.device_id === deviceId && cur.outcome === null) this.actions.delete(actionId);
    return Promise.resolve();
  }
}

// ---- Postgres (service role) ----------------------------------------------------------------------------------

type Client = { rpc(fn: string, args: Record<string, unknown>): any; from(table: string): any };

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
function normDelivery(r: any): DeliveryRow {
  const out = { ...r };
  for (const k of ['status_updated_at', 'dispatched_at', 'pickup_ready_dt', 'pickup_eta', 'dropoff_eta', 'last_polled_at', 'delivered_at', 'canceled_at', 'created_at', 'updated_at']) out[k] = iso(r[k]);
  return out as DeliveryRow;
}

export class PgDeliveryStore implements DeliveryStore {
  constructor(private readonly db: Client) {}

  private async rows<T>(what: string, q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> {
    const { data, error } = await q;
    if (error) throw new Error(`${what} failed: ${error.message}`);
    return data as T;
  }
  async insertQuote(q: DeliveryQuoteRow) {
    await this.rows('pos_delivery_quotes insert', this.db.from('pos_delivery_quotes').insert(q));
  }
  async getQuote(rid: string, id: string) {
    const r = await this.rows<any>('pos_delivery_quotes read', this.db.from('pos_delivery_quotes').select('*').eq('id', id).eq('restaurant_id', rid).maybeSingle());
    return r ? { ...r, lat: String(r.lat), lng: String(r.lng), distance_miles: String(r.distance_miles), created_at: iso(r.created_at)!, expires_at: iso(r.expires_at)! } : null;
  }
  async insertProviderQuote(q: ProviderQuoteRow) {
    await this.rows('pos_delivery_provider_quotes insert', this.db.from('pos_delivery_provider_quotes').insert(q));
  }
  async getProviderQuote(rid: string, id: string) {
    const r = await this.rows<any>('pos_delivery_provider_quotes read', this.db.from('pos_delivery_provider_quotes').select('*').eq('id', id).eq('restaurant_id', rid).maybeSingle());
    return r ? { ...r, passthrough_value: Number(r.passthrough_value), expires_at: iso(r.expires_at)!, created_at: iso(r.created_at)!, pickup_ready_dt: iso(r.pickup_ready_dt), dropoff_eta: iso(r.dropoff_eta) } : null;
  }
  async dispatchEnabled(rid: string) {
    const r = await this.rows<any>('pos_restaurant_settings read', this.db.from('pos_restaurant_settings').select('pos_delivery_dispatch_enabled').eq('restaurant_id', rid).maybeSingle());
    return r?.pos_delivery_dispatch_enabled === true;
  }
  async getPosOrder(rid: string, orderId: string): Promise<PosOrderForDelivery | null> {
    const o = await this.rows<any>('pos_orders read', this.db.from('pos_orders')
      .select('order_id, restaurant_id, order_type, channel, status, total_cents, pricing, delivery, customer_name, customer_phone_e164, note, ticket_prefix, ticket_counter')
      .eq('order_id', orderId).eq('restaurant_id', rid).maybeSingle());
    if (!o) return null;
    const [lines, payments] = await Promise.all([
      this.rows<any[]>('pos_order_lines read', this.db.from('pos_order_lines').select('item_name, quantity, base_price_cents, status').eq('order_id', orderId)),
      this.rows<any[]>('pos_payments read', this.db.from('pos_payments').select('method, amount_cents, status').eq('order_id', orderId)),
    ]);
    return {
      order_id: o.order_id, restaurant_id: o.restaurant_id, order_type: o.order_type, channel: o.channel, status: o.status,
      total_cents: Number(o.total_cents), subtotal_cents: Number(o.pricing?.subtotal_cents ?? 0), delivery: o.delivery ?? null,
      customer_name: o.customer_name, customer_phone_e164: o.customer_phone_e164, note: o.note, ticket_label: ticketLabel(o.ticket_prefix, o.ticket_counter),
      lines: (lines ?? []).filter((l) => l.status === 'active').map((l) => ({ item_name: l.item_name, quantity: Number(l.quantity), base_price_cents: Number(l.base_price_cents) })),
      payments: (payments ?? []).map((p) => ({ method: p.method, amount_cents: Number(p.amount_cents), status: p.status })),
    };
  }
  async claimDelivery(d: NewDelivery) {
    const { data, error } = await this.db.from('pos_deliveries').insert(d).select('*').single();
    if (!error) return { outcome: 'claimed' as const, delivery: normDelivery(data) };
    if (error.code !== '23505') throw new Error(`pos_deliveries insert failed: ${error.message}`);
    const live = await this.rows<any>('pos_deliveries read', this.db.from('pos_deliveries').select('*').eq('pos_order_id', d.pos_order_id)
      .in('state', ['booking', 'booked', 'delivered']).maybeSingle());
    if (!live) throw new Error(`pos_deliveries insert conflicted without a live row: ${error.message}`);
    return { outcome: 'active_exists' as const, delivery: normDelivery(live) };
  }
  async updateDelivery(id: string, patch: DeliveryPatch) {
    const { data, error } = await this.db.from('pos_deliveries').update(patch).eq('id', id).select('*').single();
    if (error) throw error.code === '42501' ? new DeliveryStoreError('guard', error.message) : new Error(`pos_deliveries update failed: ${error.message}`);
    return normDelivery(data);
  }
  async deliveryByAction(actionId: string) {
    const r = await this.rows<any>('pos_deliveries read', this.db.from('pos_deliveries').select('*').eq('action_id', actionId).maybeSingle());
    return r ? normDelivery(r) : null;
  }
  async latestDelivery(rid: string, orderId: string) {
    const r = await this.rows<any[]>('pos_deliveries read', this.db.from('pos_deliveries').select('*').eq('pos_order_id', orderId).eq('restaurant_id', rid)
      .order('created_at', { ascending: false }).limit(1));
    return r?.length ? normDelivery(r[0]) : null;
  }
  async claimPoll(id: string, cutoffIso: string, nowIso: string) {
    const r = await this.rows<any[]>('pos_deliveries poll claim', this.db.from('pos_deliveries').update({ last_polled_at: nowIso }).eq('id', id)
      .or(`last_polled_at.is.null,last_polled_at.lt.${cutoffIso}`).select('id'));
    return (r ?? []).length > 0;
  }
  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (['22023', '22P02', '23514'].includes(error.code)) throw new DeliveryStoreError('invalid_input', `${fn}: ${error.message}`);
      throw new Error(`${fn} failed: ${error.message}`);
    }
    return data as T;
  }
  async beginAction(a: Parameters<DeliveryStore['beginAction']>[0]): Promise<ActionBeginOutcome> {
    const r = await this.call<any>('pos_delivery_action_begin', {
      p_action_id: a.actionId, p_restaurant_id: a.restaurantId, p_device_id: a.deviceId, p_order_id: a.orderId, p_action: a.action,
      p_request: a.request, p_actor: a.actor, p_approver: a.approver, p_device_time: a.deviceTime,
    });
    return r.outcome === 'pending' ? { outcome: 'pending', since: iso(r.since) ?? undefined } : r;
  }
  async finishAction(actionId: string, deviceId: string, outcome: 'applied' | 'noop' | 'error', error: { status: number; code: string; message: string } | null = null) {
    await this.call('pos_delivery_action_finish', {
      p_action_id: actionId, p_device_id: deviceId, p_outcome: outcome, p_error_status: error?.status ?? null, p_error_code: error?.code ?? null,
      p_error_message: error?.message ?? null,
    });
  }
  async releaseAction(actionId: string, deviceId: string) {
    await this.call('pos_delivery_action_release', { p_action_id: actionId, p_device_id: deviceId });
  }
}
