-- ============================================================================
-- Migration 037: Uber Direct dropoff ETA capture
-- ============================================================================
--
-- UI-polish milestone (post-M9d). Adds a single nullable column to capture
-- the live dropoff ETA Uber reports as a delivery progresses, so the tablet
-- OrdersTab can show "UberDirect · Picked up · ETA 5:12 PM" instead of only
-- the static scheduled pickup time.
--
-- Populated by uber-webhook on event.delivery_status and event.courier_update
-- events, extracted from payload.data.dropoff_eta when present. The webhook
-- only writes this column when a valid value is in the payload — it never
-- nulls out a previously-captured ETA (so a courier_update missing the field
-- leaves the last known ETA intact).
--
-- Nullable for backward compat:
--   - in_house orders never set it (no Uber delivery).
--   - pre-migration uber_direct orders won't have it until their next webhook.
--   - uber_direct orders pre-dispatch / pre-courier-assignment won't have an
--     ETA yet; the tablet falls back to the scheduled pickup time.
--
-- Read path: orders.* (the tablet polling query and detail fetch both use
-- select('*'), so no query change is needed — the column flows through once
-- it exists).
--
-- Zero impact on existing 8 production in_house restaurants: column is
-- nullable, only written for uber_direct orders by uber-webhook, and only
-- read on the tablet behind a delivery_fulfillment_method === 'uber_direct'
-- gate.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS. Wrapped in BEGIN/COMMIT.
--
-- Rollback: see reverse SQL block at the bottom (commented out).
-- ============================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_dropoff_eta timestamptz;

COMMENT ON COLUMN orders.uber_dropoff_eta IS
  'Live Uber Direct dropoff ETA, captured by uber-webhook from '
  'payload.data.dropoff_eta on delivery_status / courier_update events. '
  'Nullable; never nulled out once set. Read by the tablet OrdersTab to '
  'show ETA on uber_direct order tiles + detail.';

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_dropoff_eta;
-- COMMIT;
