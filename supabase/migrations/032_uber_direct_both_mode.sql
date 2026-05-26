-- ============================================================================
-- Migration 032: Uber Direct 'both' mode — schema expansion
-- ============================================================================
--
-- Milestone 5a of the Uber Direct integration. Extends delivery_fulfillment
-- enum to include 'both' mode and adds uber_direct_active boolean column
-- for real-time toggle override of the schedule.
--
-- Adds:
--   - 1 new column `restaurants.uber_direct_active` (boolean, default false)
--   - Expands CHECK on `restaurants.delivery_fulfillment` to include 'both'
--
-- Zero impact on existing rows: all 5 live restaurants currently have
-- delivery_fulfillment = 'in_house' (accepted by the expanded CHECK) and
-- will receive uber_direct_active = false by default (only consulted when
-- mode is 'both').
--
-- Idempotency:
--   - ADD COLUMN uses IF NOT EXISTS
--   - DROP/ADD CONSTRAINT wrapped in DO block that queries information_schema
--     first (so it's safe to re-run; will no-op if already migrated)
--   - Full migration wrapped in BEGIN/COMMIT; partial failures roll back
--
-- BEFORE RUNNING THIS MIGRATION, verify the constraint name still matches:
--   SELECT constraint_name FROM information_schema.table_constraints
--   WHERE table_schema = 'public' AND table_name = 'restaurants'
--     AND constraint_name LIKE '%delivery_fulfillment%';
--   Expected: restaurants_delivery_fulfillment_check
--   If the actual name differs, update the constraint_name reference in
--   the DO block below to match.
--
-- Rollback: see reverse SQL block at the bottom of this file. Note: the
-- rollback only works cleanly if no row has delivery_fulfillment = 'both'.
-- If any restaurant has been configured to 'both' by M5b before a rollback
-- is attempted, run first:
--   UPDATE restaurants SET delivery_fulfillment = 'in_house'
--   WHERE delivery_fulfillment = 'both';
-- ============================================================================

BEGIN;

-- Expand the delivery_fulfillment CHECK constraint to allow 'both' value.
-- Uses information_schema EXISTS check so this is safe to re-run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
      AND constraint_name = 'restaurants_delivery_fulfillment_check'
  ) THEN
    ALTER TABLE restaurants DROP CONSTRAINT restaurants_delivery_fulfillment_check;
  END IF;
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_delivery_fulfillment_check
    CHECK (delivery_fulfillment IN ('in_house', 'uber_direct', 'both'));
END $$;

-- Real-time toggle column. Only consulted when delivery_fulfillment = 'both';
-- a manual ON overrides the schedule and forces Uber dispatch. The toggle is
-- intentionally NOT NULL with a safe default of false.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS uber_direct_active boolean NOT NULL DEFAULT false;

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- Wrapped in BEGIN/COMMIT; uncomment and run as a single block.
-- ============================================================================
--
-- BEGIN;
--
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_direct_active;
--
-- DO $$
-- BEGIN
--   IF EXISTS (
--     SELECT 1 FROM information_schema.table_constraints
--     WHERE table_schema = 'public'
--       AND table_name = 'restaurants'
--       AND constraint_name = 'restaurants_delivery_fulfillment_check'
--   ) THEN
--     ALTER TABLE restaurants DROP CONSTRAINT restaurants_delivery_fulfillment_check;
--   END IF;
--   ALTER TABLE restaurants ADD CONSTRAINT restaurants_delivery_fulfillment_check
--     CHECK (delivery_fulfillment IN ('in_house', 'uber_direct'));
-- END $$;
--
-- COMMIT;
