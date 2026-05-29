-- ============================================================================
-- Migration 035: Uber Direct pickup commitment time
-- ============================================================================
--
-- Milestone M10 of the Uber Direct integration (tablet UX redesign on top
-- of M9a's dispatch flow).
--
-- Adds:
--   orders.uber_pickup_ready_dt timestamptz — Tracks the pickup time the
--   operator committed to during M9a dispatch. Set by uber-create-delivery
--   edge function (computed from pickup_ready_minutes parameter, persisted
--   alongside the dispatch confirmation). Used by tablet UI to show
--   "UberDirect: {status} • Scheduled X:XX" on the order tile and detail.
--
--   This is the SAME timestamp sent to Uber as pickup_ready_dt in the
--   create-delivery payload; persisting it on the orders row lets the
--   tablet display it without re-deriving from pickupReadyMs at render time.
--
-- Nullable: pre-M9a uber_direct orders won't have this set; in_house
-- orders never set it; orders dispatched before this migration applied
-- also won't have it. Tile rendering handles null gracefully (omits the
-- "Scheduled X:XX" segment when null).
--
-- Zero impact on existing 8 production restaurants:
--   - All in_house — uber-create-delivery never runs for them, column
--     stays NULL.
--   - Tile rendering: in_house orders skip the entire uber_direct line.
--
-- Idempotency: ADD COLUMN uses IF NOT EXISTS. Wrapped in BEGIN/COMMIT.
--
-- Rollback: see reverse SQL block at the bottom of this file.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- orders: pickup commitment time (set by uber-create-delivery on dispatch)
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_pickup_ready_dt timestamptz;

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- Wrapped in BEGIN/COMMIT; uncomment and run as a single block in SQL
-- Editor.
-- ============================================================================
--
-- BEGIN;
--
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_pickup_ready_dt;
--
-- COMMIT;
