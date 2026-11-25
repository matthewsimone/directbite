/**
 * pos-v1-online-orders' `menu_snapshot_hash` (§3c:517-518: the current menu snapshot's hash — an 86 on another
 * register / the tablet shows within a poll; the POS pulls pos-v1-menu-snapshot when it differs, ordr-pos
 * onlineFeed.ts :371).
 *
 * Built by pos-v1-menu-snapshot's OWN builder (_shared/pos-sync/menuSnapshot.ts buildMenuSnapshot — the same hash a
 * pull answers) behind the same 30 s per-restaurant cache (menuSnapshotHandler.ts SnapshotCache, CACHE_TTL_MS), so a
 * function instance rebuilds a restaurant's menu at most once per 30 s:
 *   - cache hit (a hash built < 30 s ago)   → 0 extra queries
 *   - cache miss                            → 1 build = 8 restaurant-scoped reads (restaurants + menu_categories +
 *                                             menu_items + item_sizes + topping_groups + toppings +
 *                                             item_topping_groups + promotions; menuSnapshot.ts :204-212)
 *   - a FAILED build is remembered for 30 s too (→ null, logged once per 30 s, 0 queries meanwhile)
 *   - concurrent polls on a miss share ONE build (in-flight promise per restaurant)
 * Never throws: on any failure the feed serves null (no hint) — never a failed poll.
 * Not persisted to pos_menu_snapshots here: the register's pull (pos-v1-menu-snapshot) builds + persists before it
 * serves. Not part of the feed's not-modified token (§3c:507-508: the token is about the orders; the hash travels on
 * every answer, not_modified or not, §3c:489-490).
 */
import { buildMenuSnapshot, SnapshotError, type SnapshotDb } from '../pos-sync/menuSnapshot.ts';
import { CACHE_TTL_MS, SnapshotCache } from '../pos-sync/menuSnapshotHandler.ts';

export class FeedMenuHash {
  private readonly cache = new SnapshotCache();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** Builds started by this instance (tests / the query count). */
  builds = 0;

  constructor(private readonly db: SnapshotDb, private readonly ttlMs = CACHE_TTL_MS) {}

  get(restaurantId: string, nowMs: number, log: (event: string, data?: Record<string, unknown>) => void): Promise<string | null> {
    const hit = this.cache.get(restaurantId, nowMs, this.ttlMs);
    if (hit !== null) return Promise.resolve(hit);
    const failed = this.failedAt.get(restaurantId);
    if (failed !== undefined && nowMs - failed < this.ttlMs) return Promise.resolve(null);
    const running = this.inflight.get(restaurantId);
    if (running) return running;
    this.builds += 1;
    const p = (async () => {
      try {
        const snap = await buildMenuSnapshot(this.db, restaurantId, new Date(nowMs));
        this.cache.set(restaurantId, snap.hash, nowMs);
        this.failedAt.delete(restaurantId);
        return snap.hash;
      } catch (err) {
        this.failedAt.set(restaurantId, nowMs);
        try {
          log('online_feed_menu_hash_failed', {
            restaurant_id: restaurantId,
            code: err instanceof SnapshotError ? err.code : 'error',
            field: err instanceof SnapshotError ? (err.field ?? null) : null,
          });
        } catch {
          // a broken logger must never break a poll
        }
        return null;
      } finally {
        this.inflight.delete(restaurantId);
      }
    })();
    this.inflight.set(restaurantId, p);
    return p;
  }
}
