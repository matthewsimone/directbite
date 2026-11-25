/**
 * End-of-day wire payloads (ordr-pos src/sync/contract.ts ShiftPayload / RefundPayload / DayClosePayload)
 * and the server's structural validation (400 invalid_payload). Semantic rules the reference applies
 * later in its apply (closed shift needs a count + attribution; refund amount > 0; supplemental ==
 * sequence > 1) stay in the handlers at the reference's position.
 */
import { UUID_RE } from '../pos-sync/orderPayload.ts';
import type { DayCloseCovered, ShiftAttribution } from './rules.ts';

export interface WireCashMovement {
  id: string;
  kind: 'paid_in' | 'paid_out';
  amount_cents: number;
  reason: string;
  actor: string;
  approved_by: string | null;
  created_at: string;
}

export interface ShiftPayload {
  shift_id: string;
  version: number;
  content_hash: string;
  restaurant_id: string;
  device_id: string;
  business_date: string;
  status: 'open' | 'closed';
  opened_at: string;
  opened_by: string;
  starting_cash_cents: number;
  closed_at: string | null;
  closed_by: string | null;
  close_approved_by: string | null;
  counted_cash_cents: number | null;
  expected_cash_cents: number | null;
  over_short_cents: number | null;
  movements: WireCashMovement[];
  attribution: ShiftAttribution | null;
  device_time: string;
}

export interface RefundPayload {
  refund_id: string;
  version: 1;
  content_hash: string;
  restaurant_id: string;
  device_id: string;
  order_id: string;
  payment_id: string;
  method: 'cash' | 'external_card';
  amount_cents: number;
  reason: string;
  actor: string;
  approved_by: string | null;
  business_date: string;
  shift_id: string | null;
  created_at: string;
  device_time: string;
}

export interface DayClosePayload {
  day_close_id: string;
  version: 1;
  content_hash: string;
  restaurant_id: string;
  device_id: string;
  business_date: string;
  z_number: number;
  sequence: number;
  supplemental: boolean;
  closed_at: string;
  closed_by: string;
  approved_by: string | null;
  report: Record<string, unknown>;
  covered: DayCloseCovered;
  carried_over_order_ids: string[];
  device_time: string;
}

export type EntityType = 'shift' | 'refund' | 'day_close';
export const ID_KEY: Record<EntityType, 'shift_id' | 'refund_id' | 'day_close_id'> = { shift: 'shift_id', refund: 'refund_id', day_close: 'day_close_id' };

// ---- validation ---------------------------------------------------------------------------------

/** END-OF-DAY §2 / drawer.ts DRAWER_REASON_MAX. */
export const REASON_MAX = 200;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class Fail extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
  }
}
const need = (c: boolean, f: string, m: string) => { if (!c) throw new Fail(f, m); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isIso = (v: unknown) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isDate = (v: unknown) => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const isUuid = (v: unknown) => typeof v === 'string' && UUID_RE.test(v);
const strOrNull = (v: unknown, f: string) => need(v === null || typeof v === 'string', f, 'must be a string or null');
const intOrNull = (v: unknown, f: string) => need(v === null || isInt(v), f, 'must be integer cents or null');
const isoOrNull = (v: unknown, f: string) => need(v === null || isIso(v), f, 'must be ISO-8601 or null');

function run(f: () => void): { field: string; message: string } | null {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof Fail) return { field: e.field, message: e.message };
    throw e;
  }
}

function common(p: Record<string, unknown>) {
  need(isDate(p.business_date), 'business_date', 'must be YYYY-MM-DD');
  need(isIso(p.device_time), 'device_time', 'must be ISO-8601');
}

export function shiftProblem(p: Record<string, unknown>) {
  return run(() => {
    need(isInt(p.version) && (p.version as number) >= 1, 'version', 'must be an integer ≥ 1');
    common(p);
    need(p.status === 'open' || p.status === 'closed', 'status', 'must be open | closed');
    need(isIso(p.opened_at), 'opened_at', 'must be ISO-8601');
    need(typeof p.opened_by === 'string', 'opened_by', 'must be a string');
    need(isInt(p.starting_cash_cents) && (p.starting_cash_cents as number) >= 0, 'starting_cash_cents', 'must be integer cents ≥ 0');
    isoOrNull(p.closed_at, 'closed_at');
    strOrNull(p.closed_by, 'closed_by');
    strOrNull(p.close_approved_by ?? null, 'close_approved_by');
    for (const k of ['counted_cash_cents', 'expected_cash_cents', 'over_short_cents']) intOrNull(p[k], k);
    need(Array.isArray(p.movements), 'movements', 'must be an array');
    const ids = new Set<string>();
    (p.movements as unknown[]).forEach((m, i) => {
      const f = `movements[${i}]`;
      need(isObj(m), f, 'must be an object');
      const x = m as Record<string, unknown>;
      need(isUuid(x.id) && !ids.has((x.id as string).toLowerCase()), `${f}.id`, 'must be a unique UUID');
      ids.add((x.id as string).toLowerCase());
      need(x.kind === 'paid_in' || x.kind === 'paid_out', `${f}.kind`, 'must be paid_in | paid_out');
      need(isInt(x.amount_cents) && (x.amount_cents as number) > 0, `${f}.amount_cents`, 'must be integer cents > 0');
      need(typeof x.reason === 'string' && x.reason.length <= REASON_MAX, `${f}.reason`, `must be a string ≤ ${REASON_MAX}`);
      need(typeof x.actor === 'string', `${f}.actor`, 'must be a string');
      strOrNull(x.approved_by ?? null, `${f}.approved_by`);
      need(isIso(x.created_at), `${f}.created_at`, 'must be ISO-8601');
    });
    if (p.attribution !== null) {
      need(isObj(p.attribution), 'attribution', 'must be an object or null');
      const a = p.attribution as Record<string, unknown>;
      for (const k of ['cash_payments', 'cash_payment_voids'] as const) {
        need(Array.isArray(a[k]) && (a[k] as unknown[]).every((x) => isObj(x) && isUuid(x.payment_id) && isUuid(x.order_id) && isInt(x.amount_cents)), `attribution.${k}`, 'must be [{ payment_id, order_id, amount_cents }]');
      }
      need(Array.isArray(a.cash_refunds) && (a.cash_refunds as unknown[]).every((x) => isObj(x) && isUuid(x.refund_id) && isUuid(x.payment_id) && isInt(x.amount_cents)), 'attribution.cash_refunds', 'must be [{ refund_id, payment_id, amount_cents }]');
    }
  });
}

export function refundProblem(p: Record<string, unknown>) {
  return run(() => {
    need(p.version === 1, 'version', 'must be 1');
    common(p);
    need(isUuid(p.order_id), 'order_id', 'must be a UUID');
    need(isUuid(p.payment_id), 'payment_id', 'must be a UUID');
    need(typeof p.method === 'string', 'method', 'must be a string');
    need(isInt(p.amount_cents), 'amount_cents', 'must be integer cents');
    need(typeof p.reason === 'string' && p.reason.length <= REASON_MAX, 'reason', `must be a string ≤ ${REASON_MAX}`);
    need(typeof p.actor === 'string', 'actor', 'must be a string');
    strOrNull(p.approved_by ?? null, 'approved_by');
    need(p.shift_id === null || isUuid(p.shift_id), 'shift_id', 'must be a UUID or null');
    need(isIso(p.created_at), 'created_at', 'must be ISO-8601');
  });
}

export function dayCloseProblem(p: Record<string, unknown>) {
  return run(() => {
    need(p.version === 1, 'version', 'must be 1');
    common(p);
    need(isInt(p.z_number) && (p.z_number as number) >= 1, 'z_number', 'must be an integer ≥ 1');
    need(isInt(p.sequence) && (p.sequence as number) >= 1, 'sequence', 'must be an integer ≥ 1');
    need(typeof p.supplemental === 'boolean', 'supplemental', 'must be a boolean');
    need(isIso(p.closed_at), 'closed_at', 'must be ISO-8601');
    need(typeof p.closed_by === 'string', 'closed_by', 'must be a string');
    strOrNull(p.approved_by ?? null, 'approved_by');
    need(isObj(p.report), 'report', 'must be an object');
    need(isObj(p.covered), 'covered', 'must be an object');
    for (const k of ['order_ids', 'voided_order_ids', 'payment_ids', 'payment_void_ids', 'refund_ids', 'shift_ids']) {
      const v = (p.covered as Record<string, unknown>)[k];
      need(Array.isArray(v) && v.every((x) => typeof x === 'string'), `covered.${k}`, 'must be an array of ids');
    }
    need(Array.isArray(p.carried_over_order_ids) && (p.carried_over_order_ids as unknown[]).every((x) => typeof x === 'string'), 'carried_over_order_ids', 'must be an array of ids');
  });
}
