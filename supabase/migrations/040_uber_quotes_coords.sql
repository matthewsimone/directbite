-- ============================================================================
-- Migration 040: Persist dropoff coordinates on the uber_quotes cache
-- ============================================================================
--
-- Production-bug fix (order #1000436 dispatched with NULL dropoff_lat/lng).
-- Root cause: dropoff_lat/lng and uber_quote_id are independent async client
-- state; nothing guaranteed coords were present when order_data was frozen
-- into pending_orders. The uber_quotes cache row — written by uber-quote with
-- the EXACT coords that priced the delivery — had no place to store them, so
-- there was no server-side source of truth to backfill from.
--
-- This migration adds dropoff_lat/dropoff_lng to uber_quotes. uber-quote now
-- writes them (it already receives them in the request), and
-- create-payment-intent backfills order_data.dropoff_lat/lng from the cached
-- quote when the client's snapshot is missing them — making the dispatched
-- coords inherit from the quote that produced the fee. The frontend race can
-- no longer strand an order without coordinates.
--
-- Nullable for backward compat: pre-migration cached quotes won't have them
-- (create-payment-intent's coord-presence guard still rejects those before
-- charging — defense in depth).
--
-- Zero impact on existing 8 production in_house restaurants: uber_quotes is
-- only populated for uber_direct quoting.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS. Wrapped in BEGIN/COMMIT.
--
-- Rollback: see reverse SQL block at the bottom (commented out).
-- ============================================================================

BEGIN;

ALTER TABLE uber_quotes ADD COLUMN IF NOT EXISTS dropoff_lat double precision;
ALTER TABLE uber_quotes ADD COLUMN IF NOT EXISTS dropoff_lng double precision;

COMMENT ON COLUMN uber_quotes.dropoff_lat IS
  'Dropoff latitude the quote was priced with (from uber-quote request). '
  'Source of truth for backfilling order_data when the client snapshot is '
  'missing coords. Nullable for pre-migration-040 quotes.';
COMMENT ON COLUMN uber_quotes.dropoff_lng IS
  'Dropoff longitude the quote was priced with. See dropoff_lat.';

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE uber_quotes DROP COLUMN IF EXISTS dropoff_lng;
-- ALTER TABLE uber_quotes DROP COLUMN IF EXISTS dropoff_lat;
-- COMMIT;
