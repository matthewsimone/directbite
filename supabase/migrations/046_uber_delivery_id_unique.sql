-- ============================================================================
-- Migration 046: enforce uniqueness of orders.uber_delivery_id
-- ============================================================================
--
-- Problem: orders.uber_delivery_id (migration 031) has no uniqueness
-- constraint. The uber-webhook handler routes every inbound event by
--   SELECT ... FROM orders WHERE uber_delivery_id = <delivery_id> ... maybeSingle()
-- If two rows ever shared a delivery_id (duplicate booking, a re-dispatched
-- orphan, a manual data fix), maybeSingle() raises on multiple rows -> the
-- handler 500s -> Uber retries with backoff -> the event is never processed.
-- Uber delivery IDs are globally unique, so the DB should enforce that too.
--
-- Fix: a PARTIAL UNIQUE index on uber_delivery_id, scoped to non-NULL values.
-- Most orders are non-Uber or not-yet-dispatched and carry NULL here; the
-- WHERE clause keeps all those NULL rows out of the index so any number of
-- them coexist, while every real delivery_id is forced unique.
--
-- Locking: this uses a plain CREATE UNIQUE INDEX, which takes a brief
-- ACCESS EXCLUSIVE lock on orders for the duration of the build. orders is
-- small, so the lock is sub-second. CREATE UNIQUE INDEX CONCURRENTLY would
-- avoid the lock, but it cannot run inside a transaction block; if this
-- project's migration runner wraps each file in a transaction, CONCURRENTLY
-- would fail outright. The plain form applies cleanly under either runner
-- mode. If you later confirm the runner applies migrations OUTSIDE a
-- transaction and want zero lock, swap the statement below for:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_uber_delivery_id_unique
--     ON orders (uber_delivery_id) WHERE uber_delivery_id IS NOT NULL;
--
-- Idempotent: IF NOT EXISTS makes re-runs a no-op.
--
-- Precondition: if any duplicate non-NULL uber_delivery_id values already
-- exist, this index build will fail. Detect them first with:
--   SELECT uber_delivery_id, count(*) FROM orders
--   WHERE uber_delivery_id IS NOT NULL
--   GROUP BY uber_delivery_id HAVING count(*) > 1;
-- (Expected: zero rows.)
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_uber_delivery_id_unique
  ON orders (uber_delivery_id)
  WHERE uber_delivery_id IS NOT NULL;

-- Rollback (manual):
--   DROP INDEX IF EXISTS idx_orders_uber_delivery_id_unique;
