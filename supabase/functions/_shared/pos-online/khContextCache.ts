/**
 * The KitchenHub mapping context's reads (pos_kitchenhub_item_maps + menu_items + menu_categories), cached per
 * restaurant for 30 s per function instance — the FeedMenuHash pattern (menuHash.ts):
 *   - hit (built < 30 s ago AND the same maps revision)  → 0 queries
 *   - miss                                               → 3 restaurant-scoped reads, in parallel
 *   - concurrent requests on a miss share ONE build (in-flight per restaurant + revision)
 *   - a FAILED build (e.g. 117 not applied: the maps table is missing) is remembered for 30 s → null (lines served
 *     unmapped), logged ONCE per 30 s, 0 queries meanwhile — never a failed poll
 *
 * Freshness (Matt, CP21 follow-up): the cache key includes pos_restaurant_settings.kitchenhub_maps_rev — 117's
 * pos_kitchenhub_item_map_change bumps it in the SAME transaction as every applied set / clear, and the feed already
 * reads that settings row on every poll (getSettings, select *), so a map change from pos-v1-kitchenhub-items takes
 * effect on the NEXT poll at zero extra queries. The fallback category is NOT cached (it comes from that same fresh
 * settings row). Menu edits (an item moved / deleted in admin) show within ≤ 30 s — the same window as the feed's
 * menu_snapshot_hash.
 */
import type { ItemMapRow } from './khItems.ts';

export const KH_CONTEXT_TTL_MS = 30_000;

export interface KhContextData {
  maps: ItemMapRow[];
  items: { id: string; category_id: string | null }[];
  categories: { id: string }[];
}

type Log = (event: string, data?: Record<string, unknown>) => void;

export class KhContextCache {
  private readonly cache = new Map<string, { at: number; rev: number; data: KhContextData }>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Map<string, { rev: number; p: Promise<KhContextData | null> }>();
  /** Builds started by this instance (tests / the query count). */
  builds = 0;

  constructor(private readonly ttlMs = KH_CONTEXT_TTL_MS) {}

  get(restaurantId: string, rev: number, nowMs: number, load: () => Promise<KhContextData>, log: Log): Promise<KhContextData | null> {
    const hit = this.cache.get(restaurantId);
    if (hit && hit.rev === rev && nowMs - hit.at < this.ttlMs) return Promise.resolve(hit.data);
    // a failure is remembered by time only (not revision): the read error is logged at most once per 30 s
    const failed = this.failedAt.get(restaurantId);
    if (failed !== undefined && nowMs - failed < this.ttlMs) return Promise.resolve(null);
    const running = this.inflight.get(restaurantId);
    if (running && running.rev === rev) return running.p;
    this.builds += 1;
    const slot: { rev: number; p: Promise<KhContextData | null> } = { rev, p: Promise.resolve(null) };
    slot.p = (async () => {
      try {
        const data = await load();
        this.cache.set(restaurantId, { at: nowMs, rev, data });
        this.failedAt.delete(restaurantId);
        return data;
      } catch (err) {
        this.failedAt.set(restaurantId, nowMs);
        try {
          log('online_kh_mapping_unavailable', { restaurant_id: restaurantId, error: err instanceof Error ? err.message : String(err) });
        } catch {
          // a broken logger must never break a poll
        }
        return null;
      } finally {
        if (this.inflight.get(restaurantId) === slot) this.inflight.delete(restaurantId);
      }
    })();
    this.inflight.set(restaurantId, slot);
    return slot.p;
  }
}
