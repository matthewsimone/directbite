/**
 * pos-v1-submit-order persistence (migration 104: pos_orders, pos_order_lines,
 * pos_order_line_modifiers, pos_payments, pos_order_submissions).
 *
 *  - `decideVersion`: SYNC-CONTRACT §3.1 as a pure function (fakeServer.ts handle :912-929). The
 *    handler uses it as a cheap pre-check (no pricing for a duplicate / conflict / stale request);
 *    the APPLY re-decides atomically.
 *  - `PgOrderStore.apply` = ONE call to plpgsql pos_apply_order_submission (104): advisory lock per
 *    order, identity re-check, §3.1 again, payment rules, aggregate upsert, idempotency row — one
 *    transaction (supabase-js has none).
 *  - `MemoryOrderStore`: the same rules in memory for tests (mirrors the plpgsql step by step).
 */
import type { MenuSnapshot } from './menuSnapshot.ts';
import type { OrderPayload, WireBreakdown, WirePayment } from './orderPayload.ts';

export interface SubmitOrderOk {
  result: 'applied' | 'duplicate' | 'stale_ignored';
  order_id: string;
  version: number;
  server_version: number;
  order_number: number;
  pricing: WireBreakdown;
  priced_against_hash: string;
  flags: Record<string, unknown>;
  diff: Record<string, { provisional: number; server: number; delta: number }>;
  pricing_module_hash: string;
  server_time: string;
}

/** What the server stores per order (latest version). */
export interface OrderHead {
  order_id: string;
  restaurant_id: string;
  ticket_prefix: string;
  version: number;
  writer_device_id: string;
  order_number: number;
  pricing: WireBreakdown;
  provisional_pricing: WireBreakdown;
  priced_against_hash: string;
}

export interface StoredSubmission {
  content_hash: string;
  response: SubmitOrderOk;
}

export type Decision = 'apply' | 'duplicate' | 'idempotency_key_reuse' | 'stale_ignored' | 'version_conflict';

/** §3.1, in the reference's order: idempotency key first, then the version rules. */
export function decideVersion(
  req: { version: number; base_server_version: number; content_hash: string },
  writer: string,
  prior: { content_hash: string } | null,
  cur: { version: number; writer_device_id: string } | null,
): Decision {
  if (prior) return prior.content_hash === req.content_hash ? 'duplicate' : 'idempotency_key_reuse';
  if (cur) {
    if (req.version <= cur.version) return cur.writer_device_id === writer ? 'stale_ignored' : 'version_conflict';
    if (cur.writer_device_id !== writer && req.base_server_version !== cur.version) return 'version_conflict';
    return 'apply';
  }
  return req.base_server_version !== 0 ? 'version_conflict' : 'apply';
}

export interface ApplyInput {
  payload: OrderPayload;
  /** The principal's device (never the body). */
  writer: string;
  restaurantId: string;
  /** The applied response with order_number 0; the store fills in the number. */
  response: SubmitOrderOk;
  receivedAt: string;
}

export type ApplyOutcome =
  | { outcome: 'applied'; response: SubmitOrderOk }
  | { outcome: 'duplicate'; response: SubmitOrderOk }
  | { outcome: 'idempotency_key_reuse' }
  | { outcome: 'stale_ignored'; head: OrderHead }
  | { outcome: 'version_conflict'; server_version: number | null; server_writer_device_id: string | null }
  | { outcome: 'restaurant_mismatch' }
  | { outcome: 'prefix_mismatch'; expected: string }
  | { outcome: 'invalid_payload'; message: string; field: string | null };

export interface OrderStore {
  getHead(orderId: string): Promise<OrderHead | null>;
  getSubmission(orderId: string, version: number): Promise<StoredSubmission | null>;
  /** A stored snapshot of THIS restaurant (a hash of another restaurant counts as unknown). */
  getSnapshot(hash: string, restaurantId: string): Promise<MenuSnapshot | null>;
  apply(i: ApplyInput): Promise<ApplyOutcome>;
}

// ---- memory (tests) --------------------------------------------------------------------------

interface MemPayment extends WirePayment { order_id: string; inserted_at: string; voided_at: string | null }

export class MemoryOrderStore implements OrderStore {
  readonly orders = new Map<string, OrderHead & { payload: OrderPayload; flags: Record<string, unknown> }>();
  readonly submissions = new Map<string, StoredSubmission & { device_id: string; payload: OrderPayload }>();
  readonly payments = new Map<string, MemPayment>();
  readonly paymentInserts = new Map<string, number>();
  readonly lineOwner = new Map<string, string>();
  readonly modifierOwner = new Map<string, string>();
  readonly snapshots = new Map<string, { restaurant_id: string; body: MenuSnapshot }>();
  readonly applied: { order_id: string; version: number }[] = [];
  nextOrderNumber = 5_000_001;
  /** Test hook: runs at the start of apply (simulates a concurrent writer between pre-check and apply). */
  beforeApply: (() => Promise<void> | void) | null = null;

  getHead(orderId: string): Promise<OrderHead | null> {
    const o = this.orders.get(orderId);
    return Promise.resolve(o ? structuredClone(o) : null);
  }
  getSubmission(orderId: string, version: number): Promise<StoredSubmission | null> {
    const s = this.submissions.get(`${orderId}:${version}`);
    return Promise.resolve(s ? structuredClone({ content_hash: s.content_hash, response: s.response }) : null);
  }
  getSnapshot(hash: string, restaurantId: string): Promise<MenuSnapshot | null> {
    const s = this.snapshots.get(hash);
    return Promise.resolve(s && s.restaurant_id === restaurantId ? structuredClone(s.body) : null);
  }
  putSnapshot(s: MenuSnapshot): void {
    if (!this.snapshots.has(s.hash)) this.snapshots.set(s.hash, { restaurant_id: s.restaurant.id, body: structuredClone(s) });
  }

  async apply(i: ApplyInput): Promise<ApplyOutcome> {
    if (this.beforeApply) {
      const h = this.beforeApply;
      this.beforeApply = null;
      await h();
    }
    const p = i.payload;
    const cur = this.orders.get(p.order_id) ?? null;
    if (cur && cur.restaurant_id !== i.restaurantId) return { outcome: 'restaurant_mismatch' };
    if (cur && cur.ticket_prefix !== p.ticket.prefix) return { outcome: 'prefix_mismatch', expected: cur.ticket_prefix };
    const prior = this.submissions.get(`${p.order_id}:${p.version}`) ?? null;
    switch (decideVersion(p, i.writer, prior, cur)) {
      case 'duplicate': return { outcome: 'duplicate', response: structuredClone(prior!.response) };
      case 'idempotency_key_reuse': return { outcome: 'idempotency_key_reuse' };
      case 'stale_ignored': return { outcome: 'stale_ignored', head: structuredClone(cur!) };
      case 'version_conflict': return { outcome: 'version_conflict', server_version: cur?.version ?? null, server_writer_device_id: cur?.writer_device_id ?? null };
      case 'apply': break;
    }
    // ownership of child ids
    for (const l of p.lines) {
      const o = this.lineOwner.get(l.id);
      if (o && o !== p.order_id) return { outcome: 'invalid_payload', message: `line ${l.id} belongs to another order`, field: 'lines' };
      for (const m of l.modifiers) {
        const mo = this.modifierOwner.get(m.id);
        if (mo && mo !== p.order_id) return { outcome: 'invalid_payload', message: `modifier ${m.id} belongs to another order`, field: 'lines' };
      }
    }
    // payments: validate ALL, then write (insert-only; captured → voided only; money / card fields immutable)
    for (const pay of p.payments) {
      const e = this.payments.get(pay.id);
      if (!e) continue;
      if (e.order_id !== p.order_id || e.amount_cents !== pay.amount_cents || e.method !== pay.method || e.last4 !== pay.last4 || e.external_ref !== pay.external_ref) {
        return { outcome: 'invalid_payload', message: `payment ${pay.id} amount/order/method changed`, field: 'payments' };
      }
      if (e.status !== pay.status && !(e.status === 'captured' && pay.status === 'voided')) {
        return { outcome: 'invalid_payload', message: `payment ${pay.id} cannot be un-voided`, field: 'payments' };
      }
    }
    for (const pay of p.payments) {
      const e = this.payments.get(pay.id);
      if (!e) {
        this.payments.set(pay.id, { ...structuredClone(pay), order_id: p.order_id, inserted_at: i.receivedAt, voided_at: pay.status === 'voided' ? i.receivedAt : null });
        this.paymentInserts.set(pay.id, (this.paymentInserts.get(pay.id) ?? 0) + 1);
      } else if (e.status === 'captured' && pay.status === 'voided') {
        Object.assign(e, { status: 'voided', voided_by: pay.voided_by ?? null, void_approved_by: pay.void_approved_by ?? null, void_reason: pay.void_reason ?? null, voided_at: i.receivedAt });
      }
    }
    for (const [id, o] of this.lineOwner) if (o === p.order_id) this.lineOwner.delete(id);
    for (const [id, o] of this.modifierOwner) if (o === p.order_id) this.modifierOwner.delete(id);
    for (const l of p.lines) {
      this.lineOwner.set(l.id, p.order_id);
      for (const m of l.modifiers) this.modifierOwner.set(m.id, p.order_id);
    }
    const order_number = cur?.order_number ?? this.nextOrderNumber++;
    const response = { ...structuredClone(i.response), order_number };
    this.orders.set(p.order_id, {
      order_id: p.order_id,
      restaurant_id: i.restaurantId,
      ticket_prefix: cur?.ticket_prefix ?? p.ticket.prefix,
      version: p.version,
      writer_device_id: i.writer,
      order_number,
      pricing: structuredClone(response.pricing),
      provisional_pricing: structuredClone(p.provisional_pricing),
      priced_against_hash: response.priced_against_hash,
      payload: structuredClone(p),
      flags: structuredClone(response.flags),
    });
    this.submissions.set(`${p.order_id}:${p.version}`, { content_hash: p.content_hash, response, device_id: i.writer, payload: structuredClone(p) });
    this.applied.push({ order_id: p.order_id, version: p.version });
    return { outcome: 'applied', response: structuredClone(response) };
  }
}

// ---- Postgres (service role) -----------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Client = { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any };

export class PgOrderStore implements OrderStore {
  constructor(private readonly db: Client) {}

  async getHead(orderId: string): Promise<OrderHead | null> {
    const { data, error } = await this.db
      .from('pos_orders')
      .select('order_id, restaurant_id, ticket_prefix, version, writer_device_id, order_number, pricing, provisional_pricing, priced_against_hash')
      .eq('order_id', orderId)
      .maybeSingle();
    if (error) throw new Error(`pos_orders read failed: ${error.message}`);
    return data ? { ...data, order_number: Number(data.order_number) } : null;
  }

  async getSubmission(orderId: string, version: number): Promise<StoredSubmission | null> {
    const { data, error } = await this.db
      .from('pos_order_submissions')
      .select('content_hash, response')
      .eq('order_id', orderId)
      .eq('version', version)
      .maybeSingle();
    if (error) throw new Error(`pos_order_submissions read failed: ${error.message}`);
    return data ?? null;
  }

  async getSnapshot(hash: string, restaurantId: string): Promise<MenuSnapshot | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const { data, error } = await this.db
      .from('pos_menu_snapshots')
      .select('body')
      .eq('hash', hash)
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error) throw new Error(`pos_menu_snapshots read failed: ${error.message}`);
    return (data?.body as MenuSnapshot | undefined) ?? null;
  }

  async apply(i: ApplyInput): Promise<ApplyOutcome> {
    const { data, error } = await this.db.rpc('pos_apply_order_submission', {
      p_payload: i.payload,
      p_writer: i.writer,
      p_restaurant_id: i.restaurantId,
      p_response: i.response,
      p_received_at: i.receivedAt,
    });
    if (error) throw new Error(`pos_apply_order_submission failed: ${error.message}`);
    const r = data as Record<string, unknown>;
    if (r.outcome === 'stale_ignored') {
      const h = r.head as OrderHead;
      return { outcome: 'stale_ignored', head: { ...h, order_number: Number(h.order_number) } };
    }
    return r as unknown as ApplyOutcome;
  }
}
