/**
 * Staff snapshot (ordr-pos SYNC-CONTRACT §3b, STAFF.md §4.1; src/sync/contract.ts StaffSnapshot).
 *
 * The body is built from pos_staff + pos_staff_settings at ONE version (read in one statement by
 * pos_staff_snapshot_source, migration 105), hashed with canonical JSON (§7) excluding hash /
 * server_time, and persisted in pos_staff_snapshots (restaurant_id, version) — "published". The first
 * published_at per restaurant is the register_actor_after_staff boundary; the history gives the
 * settings in effect at a row's time.
 */
import { contentHash } from '../pos-sync/canonicalJson.ts';
import { validKdf, type KdfParams } from './kdf.ts';

export const STAFF_SNAPSHOT_HASH_EXCLUDES = ['hash', 'server_time'] as const;

export type StaffRole = 'manager' | 'staff' | 'driver';

export interface StaffSettingsWire {
  auto_lock_minutes: number;
  over_short_approval_cents: number;
  z_requires_manager: boolean;
  pin_kdf: KdfParams;
}

export interface WireStaff {
  id: string;
  name: string;
  role: StaffRole;
  active: boolean;
  sort_order: number;
  pin: { salt: string; hash: string };
}

export interface StaffSnapshot {
  restaurant_id: string;
  version: number;
  hash: string;
  settings: StaffSettingsWire;
  staff: WireStaff[];
  server_time: string;
}

/** What pos_staff_snapshot_source returns (rows at one version). */
export interface StaffSource {
  version: number;
  settings: StaffSettingsWire;
  staff: (WireStaff & { kdf: KdfParams })[];
}

export class StaffConfigError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'StaffConfigError';
  }
}

const sameKdf = (a: KdfParams, b: KdfParams) => a.alg === b.alg && a.n === b.n && a.r === b.r && a.p === b.p && a.dk_len === b.dk_len;

/** Source → snapshot body + hash (server_time added by the caller at serve time). */
export async function buildStaffSnapshot(restaurantId: string, src: StaffSource): Promise<Omit<StaffSnapshot, 'server_time'>> {
  if (!validKdf(src.settings.pin_kdf)) throw new StaffConfigError('pos_staff_settings.pin_kdf is not a valid scrypt config', 'pos_staff_settings.pin_kdf');
  const staff = [...src.staff].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of staff) {
    // the device verifies every PIN with settings.pin_kdf — a hash made with other params can never match
    if (!sameKdf(s.kdf, src.settings.pin_kdf)) throw new StaffConfigError(`staff ${s.id}: PIN hashed with other kdf params than pin_kdf — set the PIN again`, `pos_staff(${s.id}).kdf`);
    if (!/^[0-9a-f]{32}$/.test(s.pin.salt) || !/^[0-9a-f]+$/.test(s.pin.hash) || s.pin.hash.length !== src.settings.pin_kdf.dk_len * 2) {
      throw new StaffConfigError(`staff ${s.id}: salt / hash are not hex of the right length`, `pos_staff(${s.id}).pin`);
    }
  }
  const body = {
    restaurant_id: restaurantId,
    version: src.version,
    settings: {
      auto_lock_minutes: src.settings.auto_lock_minutes,
      over_short_approval_cents: src.settings.over_short_approval_cents,
      z_requires_manager: src.settings.z_requires_manager,
      pin_kdf: { alg: 'scrypt' as const, n: src.settings.pin_kdf.n, r: src.settings.pin_kdf.r, p: src.settings.pin_kdf.p, dk_len: src.settings.pin_kdf.dk_len },
    },
    staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, active: s.active, sort_order: s.sort_order, pin: { salt: s.pin.salt, hash: s.pin.hash } })),
  };
  return { ...body, hash: await contentHash(body as unknown as Record<string, unknown>, STAFF_SNAPSHOT_HASH_EXCLUDES) };
}

/** True when the list has at least one active manager (PINs on — STAFF.md §8). */
export const hasActiveManager = (staff: readonly { role: string; active: boolean }[]): boolean => staff.some((s) => s.role === 'manager' && s.active);
