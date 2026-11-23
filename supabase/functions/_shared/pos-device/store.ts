/**
 * Device-auth persistence (ordr-pos docs/DEVICE-AUTH.md §2).
 *
 * `DeviceStore` is what register / auth / admin need. Two implementations with the SAME semantics:
 *  - `PgDeviceStore`: supabase-js (service role). Every multi-row critical section is ONE call to a
 *    plpgsql function from migration 101 (supabase-js can't hold a transaction):
 *      pos_create_enrollment        (prefix allocation under an advisory lock + insert)
 *      pos_consume_enrollment       (row lock, re-check usable, device insert/update, mark used,
 *                                    event, attempt row — or the failure bookkeeping)
 *      pos_record_enrollment_failure(attempt row + event + failed_attempts / lock at 5)
 *      pos_replay_enrollment        (row lock, re-check nonce + window, fresh token)
 *      pos_record_auth_failed       (rate-capped auth_failed event)
 *      pos_revoke_device            (status + event)
 *  - `MemoryDeviceStore`: the same rules in memory, for tests (mirrors the plpgsql line by line).
 *
 * Times are epoch milliseconds in TS; the Pg store converts to / from ISO.
 * Tokens and enrollment secrets never reach the store — only their sha256 hex.
 */

export const CODE_MAX_FAILS = 5;

export type DeviceStatus = 'active' | 'revoked';
export type DeviceEventType =
  | 'enrolled'
  | 'reenrolled'
  | 'revoked'
  | 'rotation_offered'
  | 'rotated'
  | 'auth_failed'
  | 'enrollment_failed'
  | 'enrollment_locked';

export interface DeviceRow {
  id: string;
  restaurant_id: string;
  prefix: string;
  label: string;
  token_hash: string;
  token_issued_at: number;
  status: DeviceStatus;
  hardware_model: string | null;
  last_app_version: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface EnrollmentRow {
  id: string;
  restaurant_id: string;
  lookup_id: string;
  secret_hash: string;
  target_device_id: string | null;
  prefix: string | null;
  label: string | null;
  expires_at: number;
  failed_attempts: number;
  locked_at: number | null;
  used_at: number | null;
  used_nonce: string | null;
  used_device_id: string | null;
  created_by: string;
  created_at: number;
}

export interface DeviceEvent {
  device_id: string | null;
  restaurant_id: string | null;
  type: DeviceEventType;
  actor: string;
  detail: Record<string, unknown>;
  at: number;
}

export type ConsumeResult =
  | { ok: true; device: DeviceRow; reenrolled: boolean }
  /** not_usable = used / locked / gone (not counted against the code); the others were counted. */
  | { ok: false; reason: 'not_usable' | 'expired' | 'device_mismatch' };

export type CreateEnrollmentResult =
  | { ok: true; enrollmentId: string; prefix: string; label: string }
  | { ok: false; reason: 'lookup_taken' | 'unknown_device' | 'unknown_restaurant' | 'no_prefixes' };

export interface DeviceStore {
  // §5 IP gate
  /** Timestamps of FAILED attempts by `ip` after `sinceMs`, ascending. */
  failedAttemptTimes(ip: string, sinceMs: number): Promise<number[]>;
  /** Every failed attempt after `sinceMs` (admin: locked IPs). */
  failedAttemptsSince(sinceMs: number): Promise<{ ip: string; at: number }[]>;

  // §4.1 register
  newestUsedEnrollment(lookupId: string): Promise<EnrollmentRow | null>;
  /** The enrollment for `lookupId` that is unused and unlocked (unique by index). */
  liveEnrollment(lookupId: string): Promise<EnrollmentRow | null>;
  /** Attempt row (failed) + enrollment_failed event + per-code counting / lock at CODE_MAX_FAILS. */
  recordEnrollmentFailure(i: { ip: string; enrollmentId: string | null; at: number }): Promise<void>;
  /** Atomic: re-check under a row lock, then new device / re-enroll + mark used + event + success row. Records its own failures. */
  consumeEnrollment(i: {
    enrollmentId: string;
    nonce: string;
    tokenHash: string;
    existingDeviceId: string | null;
    hardwareModel: string | null;
    appVersion: string | null;
    ip: string;
    at: number;
  }): Promise<ConsumeResult>;
  /** Atomic: same nonce, still inside the window → set a fresh token on used_device_id. Not an attempt. */
  replayEnrollment(i: { enrollmentId: string; nonce: string; tokenHash: string; windowMs: number; at: number }): Promise<DeviceRow | null>;

  // §4.2 middleware
  deviceByTokenHash(tokenHash: string): Promise<DeviceRow | null>;
  /** last_seen_at (+ last_app_version when given), only if last_seen_at is null or older than throttleMs. */
  touchDevice(i: { deviceId: string; appVersion: string | null; throttleMs: number; at: number }): Promise<void>;
  /** auth_failed event unless `capPerMinute` were already written in the last minute. */
  recordAuthFailed(i: { deviceId: string | null; restaurantId: string | null; code: string; capPerMinute: number; at: number }): Promise<void>;

  // §6 admin
  createEnrollment(i: {
    restaurantId: string;
    label: string | null;
    targetDeviceId: string | null;
    lookupId: string;
    secretHash: string;
    expiresAt: number;
    createdBy: string;
    at: number;
  }): Promise<CreateEnrollmentResult>;
  revokeDevice(i: { deviceId: string; restaurantId: string | null; reason: string; actor: string; at: number }): Promise<'revoked' | 'unknown_device'>;
  listDevices(restaurantId: string): Promise<DeviceRow[]>;
}

// ---- prefix allocation (shared rule) --------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Next unused of A…Z, then AA…ZZ (DEVICE-AUTH §2). `taken` = every device prefix + every new-device enrollment prefix. */
export function nextPrefix(taken: Set<string>): string | null {
  for (const c of LETTERS) if (!taken.has(c)) return c;
  for (const a of LETTERS) for (const b of LETTERS) if (!taken.has(a + b)) return a + b;
  return null;
}

// ---- in-memory ------------------------------------------------------------------------------------

/** Test store. Mirrors the plpgsql functions in migration 101 exactly. */
export class MemoryDeviceStore implements DeviceStore {
  readonly devices = new Map<string, DeviceRow>();
  readonly enrollments: EnrollmentRow[] = [];
  readonly attempts: { ip: string; at: number; success: boolean }[] = [];
  readonly events: DeviceEvent[] = [];
  /** Known restaurants (FK). Empty = accept any id. */
  readonly restaurants = new Set<string>();

  private event(e: Omit<DeviceEvent, 'detail'> & { detail?: Record<string, unknown> }): void {
    this.events.push({ ...e, detail: e.detail ?? {} });
  }

  failedAttemptTimes(ip: string, sinceMs: number): Promise<number[]> {
    return Promise.resolve(this.attempts.filter((a) => a.ip === ip && !a.success && a.at > sinceMs).map((a) => a.at).sort((x, y) => x - y));
  }

  failedAttemptsSince(sinceMs: number): Promise<{ ip: string; at: number }[]> {
    return Promise.resolve(this.attempts.filter((a) => !a.success && a.at > sinceMs).map((a) => ({ ip: a.ip, at: a.at })));
  }

  newestUsedEnrollment(lookupId: string): Promise<EnrollmentRow | null> {
    const used = this.enrollments.filter((e) => e.lookup_id === lookupId && e.used_at !== null).sort((a, b) => b.used_at! - a.used_at!);
    return Promise.resolve(used[0] ? { ...used[0] } : null);
  }

  liveEnrollment(lookupId: string): Promise<EnrollmentRow | null> {
    const e = this.enrollments.find((x) => x.lookup_id === lookupId && x.used_at === null && x.locked_at === null);
    return Promise.resolve(e ? { ...e } : null);
  }

  /** pos_record_enrollment_failure */
  recordEnrollmentFailure(i: { ip: string; enrollmentId: string | null; at: number }): Promise<void> {
    this.attempts.push({ ip: i.ip, at: i.at, success: false });
    const e = i.enrollmentId ? this.enrollments.find((x) => x.id === i.enrollmentId) : undefined;
    this.event({ device_id: e?.target_device_id ?? null, restaurant_id: e?.restaurant_id ?? null, type: 'enrollment_failed', actor: 'device', detail: { lookup_id: e?.lookup_id ?? null }, at: i.at });
    if (e && e.used_at === null && e.locked_at === null) {
      e.failed_attempts += 1;
      if (e.failed_attempts >= CODE_MAX_FAILS) {
        e.locked_at = i.at;
        this.event({ device_id: e.target_device_id, restaurant_id: e.restaurant_id, type: 'enrollment_locked', actor: 'system', detail: { lookup_id: e.lookup_id }, at: i.at });
      }
    }
    return Promise.resolve();
  }

  /** pos_consume_enrollment */
  async consumeEnrollment(i: Parameters<DeviceStore['consumeEnrollment']>[0]): Promise<ConsumeResult> {
    const e = this.enrollments.find((x) => x.id === i.enrollmentId);
    if (!e || e.used_at !== null || e.locked_at !== null || e.prefix === null) {
      await this.recordEnrollmentFailure({ ip: i.ip, enrollmentId: null, at: i.at });
      return { ok: false, reason: 'not_usable' };
    }
    if (i.at >= e.expires_at) {
      await this.recordEnrollmentFailure({ ip: i.ip, enrollmentId: e.id, at: i.at });
      return { ok: false, reason: 'expired' };
    }
    let d: DeviceRow;
    let reenrolled = false;
    if (e.target_device_id === null) {
      if (i.existingDeviceId !== null) {
        await this.recordEnrollmentFailure({ ip: i.ip, enrollmentId: e.id, at: i.at });
        return { ok: false, reason: 'device_mismatch' };
      }
      if ([...this.devices.values()].some((x) => x.token_hash === i.tokenHash)) throw new Error('token_hash unique violation');
      d = {
        id: crypto.randomUUID(),
        restaurant_id: e.restaurant_id,
        prefix: e.prefix,
        label: e.label ?? `Register ${e.prefix}`,
        token_hash: i.tokenHash,
        token_issued_at: i.at,
        status: 'active',
        hardware_model: i.hardwareModel,
        last_app_version: i.appVersion,
        created_at: i.at,
        last_seen_at: null,
        revoked_at: null,
        revoked_reason: null,
      };
      if ([...this.devices.values()].some((x) => x.restaurant_id === d.restaurant_id && x.prefix === d.prefix)) throw new Error('(restaurant_id, prefix) unique violation');
      this.devices.set(d.id, d);
      this.event({ device_id: d.id, restaurant_id: d.restaurant_id, type: 'enrolled', actor: 'device', detail: { lookup_id: e.lookup_id }, at: i.at });
    } else {
      if (i.existingDeviceId !== e.target_device_id) {
        await this.recordEnrollmentFailure({ ip: i.ip, enrollmentId: e.id, at: i.at });
        return { ok: false, reason: 'device_mismatch' };
      }
      const t = this.devices.get(e.target_device_id);
      if (!t) {
        await this.recordEnrollmentFailure({ ip: i.ip, enrollmentId: null, at: i.at });
        return { ok: false, reason: 'not_usable' };
      }
      t.token_hash = i.tokenHash;
      t.token_issued_at = i.at;
      t.status = 'active';
      t.revoked_at = null;
      t.revoked_reason = null;
      t.hardware_model = i.hardwareModel ?? t.hardware_model;
      t.last_app_version = i.appVersion ?? t.last_app_version;
      d = t;
      reenrolled = true;
      this.event({ device_id: d.id, restaurant_id: d.restaurant_id, type: 'reenrolled', actor: 'device', detail: { lookup_id: e.lookup_id }, at: i.at });
    }
    e.used_at = i.at;
    e.used_nonce = i.nonce;
    e.used_device_id = d.id;
    this.attempts.push({ ip: i.ip, at: i.at, success: true });
    return { ok: true, device: { ...d }, reenrolled };
  }

  /** pos_replay_enrollment */
  replayEnrollment(i: { enrollmentId: string; nonce: string; tokenHash: string; windowMs: number; at: number }): Promise<DeviceRow | null> {
    const e = this.enrollments.find((x) => x.id === i.enrollmentId);
    if (!e || e.used_at === null || e.used_nonce !== i.nonce || i.at - e.used_at >= i.windowMs || !e.used_device_id) return Promise.resolve(null);
    const d = this.devices.get(e.used_device_id);
    if (!d) return Promise.resolve(null);
    d.token_hash = i.tokenHash;
    d.token_issued_at = i.at;
    return Promise.resolve({ ...d });
  }

  deviceByTokenHash(tokenHash: string): Promise<DeviceRow | null> {
    const d = [...this.devices.values()].find((x) => x.token_hash === tokenHash);
    return Promise.resolve(d ? { ...d } : null);
  }

  touchDevice(i: { deviceId: string; appVersion: string | null; throttleMs: number; at: number }): Promise<void> {
    const d = this.devices.get(i.deviceId);
    if (d && (d.last_seen_at === null || d.last_seen_at < i.at - i.throttleMs)) {
      d.last_seen_at = i.at;
      if (i.appVersion !== null) d.last_app_version = i.appVersion;
    }
    return Promise.resolve();
  }

  /** pos_record_auth_failed */
  recordAuthFailed(i: { deviceId: string | null; restaurantId: string | null; code: string; capPerMinute: number; at: number }): Promise<void> {
    if (this.events.filter((e) => e.type === 'auth_failed' && e.at > i.at - 60_000).length >= i.capPerMinute) return Promise.resolve();
    this.event({ device_id: i.deviceId, restaurant_id: i.restaurantId, type: 'auth_failed', actor: 'system', detail: { code: i.code }, at: i.at });
    return Promise.resolve();
  }

  /** pos_create_enrollment */
  createEnrollment(i: Parameters<DeviceStore['createEnrollment']>[0]): Promise<CreateEnrollmentResult> {
    if (this.restaurants.size && !this.restaurants.has(i.restaurantId)) return Promise.resolve({ ok: false, reason: 'unknown_restaurant' });
    let prefix: string;
    let label: string;
    const wanted = i.label?.trim() ? i.label.trim() : null;
    if (i.targetDeviceId) {
      const d = this.devices.get(i.targetDeviceId);
      if (!d || d.restaurant_id !== i.restaurantId) return Promise.resolve({ ok: false, reason: 'unknown_device' });
      prefix = d.prefix;
      label = wanted ?? d.label;
    } else {
      const taken = new Set([
        ...[...this.devices.values()].filter((d) => d.restaurant_id === i.restaurantId).map((d) => d.prefix),
        ...this.enrollments.filter((e) => e.restaurant_id === i.restaurantId && e.target_device_id === null && e.prefix !== null).map((e) => e.prefix!),
      ]);
      const p = nextPrefix(taken);
      if (!p) return Promise.resolve({ ok: false, reason: 'no_prefixes' });
      prefix = p;
      label = wanted ?? `Register ${prefix}`;
    }
    if (this.enrollments.some((e) => e.lookup_id === i.lookupId && e.used_at === null && e.locked_at === null)) {
      return Promise.resolve({ ok: false, reason: 'lookup_taken' });
    }
    const id = crypto.randomUUID();
    this.enrollments.push({
      id,
      restaurant_id: i.restaurantId,
      lookup_id: i.lookupId,
      secret_hash: i.secretHash,
      target_device_id: i.targetDeviceId,
      prefix,
      label,
      expires_at: i.expiresAt,
      failed_attempts: 0,
      locked_at: null,
      used_at: null,
      used_nonce: null,
      used_device_id: null,
      created_by: i.createdBy,
      created_at: i.at,
    });
    return Promise.resolve({ ok: true, enrollmentId: id, prefix, label });
  }

  /** pos_revoke_device */
  revokeDevice(i: { deviceId: string; restaurantId: string | null; reason: string; actor: string; at: number }): Promise<'revoked' | 'unknown_device'> {
    const d = this.devices.get(i.deviceId);
    if (!d || (i.restaurantId !== null && d.restaurant_id !== i.restaurantId)) return Promise.resolve('unknown_device');
    d.status = 'revoked';
    d.revoked_at = i.at;
    d.revoked_reason = i.reason;
    this.event({ device_id: d.id, restaurant_id: d.restaurant_id, type: 'revoked', actor: i.actor, detail: { reason: i.reason }, at: i.at });
    return Promise.resolve('revoked');
  }

  listDevices(restaurantId: string): Promise<DeviceRow[]> {
    return Promise.resolve([...this.devices.values()].filter((d) => d.restaurant_id === restaurantId).sort((a, b) => (a.prefix.length - b.prefix.length) || a.prefix.localeCompare(b.prefix)).map((d) => ({ ...d })));
  }
}

// ---- Postgres (supabase-js, service role) ------------------------------------------------------------

/** The slice of a supabase-js client this store uses (kept structural so tests need no network import). */
// deno-lint-ignore no-explicit-any
export type SupabaseLike = { rpc: (fn: string, args: Record<string, unknown>) => any; from: (table: string) => any };

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Date.parse(String(v)));

// deno-lint-ignore no-explicit-any
function toDevice(r: any): DeviceRow {
  return {
    id: r.id,
    restaurant_id: r.restaurant_id,
    prefix: r.prefix,
    label: r.label,
    token_hash: r.token_hash ?? '',
    token_issued_at: ms(r.token_issued_at) ?? 0,
    status: r.status,
    hardware_model: r.hardware_model ?? null,
    last_app_version: r.last_app_version ?? null,
    created_at: ms(r.created_at) ?? 0,
    last_seen_at: ms(r.last_seen_at),
    revoked_at: ms(r.revoked_at),
    revoked_reason: r.revoked_reason ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function toEnrollment(r: any): EnrollmentRow {
  return {
    id: r.id,
    restaurant_id: r.restaurant_id,
    lookup_id: r.lookup_id,
    secret_hash: r.secret_hash,
    target_device_id: r.target_device_id ?? null,
    prefix: r.prefix ?? null,
    label: r.label ?? null,
    expires_at: ms(r.expires_at) ?? 0,
    failed_attempts: r.failed_attempts ?? 0,
    locked_at: ms(r.locked_at),
    used_at: ms(r.used_at),
    used_nonce: r.used_nonce ?? null,
    used_device_id: r.used_device_id ?? null,
    created_by: r.created_by,
    created_at: ms(r.created_at) ?? 0,
  };
}

const DEVICE_COLUMNS =
  'id, restaurant_id, prefix, label, token_hash, token_issued_at, status, hardware_model, last_app_version, created_at, last_seen_at, revoked_at, revoked_reason';
const ENROLLMENT_COLUMNS =
  'id, restaurant_id, lookup_id, secret_hash, target_device_id, prefix, label, expires_at, failed_attempts, locked_at, used_at, used_nonce, used_device_id, created_by, created_at';

class StoreError extends Error {
  constructor(op: string, message: string) {
    super(`device store ${op}: ${message}`);
    this.name = 'StoreError';
  }
}

export class PgDeviceStore implements DeviceStore {
  constructor(private readonly db: SupabaseLike) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new StoreError(fn, error.message);
    return data as T;
  }

  async failedAttemptTimes(ip: string, sinceMs: number): Promise<number[]> {
    const { data, error } = await this.db.from('pos_auth_attempts').select('at').eq('ip', ip).eq('success', false).gt('at', iso(sinceMs)).order('at', { ascending: true });
    if (error) throw new StoreError('failedAttemptTimes', error.message);
    return (data ?? []).map((r: { at: string }) => Date.parse(r.at));
  }

  async failedAttemptsSince(sinceMs: number): Promise<{ ip: string; at: number }[]> {
    const { data, error } = await this.db.from('pos_auth_attempts').select('ip, at').eq('success', false).gt('at', iso(sinceMs)).order('at', { ascending: true }).limit(10000);
    if (error) throw new StoreError('failedAttemptsSince', error.message);
    return (data ?? []).map((r: { ip: string; at: string }) => ({ ip: String(r.ip), at: Date.parse(r.at) }));
  }

  async newestUsedEnrollment(lookupId: string): Promise<EnrollmentRow | null> {
    const { data, error } = await this.db.from('pos_device_enrollments').select(ENROLLMENT_COLUMNS).eq('lookup_id', lookupId).not('used_at', 'is', null).order('used_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new StoreError('newestUsedEnrollment', error.message);
    return data ? toEnrollment(data) : null;
  }

  async liveEnrollment(lookupId: string): Promise<EnrollmentRow | null> {
    const { data, error } = await this.db.from('pos_device_enrollments').select(ENROLLMENT_COLUMNS).eq('lookup_id', lookupId).is('used_at', null).is('locked_at', null).maybeSingle();
    if (error) throw new StoreError('liveEnrollment', error.message);
    return data ? toEnrollment(data) : null;
  }

  async recordEnrollmentFailure(i: { ip: string; enrollmentId: string | null; at: number }): Promise<void> {
    await this.rpc('pos_record_enrollment_failure', { p_ip: i.ip, p_enrollment_id: i.enrollmentId, p_at: iso(i.at), p_max_fails: CODE_MAX_FAILS });
  }

  async consumeEnrollment(i: Parameters<DeviceStore['consumeEnrollment']>[0]): Promise<ConsumeResult> {
    // deno-lint-ignore no-explicit-any
    const r = await this.rpc<any>('pos_consume_enrollment', {
      p_enrollment_id: i.enrollmentId,
      p_nonce: i.nonce,
      p_token_hash: i.tokenHash,
      p_existing_device_id: i.existingDeviceId,
      p_hardware_model: i.hardwareModel,
      p_app_version: i.appVersion,
      p_ip: i.ip,
      p_at: iso(i.at),
      p_max_fails: CODE_MAX_FAILS,
    });
    if (r?.ok === true) return { ok: true, device: toDevice(r.device), reenrolled: r.reenrolled === true };
    const reason = r?.reason;
    if (reason === 'expired' || reason === 'device_mismatch') return { ok: false, reason };
    return { ok: false, reason: 'not_usable' };
  }

  async replayEnrollment(i: { enrollmentId: string; nonce: string; tokenHash: string; windowMs: number; at: number }): Promise<DeviceRow | null> {
    // deno-lint-ignore no-explicit-any
    const r = await this.rpc<any>('pos_replay_enrollment', { p_enrollment_id: i.enrollmentId, p_nonce: i.nonce, p_token_hash: i.tokenHash, p_window_ms: i.windowMs, p_at: iso(i.at) });
    return r?.ok === true ? toDevice(r.device) : null;
  }

  async deviceByTokenHash(tokenHash: string): Promise<DeviceRow | null> {
    const { data, error } = await this.db.from('pos_devices').select(DEVICE_COLUMNS).eq('token_hash', tokenHash).maybeSingle();
    if (error) throw new StoreError('deviceByTokenHash', error.message);
    return data ? toDevice(data) : null;
  }

  async touchDevice(i: { deviceId: string; appVersion: string | null; throttleMs: number; at: number }): Promise<void> {
    const patch: Record<string, unknown> = { last_seen_at: iso(i.at) };
    if (i.appVersion !== null) patch.last_app_version = i.appVersion;
    const cutoff = iso(i.at - i.throttleMs);
    const { error } = await this.db.from('pos_devices').update(patch).eq('id', i.deviceId).or(`last_seen_at.is.null,last_seen_at.lt."${cutoff}"`);
    if (error) throw new StoreError('touchDevice', error.message);
  }

  async recordAuthFailed(i: { deviceId: string | null; restaurantId: string | null; code: string; capPerMinute: number; at: number }): Promise<void> {
    await this.rpc('pos_record_auth_failed', { p_device_id: i.deviceId, p_restaurant_id: i.restaurantId, p_code: i.code, p_at: iso(i.at), p_cap: i.capPerMinute });
  }

  async createEnrollment(i: Parameters<DeviceStore['createEnrollment']>[0]): Promise<CreateEnrollmentResult> {
    // deno-lint-ignore no-explicit-any
    const r = await this.rpc<any>('pos_create_enrollment', {
      p_restaurant_id: i.restaurantId,
      p_label: i.label,
      p_target_device_id: i.targetDeviceId,
      p_lookup_id: i.lookupId,
      p_secret_hash: i.secretHash,
      p_expires_at: iso(i.expiresAt),
      p_created_by: i.createdBy,
      p_at: iso(i.at),
    });
    if (r?.ok === true) return { ok: true, enrollmentId: r.enrollment_id, prefix: r.prefix, label: r.label };
    const reason = ['lookup_taken', 'unknown_device', 'unknown_restaurant', 'no_prefixes'].includes(r?.reason) ? r.reason : 'unknown_restaurant';
    return { ok: false, reason };
  }

  async revokeDevice(i: { deviceId: string; restaurantId: string | null; reason: string; actor: string; at: number }): Promise<'revoked' | 'unknown_device'> {
    const r = await this.rpc<string>('pos_revoke_device', { p_device_id: i.deviceId, p_restaurant_id: i.restaurantId, p_reason: i.reason, p_actor: i.actor, p_at: iso(i.at) });
    return r === 'revoked' ? 'revoked' : 'unknown_device';
  }

  async listDevices(restaurantId: string): Promise<DeviceRow[]> {
    const { data, error } = await this.db.from('pos_devices').select(DEVICE_COLUMNS).eq('restaurant_id', restaurantId).order('prefix', { ascending: true });
    if (error) throw new StoreError('listDevices', error.message);
    return (data ?? []).map(toDevice);
  }
}
