/**
 * Staff flags (SYNC-CONTRACT §3b, STAFF.md §7.3; handoff item 8). Flags only — never a rejection of money.
 * Shared by pos-v1-submit-order (now) and the item 7 entities (shift / refund / day close — helpers below,
 * tested, not wired until item 7). Reference: ordr-pos test/support/fakeServer.ts
 *   knownActor :523-526, missingApproval :528-533, registerAfterStaff :480-482, orderActorPaths :484-494,
 *   orderActorFlags :540-552, order register_after_staff in handle :965-970, applyShift :629-639,
 *   applyRefund :685-688, applyDayClose :709-711.
 *
 * Deliberate difference from the reference (spec wins, CP11): thresholds that depend on settings
 * (over_short_approval_cents, z_requires_manager) use the settings IN EFFECT AT THE ROW'S TIME
 * (`settingsAt`), not the current ones (the reference's staffSettingsNow()).
 */
import type { StaffRole, StaffSettingsWire } from './snapshot.ts';

export interface StaffContext {
  /** published_at of the restaurant's FIRST staff snapshot (epoch ms), null = never published. */
  firstPublishedAt: number | null;
  /** Every staff id of the restaurant (never deleted, deactivated included) → role. */
  roles: ReadonlyMap<string, StaffRole>;
  /** Published snapshots' settings, ascending by published_at. */
  settingsHistory: readonly { publishedAt: number; settings: StaffSettingsWire }[];
}

export const NO_STAFF: StaffContext = { firstPublishedAt: null, roles: new Map(), settingsHistory: [] };

type Id = string | null | undefined;

/** null / 'register' (no-staff mode, rows from before staff) / any staff id of the restaurant. */
export const knownActor = (ctx: StaffContext, id: Id): boolean => id === null || id === undefined || id === 'register' || ctx.roles.has(id);

/** A gated action by `actor` needs a manager approver unless the actor is a manager or 'register'. */
export function missingApproval(ctx: StaffContext, actor: Id, approver: Id): boolean {
  if (ctx.firstPublishedAt === null || !actor || actor === 'register') return false;
  if (ctx.roles.get(actor) === 'manager') return false;
  return !approver || ctx.roles.get(approver) !== 'manager';
}

/** 'register' on a row timed strictly after the first staff snapshot was published. */
export function registerAfterStaff(ctx: StaffContext, id: Id, at: string | null | undefined): boolean {
  return id === 'register' && ctx.firstPublishedAt !== null && !!at && Date.parse(at) > ctx.firstPublishedAt;
}

/** Settings in effect at `at`: the last snapshot published at or before it (else the first one; null = none). */
export function settingsAt(ctx: StaffContext, at: string | null | undefined): StaffSettingsWire | null {
  if (ctx.settingsHistory.length === 0) return null;
  const t = at ? Date.parse(at) : Number.NaN;
  let found: StaffSettingsWire | null = null;
  for (const h of ctx.settingsHistory) if (h.publishedAt <= t) found = h.settings;
  return found ?? ctx.settingsHistory[0].settings;
}

// ---- orders ------------------------------------------------------------------------------------

interface OrderActors {
  created_by?: string | null;
  closed_by?: string | null;
  voided_by?: string | null;
  void_approved_by?: string | null;
  status: string;
  device_time: string;
  lines: { id: string; status: string; voided_by?: string | null; void_approved_by?: string | null }[];
  payments: { id: string; status: string; taken_by?: string | null; voided_by?: string | null; void_approved_by?: string | null }[];
  delivery: { overrides: { radius: Override | null; minimum: Override | null } } | null;
}
interface Override { actor: string; approved_by?: string | null }

/** Actor / approver values by path (to find what is NEWLY 'register' in a version). */
export function orderActorPaths(p: OrderActors | null | undefined): Record<string, string | null> {
  const m: Record<string, string | null> = {};
  if (!p) return m;
  for (const k of ['created_by', 'closed_by', 'voided_by', 'void_approved_by'] as const) m[k] = p[k] ?? null;
  for (const l of p.lines) {
    m[`l:${l.id}:voided_by`] = l.voided_by ?? null;
    m[`l:${l.id}:void_approved_by`] = l.void_approved_by ?? null;
  }
  for (const x of p.payments) for (const k of ['taken_by', 'voided_by', 'void_approved_by'] as const) m[`p:${x.id}:${k}`] = x[k] ?? null;
  for (const k of ['radius', 'minimum'] as const) {
    const o = p.delivery?.overrides[k];
    if (o) {
      m[`o:${k}:actor`] = o.actor;
      m[`o:${k}:approved_by`] = o.approved_by ?? null;
    }
  }
  return m;
}

export interface OrderStaffFlags {
  unknown_actor: boolean;
  approval_missing: boolean;
  register_actor_after_staff: boolean;
}

/**
 * An applied order version. `prev` = the stored version's actor paths + its sticky flag (null for a new
 * order). Order gates (void order / line / payment, delivery overrides) never depend on settings.
 */
export function orderStaffFlags(ctx: StaffContext, p: OrderActors, prev: { actorPaths: Record<string, string | null>; registerAfterStaff: boolean } | null): OrderStaffFlags {
  const ids: Id[] = [p.created_by, p.closed_by, p.voided_by, p.void_approved_by, ...p.lines.flatMap((l) => [l.voided_by, l.void_approved_by]), ...p.payments.flatMap((x) => [x.taken_by, x.voided_by, x.void_approved_by])];
  const ov = p.delivery ? [p.delivery.overrides.radius, p.delivery.overrides.minimum].filter((x): x is Override => !!x) : [];
  for (const o of ov) ids.push(o.actor, o.approved_by);
  const unknown = ids.some((id) => !knownActor(ctx, id));
  const missing =
    (p.status === 'voided' && missingApproval(ctx, p.voided_by, p.void_approved_by)) ||
    p.lines.some((l) => l.status === 'voided' && missingApproval(ctx, l.voided_by, l.void_approved_by)) ||
    p.payments.some((x) => x.status === 'voided' && missingApproval(ctx, x.voided_by, x.void_approved_by)) ||
    ov.some((o) => missingApproval(ctx, o.actor, o.approved_by));
  const before = prev?.actorPaths ?? {};
  const registerNow = Object.entries(orderActorPaths(p)).some(([k, v]) => v === 'register' && before[k] !== 'register' && registerAfterStaff(ctx, v, p.device_time));
  return { unknown_actor: unknown, approval_missing: missing, register_actor_after_staff: (prev?.registerAfterStaff ?? false) || registerNow };
}

// ---- item 7 entities (ready; wired when submit-shift / -refund / -day-close are built) --------------

export interface ShiftActors {
  status: string;
  opened_by: Id; opened_at: string | null;
  closed_by: Id; closed_at: string | null;
  close_approved_by: Id;
  over_short_cents: number | null;
  movements: { kind: string; actor: Id; approved_by: Id; created_at: string | null }[];
}

export function shiftStaffFlags(ctx: StaffContext, p: ShiftActors): OrderStaffFlags {
  const thr = settingsAt(ctx, p.closed_at)?.over_short_approval_cents ?? 500;
  return {
    unknown_actor: [p.opened_by, p.closed_by, p.close_approved_by, ...p.movements.flatMap((m) => [m.actor, m.approved_by])].some((id) => !knownActor(ctx, id)),
    register_actor_after_staff:
      registerAfterStaff(ctx, p.opened_by, p.opened_at) ||
      registerAfterStaff(ctx, p.closed_by, p.closed_at) ||
      registerAfterStaff(ctx, p.close_approved_by, p.closed_at) ||
      p.movements.some((m) => registerAfterStaff(ctx, m.actor, m.created_at) || registerAfterStaff(ctx, m.approved_by, m.created_at)),
    approval_missing:
      p.movements.some((m) => m.kind === 'paid_out' && missingApproval(ctx, m.actor, m.approved_by)) ||
      (p.status === 'closed' && p.over_short_cents !== null && Math.abs(p.over_short_cents) > thr && missingApproval(ctx, p.closed_by, p.close_approved_by)),
  };
}

export function refundStaffFlags(ctx: StaffContext, p: { actor: Id; approved_by: Id; created_at: string | null }): OrderStaffFlags {
  return {
    unknown_actor: !knownActor(ctx, p.actor) || !knownActor(ctx, p.approved_by),
    approval_missing: missingApproval(ctx, p.actor, p.approved_by),
    register_actor_after_staff: registerAfterStaff(ctx, p.actor, p.created_at) || registerAfterStaff(ctx, p.approved_by, p.created_at),
  };
}

export function dayCloseStaffFlags(ctx: StaffContext, p: { closed_by: Id; approved_by: Id; closed_at: string | null }): OrderStaffFlags {
  return {
    unknown_actor: !knownActor(ctx, p.closed_by) || !knownActor(ctx, p.approved_by),
    approval_missing: (settingsAt(ctx, p.closed_at)?.z_requires_manager ?? false) && missingApproval(ctx, p.closed_by, p.approved_by),
    register_actor_after_staff: registerAfterStaff(ctx, p.closed_by, p.closed_at) || registerAfterStaff(ctx, p.approved_by, p.closed_at),
  };
}
