/**
 * Staff persistence (migration 105). Two interfaces, two implementations with the SAME rules:
 *  - StaffStore (device functions): snapshot source + publication, flag context, staff events.
 *  - StaffAdminStore (scripts/pos-staff.ts): add / set-pin / deactivate / settings — each ONE plpgsql call
 *    (pos_staff_add, pos_staff_set_pin, pos_staff_deactivate, pos_staff_set_settings) that locks the
 *    restaurant, bumps the version and refuses leaving it without an active manager once PINs are on.
 *  - MemoryStaffStore mirrors the plpgsql step by step (tests); PgStaffStore = supabase-js, service role.
 */
import { DEFAULT_KDF, type KdfParams } from './kdf.ts';
import type { StaffContext } from './flags.ts';
import type { StaffRole, StaffSettingsWire, StaffSnapshot, StaffSource } from './snapshot.ts';

export interface PublishedStaffSnapshot {
  version: number;
  hash: string;
  /** Without server_time. */
  body: Omit<StaffSnapshot, 'server_time'>;
  published_at: number;
}

export interface StoredStaffEvent {
  restaurant_id: string;
  content_hash: string;
  response: Record<string, unknown>;
}

export interface StaffEventRow {
  event_id: string;
  restaurant_id: string;
  device_id: string;
  payload: Record<string, unknown>;
  content_hash: string;
  flags: Record<string, unknown>;
  response: Record<string, unknown>;
  received_at: string;
}

export interface StaffStore {
  /** Rows at one version; null when the restaurant has no staff configured. */
  source(restaurantId: string): Promise<StaffSource | null>;
  latestPublished(restaurantId: string): Promise<PublishedStaffSnapshot | null>;
  /** insert … on conflict (restaurant_id, version) do nothing. */
  publish(restaurantId: string, s: Omit<StaffSnapshot, 'server_time'>, at: number): Promise<void>;
  context(restaurantId: string): Promise<StaffContext>;
  getEvent(eventId: string): Promise<StoredStaffEvent | null>;
  /** false = the event id already existed (a concurrent insert won). */
  insertEvent(row: StaffEventRow): Promise<boolean>;
}

export type AdminResult = { ok: true; staff_id: string; version: number } | { ok: false; reason: 'not_found' | 'last_active_manager' | 'kdf_changed' | 'invalid' };

export interface StaffListRow { id: string; name: string; role: StaffRole; active: boolean; sort_order: number }

export interface StaffAdminStore {
  restaurantBySlug(slug: string): Promise<{ id: string; name: string } | null>;
  staffById(id: string): Promise<(StaffListRow & { restaurant_id: string }) | null>;
  /** Current settings (defaults when none yet). */
  settings(restaurantId: string): Promise<StaffSettingsWire>;
  add(restaurantId: string, name: string, role: StaffRole, saltHex: string, hashHex: string, kdf: KdfParams): Promise<AdminResult>;
  setPin(staffId: string, saltHex: string, hashHex: string, kdf: KdfParams): Promise<AdminResult>;
  deactivate(staffId: string): Promise<AdminResult>;
  /** Already active → ok at the current version (no bump). */
  reactivate(staffId: string): Promise<AdminResult>;
  setSettings(restaurantId: string, patch: { auto_lock_minutes?: number; over_short_approval_cents?: number; z_requires_manager?: boolean }): Promise<AdminResult>;
  list(restaurantId: string): Promise<StaffListRow[]>;
}

export const DEFAULT_SETTINGS: StaffSettingsWire = { auto_lock_minutes: 5, over_short_approval_cents: 500, z_requires_manager: true, pin_kdf: DEFAULT_KDF };

const sameKdf = (a: KdfParams, b: KdfParams) => a.alg === b.alg && a.n === b.n && a.r === b.r && a.p === b.p && a.dk_len === b.dk_len;

// ---- memory (tests) ------------------------------------------------------------------------------

interface MemStaff { id: string; restaurant_id: string; name: string; role: StaffRole; active: boolean; sort_order: number; salt: string; hash: string; kdf: KdfParams }
interface MemSettings extends StaffSettingsWire { version: number; pins_on: boolean }

export class MemoryStaffStore implements StaffStore, StaffAdminStore {
  readonly staff = new Map<string, MemStaff>();
  readonly settingsRows = new Map<string, MemSettings>();
  readonly published = new Map<string, PublishedStaffSnapshot[]>();
  readonly events = new Map<string, StaffEventRow>();
  readonly restaurants = new Map<string, { id: string; name: string }>();

  // device side
  source(restaurantId: string): Promise<StaffSource | null> {
    const st = this.settingsRows.get(restaurantId);
    const rows = [...this.staff.values()].filter((s) => s.restaurant_id === restaurantId);
    if (!st || rows.length === 0) return Promise.resolve(null);
    const { version, pins_on: _p, ...settings } = st;
    return Promise.resolve(structuredClone({ version, settings, staff: rows.map((s) => ({ id: s.id, name: s.name, role: s.role, active: s.active, sort_order: s.sort_order, pin: { salt: s.salt, hash: s.hash }, kdf: s.kdf })) }));
  }
  latestPublished(restaurantId: string): Promise<PublishedStaffSnapshot | null> {
    const l = this.published.get(restaurantId) ?? [];
    return Promise.resolve(l.length ? structuredClone(l[l.length - 1]) : null);
  }
  publish(restaurantId: string, s: Omit<StaffSnapshot, 'server_time'>, at: number): Promise<void> {
    const l = this.published.get(restaurantId) ?? [];
    if (!l.some((x) => x.version === s.version)) {
      l.push({ version: s.version, hash: s.hash, body: structuredClone(s), published_at: at });
      l.sort((a, b) => a.version - b.version);
    }
    this.published.set(restaurantId, l);
    return Promise.resolve();
  }
  context(restaurantId: string): Promise<StaffContext> {
    const l = this.published.get(restaurantId) ?? [];
    return Promise.resolve({
      firstPublishedAt: l.length ? Math.min(...l.map((x) => x.published_at)) : null,
      roles: new Map([...this.staff.values()].filter((s) => s.restaurant_id === restaurantId).map((s) => [s.id, s.role])),
      settingsHistory: [...l].sort((a, b) => a.published_at - b.published_at).map((x) => ({ publishedAt: x.published_at, settings: structuredClone(x.body.settings) })),
    });
  }
  getEvent(eventId: string): Promise<StoredStaffEvent | null> {
    const e = this.events.get(eventId);
    return Promise.resolve(e ? structuredClone({ restaurant_id: e.restaurant_id, content_hash: e.content_hash, response: e.response }) : null);
  }
  insertEvent(row: StaffEventRow): Promise<boolean> {
    if (this.events.has(row.event_id)) return Promise.resolve(false);
    this.events.set(row.event_id, structuredClone(row));
    return Promise.resolve(true);
  }

  // admin side (mirrors the plpgsql in 105)
  restaurantBySlug(slug: string) { return Promise.resolve(this.restaurants.get(slug) ?? null); }
  staffById(id: string) {
    const s = this.staff.get(id);
    return Promise.resolve(s ? { id: s.id, restaurant_id: s.restaurant_id, name: s.name, role: s.role, active: s.active, sort_order: s.sort_order } : null);
  }
  private ensureSettings(rid: string): MemSettings {
    let st = this.settingsRows.get(rid);
    if (!st) {
      st = { ...structuredClone(DEFAULT_SETTINGS), version: 0, pins_on: false };
      this.settingsRows.set(rid, st);
    }
    return st;
  }
  private bump(rid: string): number {
    const st = this.ensureSettings(rid);
    st.version += 1;
    if ([...this.staff.values()].some((s) => s.restaurant_id === rid && s.role === 'manager' && s.active)) st.pins_on = true;
    return st.version;
  }
  settings(restaurantId: string): Promise<StaffSettingsWire> {
    const st = this.settingsRows.get(restaurantId);
    if (!st) return Promise.resolve(structuredClone(DEFAULT_SETTINGS));
    const { version: _v, pins_on: _p, ...s } = st;
    return Promise.resolve(structuredClone(s));
  }
  add(restaurantId: string, name: string, role: StaffRole, saltHex: string, hashHex: string, kdf: KdfParams): Promise<AdminResult> {
    const st = this.ensureSettings(restaurantId);
    if (!sameKdf(st.pin_kdf, kdf)) return Promise.resolve({ ok: false, reason: 'kdf_changed' });
    const sort = Math.max(0, ...[...this.staff.values()].filter((s) => s.restaurant_id === restaurantId).map((s) => s.sort_order)) + 1;
    const id = crypto.randomUUID();
    this.staff.set(id, { id, restaurant_id: restaurantId, name, role, active: true, sort_order: sort, salt: saltHex, hash: hashHex, kdf: structuredClone(kdf) });
    return Promise.resolve({ ok: true, staff_id: id, version: this.bump(restaurantId) });
  }
  setPin(staffId: string, saltHex: string, hashHex: string, kdf: KdfParams): Promise<AdminResult> {
    const s = this.staff.get(staffId);
    if (!s) return Promise.resolve({ ok: false, reason: 'not_found' });
    if (!sameKdf(this.ensureSettings(s.restaurant_id).pin_kdf, kdf)) return Promise.resolve({ ok: false, reason: 'kdf_changed' });
    Object.assign(s, { salt: saltHex, hash: hashHex, kdf: structuredClone(kdf) });
    return Promise.resolve({ ok: true, staff_id: staffId, version: this.bump(s.restaurant_id) });
  }
  deactivate(staffId: string): Promise<AdminResult> {
    const s = this.staff.get(staffId);
    if (!s) return Promise.resolve({ ok: false, reason: 'not_found' });
    const st = this.ensureSettings(s.restaurant_id);
    const managersLeft = [...this.staff.values()].filter((x) => x.restaurant_id === s.restaurant_id && x.id !== s.id && x.role === 'manager' && x.active).length;
    if (st.pins_on && managersLeft === 0) return Promise.resolve({ ok: false, reason: 'last_active_manager' });
    s.active = false;
    return Promise.resolve({ ok: true, staff_id: staffId, version: this.bump(s.restaurant_id) });
  }
  reactivate(staffId: string): Promise<AdminResult> {
    const s = this.staff.get(staffId);
    if (!s) return Promise.resolve({ ok: false, reason: 'not_found' });
    const st = this.ensureSettings(s.restaurant_id);
    if (s.active) return Promise.resolve({ ok: true, staff_id: staffId, version: st.version });
    s.active = true;
    return Promise.resolve({ ok: true, staff_id: staffId, version: this.bump(s.restaurant_id) });
  }
  setSettings(restaurantId: string, patch: { auto_lock_minutes?: number; over_short_approval_cents?: number; z_requires_manager?: boolean }): Promise<AdminResult> {
    Object.assign(this.ensureSettings(restaurantId), patch);
    return Promise.resolve({ ok: true, staff_id: '', version: this.bump(restaurantId) });
  }
  list(restaurantId: string): Promise<StaffListRow[]> {
    return Promise.resolve([...this.staff.values()].filter((s) => s.restaurant_id === restaurantId).sort((a, b) => a.sort_order - b.sort_order).map((s) => ({ id: s.id, name: s.name, role: s.role, active: s.active, sort_order: s.sort_order })));
  }
}

// ---- Postgres (service role) ---------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Client = { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any };

export class PgStaffStore implements StaffStore, StaffAdminStore {
  constructor(private readonly db: Client) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data as T;
  }

  source(restaurantId: string): Promise<StaffSource | null> {
    return this.rpc<StaffSource | null>('pos_staff_snapshot_source', { p_restaurant_id: restaurantId });
  }

  async latestPublished(restaurantId: string): Promise<PublishedStaffSnapshot | null> {
    const { data, error } = await this.db
      .from('pos_staff_snapshots')
      .select('version, hash, body, published_at')
      .eq('restaurant_id', restaurantId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`pos_staff_snapshots read failed: ${error.message}`);
    return data ? { version: data.version, hash: data.hash, body: data.body, published_at: Date.parse(data.published_at) } : null;
  }

  async publish(restaurantId: string, s: Omit<StaffSnapshot, 'server_time'>, at: number): Promise<void> {
    const { error } = await this.db
      .from('pos_staff_snapshots')
      .upsert({ restaurant_id: restaurantId, version: s.version, hash: s.hash, body: s, published_at: new Date(at).toISOString() }, { onConflict: 'restaurant_id,version', ignoreDuplicates: true });
    if (error) throw new Error(`pos_staff_snapshots insert failed: ${error.message}`);
  }

  async context(restaurantId: string): Promise<StaffContext> {
    const [snaps, staff] = await Promise.all([
      this.db.from('pos_staff_snapshots').select('published_at, settings:body->settings').eq('restaurant_id', restaurantId).order('published_at', { ascending: true }),
      this.db.from('pos_staff').select('id, role').eq('restaurant_id', restaurantId),
    ]);
    if (snaps.error) throw new Error(`pos_staff_snapshots read failed: ${snaps.error.message}`);
    if (staff.error) throw new Error(`pos_staff read failed: ${staff.error.message}`);
    const hist = (snaps.data as { published_at: string; settings: StaffSettingsWire }[]).map((r) => ({ publishedAt: Date.parse(r.published_at), settings: r.settings }));
    return {
      firstPublishedAt: hist.length ? hist[0].publishedAt : null,
      roles: new Map((staff.data as { id: string; role: StaffRole }[]).map((r) => [r.id, r.role])),
      settingsHistory: hist,
    };
  }

  async getEvent(eventId: string): Promise<StoredStaffEvent | null> {
    const { data, error } = await this.db.from('pos_staff_events').select('restaurant_id, content_hash, response').eq('event_id', eventId).maybeSingle();
    if (error) throw new Error(`pos_staff_events read failed: ${error.message}`);
    return data ?? null;
  }

  async insertEvent(row: StaffEventRow): Promise<boolean> {
    const p = row.payload as Record<string, unknown>;
    const { data, error } = await this.db
      .from('pos_staff_events')
      .upsert({
        event_id: row.event_id, restaurant_id: row.restaurant_id, device_id: row.device_id, type: p.type,
        staff_id: p.staff_id, by_staff_id: p.by_staff_id, purpose: p.purpose, target_id: p.target_id,
        created_at: p.created_at, device_time: p.device_time, content_hash: row.content_hash, payload: row.payload,
        flags: row.flags, response: row.response, received_at: row.received_at,
      }, { onConflict: 'event_id', ignoreDuplicates: true })
      .select('event_id');
    if (error) throw new Error(`pos_staff_events insert failed: ${error.message}`);
    return Array.isArray(data) && data.length === 1;
  }

  // admin
  async restaurantBySlug(slug: string) {
    const { data, error } = await this.db.from('restaurants').select('id, name').eq('slug', slug).maybeSingle();
    if (error) throw new Error(`restaurants read failed: ${error.message}`);
    return data ?? null;
  }
  async staffById(id: string) {
    const { data, error } = await this.db.from('pos_staff').select('id, restaurant_id, name, role, active, sort_order').eq('id', id).maybeSingle();
    if (error) throw new Error(`pos_staff read failed: ${error.message}`);
    return data ?? null;
  }
  async settings(restaurantId: string): Promise<StaffSettingsWire> {
    const { data, error } = await this.db.from('pos_staff_settings').select('auto_lock_minutes, over_short_approval_cents, z_requires_manager, pin_kdf').eq('restaurant_id', restaurantId).maybeSingle();
    if (error) throw new Error(`pos_staff_settings read failed: ${error.message}`);
    return data ?? structuredClone(DEFAULT_SETTINGS);
  }
  add(restaurantId: string, name: string, role: StaffRole, saltHex: string, hashHex: string, kdf: KdfParams) {
    return this.rpc<AdminResult>('pos_staff_add', { p_restaurant_id: restaurantId, p_name: name, p_role: role, p_pin_salt: saltHex, p_pin_hash: hashHex, p_kdf: kdf });
  }
  setPin(staffId: string, saltHex: string, hashHex: string, kdf: KdfParams) {
    return this.rpc<AdminResult>('pos_staff_set_pin', { p_staff_id: staffId, p_pin_salt: saltHex, p_pin_hash: hashHex, p_kdf: kdf });
  }
  deactivate(staffId: string) {
    return this.rpc<AdminResult>('pos_staff_deactivate', { p_staff_id: staffId });
  }
  reactivate(staffId: string) {
    return this.rpc<AdminResult>('pos_staff_reactivate', { p_staff_id: staffId });
  }
  setSettings(restaurantId: string, patch: { auto_lock_minutes?: number; over_short_approval_cents?: number; z_requires_manager?: boolean }) {
    return this.rpc<AdminResult>('pos_staff_set_settings', {
      p_restaurant_id: restaurantId,
      p_auto_lock_minutes: patch.auto_lock_minutes ?? null,
      p_over_short_approval_cents: patch.over_short_approval_cents ?? null,
      p_z_requires_manager: patch.z_requires_manager ?? null,
    });
  }
  async list(restaurantId: string): Promise<StaffListRow[]> {
    // names / roles / active only — never salts or hashes
    const { data, error } = await this.db.from('pos_staff').select('id, name, role, active, sort_order').eq('restaurant_id', restaurantId).order('sort_order');
    if (error) throw new Error(`pos_staff read failed: ${error.message}`);
    return data;
  }
}
