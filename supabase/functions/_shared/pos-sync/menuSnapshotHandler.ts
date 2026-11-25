/**
 * pos-v1-menu-snapshot handler (SYNC-CONTRACT §4, §1a; DEVICE-AUTH §4.4).
 *
 *   device middleware (401 device_unregistered / device_revoked, 403 device_mismatch)
 *   → body { restaurant_id, if_none_match } ; restaurant_id ≠ principal → 400 restaurant_mismatch
 *   → if_none_match == current hash → 200 { not_modified: true, hash }
 *   → else 200 full snapshot (persisted to pos_menu_snapshots BEFORE it is served: an order can only
 *     pin a hash the server has stored).
 *
 * CHEAP not-modified (this endpoint is also the POS's pause / auth probe, DEVICE-AUTH §7.2): the menu
 * tables have no updated_at, so "unchanged" can't be read cheaply from the DB. Each function instance
 * keeps the last built hash per restaurant for CACHE_TTL_MS. A probe whose if_none_match equals a fresh
 * cached hash is answered after the auth lookup alone — no menu reads. A stale / missing entry rebuilds
 * (8 restaurant-scoped reads), re-persists only when the hash changed, and refreshes the cache. A menu
 * edit therefore reaches registers within CACHE_TTL_MS. (A per-restaurant menu version bumped by
 * triggers would make it exact; not needed while probes back off 1 → 15 min.)
 */
import { errorResult, okResult, parseJsonObject, type DeviceRequest, type DeviceResult } from './http.ts';
import { authenticateDevice, type AuthDeps } from '../pos-device/auth.ts';
import { restaurantIdentity } from '../pos-device/identity.ts';
import { buildMenuSnapshot, SnapshotError, type MenuSnapshot, type SnapshotDb } from './menuSnapshot.ts';

export const CACHE_TTL_MS = 30_000;

export class SnapshotCache {
  private readonly m = new Map<string, { hash: string; at: number }>();
  get(restaurantId: string, now: number, ttlMs = CACHE_TTL_MS): string | null {
    const e = this.m.get(restaurantId);
    return e && now - e.at < ttlMs ? e.hash : null;
  }
  /** The last hash persisted for the restaurant by this instance (regardless of age). */
  lastPersisted(restaurantId: string): string | null {
    return this.m.get(restaurantId)?.hash ?? null;
  }
  set(restaurantId: string, hash: string, now: number): void {
    this.m.set(restaurantId, { hash, at: now });
  }
}

export interface SnapshotHandlerDeps extends AuthDeps {
  snapshotDb: SnapshotDb;
  /** insert … on conflict (hash) do nothing. Must throw on failure. */
  persist: (s: MenuSnapshot) => Promise<void>;
  cache: SnapshotCache;
}

export async function handleMenuSnapshot(req: DeviceRequest, deps: SnapshotHandlerDeps): Promise<DeviceResult> {
  const a = await authenticateDevice(req.headers, deps);
  if (!a.ok) return a.result;
  const parsed = parseJsonObject(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const bad = restaurantIdentity(body, a.principal);
  if (bad) return bad;
  const ifNoneMatch = body.if_none_match ?? null;
  if (ifNoneMatch !== null && typeof ifNoneMatch !== 'string') {
    return errorResult(400, 'invalid_payload', 'if_none_match must be a string or null', { field: 'if_none_match' });
  }
  const rid = a.principal.restaurant_id;
  const nowMs = deps.now();

  // cheap path: a fresh cached hash that matches
  const cached = deps.cache.get(rid, nowMs);
  if (cached !== null && ifNoneMatch === cached) return okResult({ not_modified: true, hash: cached });

  let snap: MenuSnapshot;
  try {
    snap = await buildMenuSnapshot(deps.snapshotDb, rid, new Date(nowMs));
  } catch (err) {
    if (err instanceof SnapshotError) {
      deps.log('snapshot_failed', { restaurant_id: rid, code: err.code, field: err.field });
      if (err.code === 'restaurant_not_found') return errorResult(400, 'restaurant_mismatch', 'unknown restaurant');
      return errorResult(500, 'snapshot_config_invalid', err.message, err.field ? { field: err.field } : {});
    }
    throw err;
  }
  if (deps.cache.lastPersisted(rid) !== snap.hash) await deps.persist(snap);
  deps.cache.set(rid, snap.hash, nowMs);
  if (ifNoneMatch === snap.hash) return okResult({ not_modified: true, hash: snap.hash });
  return okResult(snap);
}

/** Supabase persistence (service role): immutable, keyed by hash. */
// deno-lint-ignore no-explicit-any
export function supabasePersistSnapshot(client: { from(table: string): any }) {
  return async (s: MenuSnapshot): Promise<void> => {
    const { error } = await client
      .from('pos_menu_snapshots')
      .upsert({ hash: s.hash, restaurant_id: s.restaurant.id, body: s }, { onConflict: 'hash', ignoreDuplicates: true });
    if (error) throw new Error(`pos_menu_snapshots insert failed: ${error.message}`);
  };
}
