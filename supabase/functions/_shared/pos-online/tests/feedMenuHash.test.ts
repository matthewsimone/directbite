/**
 * pos-v1-online-orders' menu_snapshot_hash (§3c:517-518) — pos-v1-menu-snapshot's own builder behind the 30 s
 * per-restaurant cache (menuHash.ts). Query count per poll: cache hit 0, miss 8 (one build); a failed build → null,
 * logged, remembered for 30 s (0 queries meanwhile), never a failed poll; concurrent polls share one build; the hash
 * is NOT part of the not-modified token (§3c:507-508, :489-490).
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { ok, R1 } from '../../pos-device/tests/harness.ts';
import { buildMenuSnapshot, type SnapshotDb } from '../../pos-sync/menuSnapshot.ts';
import { CACHE_TTL_MS } from '../../pos-sync/menuSnapshotHandler.ts';
import { FeedMenuHash } from '../menuHash.ts';
import { ordrRow, snapshotDbOf, world } from './world.ts';

type Poll = { not_modified: boolean; orders: unknown[]; token: string; menu_snapshot_hash: string | null };

/** The world's SnapshotDb with every read counted (= the queries a build makes). */
function counted(db: SnapshotDb) {
  let queries = 0;
  const wrap = <K extends keyof SnapshotDb>(k: K) => ((...a: unknown[]) => {
    queries += 1;
    return (db[k] as (...x: unknown[]) => unknown)(...a);
  }) as SnapshotDb[K];
  const c: SnapshotDb = {
    getRestaurant: wrap('getRestaurant'), getCategories: wrap('getCategories'), getItems: wrap('getItems'), getItemSizes: wrap('getItemSizes'),
    getToppingGroups: wrap('getToppingGroups'), getToppings: wrap('getToppings'), getItemToppingGroups: wrap('getItemToppingGroups'),
    getActivePromotions: wrap('getActivePromotions'),
  };
  return { db: c, take: () => { const q = queries; queries = 0; return q; } };
}

async function feedWorld() {
  const w = await world();
  w.db.insertRow('menu_categories', { id: 'c0000000-0000-4000-8000-0000000000c1', restaurant_id: R1, name: 'Pizza', sort_order: 0 });
  w.db.insertRow('menu_items', { id: 'c0000000-0000-4000-8000-0000000000a2', restaurant_id: R1, category_id: 'c0000000-0000-4000-8000-0000000000c1', name: 'Garlic Knots', is_available: true, sort_order: 0 });
  const q = counted(snapshotDbOf(w));
  const mh = new FeedMenuHash(q.db);
  w.deps.menuHash = mh;
  const expected = async () => (await buildMenuSnapshot(snapshotDbOf(w), R1, new Date(w.h.clock.now()))).hash;
  return { w, q, mh, expected };
}

Deno.test('the feed serves the current menu snapshot hash; query count per poll: miss = 8 (one build), hit within 30 s = 0; rebuilt after 30 s', async () => {
  const { w, q, mh, expected } = await feedWorld();
  const p1 = ok<Poll>(await w.poll());
  assertEquals(p1.menu_snapshot_hash, await expected());
  assertEquals(q.take(), 8, 'miss: one build = 8 restaurant-scoped reads');
  w.h.clock.advance(CACHE_TTL_MS - 1);
  assertEquals(ok<Poll>(await w.poll()).menu_snapshot_hash, p1.menu_snapshot_hash);
  assertEquals(q.take(), 0, 'hit: no menu query');
  w.h.clock.advance(1);
  ok<Poll>(await w.poll());
  assertEquals([q.take(), mh.builds], [8, 2], 'stale after 30 s → one rebuild');
});

Deno.test('an 86 shows within ≤ 30 s (the cache) + a poll: the hash changes; the token does NOT (same orders → not_modified, orders [], the new hash)', async () => {
  const { w, expected } = await feedWorld();
  w.db.insertRow('orders', ordrRow(w.nowIso()));
  const p1 = ok<Poll>(await w.poll());
  const s = ok<{ menu_snapshot_hash: string }>(await w.settings({ kind: 'item_availability', item_id: 'c0000000-0000-4000-8000-0000000000a2', available: false }));
  const cached = ok<Poll>(await w.poll({ if_none_match: p1.token }));
  assertEquals(cached.menu_snapshot_hash, p1.menu_snapshot_hash, 'within 30 s: the cached hash');
  w.h.clock.advance(CACHE_TTL_MS);
  const p2 = ok<Poll>(await w.poll({ if_none_match: p1.token }));
  assertEquals([p2.not_modified, p2.orders, p2.token], [true, [], p1.token], 'orders unchanged → not_modified (the hash is not in the token)');
  assertEquals(p2.menu_snapshot_hash, await expected());
  assertNotEquals(p2.menu_snapshot_hash, p1.menu_snapshot_hash);
  assertEquals(p2.menu_snapshot_hash, s.menu_snapshot_hash, 'the same hash the 86 answer gave this register');
});

Deno.test('a failed build → null + one log line, the poll is 200; remembered for 30 s (0 queries); retried after — and recovers', async () => {
  const { w, expected } = await feedWorld();
  let broken = true;
  const base = snapshotDbOf(w);
  const db: SnapshotDb = { ...base, getItems: (rid) => (broken ? Promise.reject(new Error('menu_items read failed')) : base.getItems(rid)) };
  const mh = new FeedMenuHash(db);
  w.deps.menuHash = mh;
  const before = w.h.logs.length;
  assertEquals(ok<Poll>(await w.poll()).menu_snapshot_hash, null);
  assertEquals(w.h.logs.slice(before).filter((l) => l.includes('online_feed_menu_hash_failed')).length, 1);
  w.h.clock.advance(CACHE_TTL_MS - 1);
  assertEquals(ok<Poll>(await w.poll()).menu_snapshot_hash, null);
  assertEquals(mh.builds, 1, 'not rebuilt within 30 s of the failure');
  w.h.clock.advance(1);
  broken = false;
  assertEquals(ok<Poll>(await w.poll()).menu_snapshot_hash, await expected(), 'retried after 30 s, and recovered');
  assertEquals(mh.builds, 2);
});

Deno.test('concurrent polls on a miss share ONE build; history polls carry the hash too; no menuHash dep → null', async () => {
  const { w, q, mh } = await feedWorld();
  const [a, b, c] = await Promise.all([w.poll(), w.poll(), w.poll({ history: { business_date: '2026-11-18' } })]);
  const hashes = [a, b, c].map((r) => ok<Poll>(r).menu_snapshot_hash);
  assert(hashes[0] !== null && hashes.every((h) => h === hashes[0]));
  assertEquals([mh.builds, q.take()], [1, 8]);
  w.deps.menuHash = undefined;
  assertEquals(ok<Poll>(await w.poll()).menu_snapshot_hash, null);
});
