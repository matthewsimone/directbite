-- ============================================================================
-- Migration 039: Uber Direct pickup ETA capture
-- ============================================================================
--
-- Adds orders.uber_pickup_eta — the live ETA for the courier's arrival at the
-- RESTAURANT (pickup), captured by uber-webhook from payload.data.pickup_eta
-- on delivery_status / courier_update events. This is what the tablet tile now
-- shows ("ETA X:XX"): the operator cares when the driver arrives to collect
-- the food, not when the customer receives it. The customer-facing
-- uber_dropoff_eta (migration 037) is retained — still captured — for a future
-- "Customer ETA" detail display, just no longer shown on the tile suffix.
--
-- The webhook only writes this column when a valid value is present; it never
-- nulls out a previously-set ETA (an event omitting the field leaves the last
-- known ETA intact).
--
-- Nullable for backward compat:
--   - in_house orders never set it (no Uber delivery).
--   - pre-migration uber_direct orders won't have it until their next webhook.
--   - pre-dispatch orders have no ETA yet; the tablet falls back to the
--     scheduled pickup time.
--
-- Read path: orders.* (the tablet polling query + detail fetch use select('*'),
-- so the column flows through once it exists — no query change needed).
--
-- Zero impact on existing 8 production in_house restaurants: nullable, only
-- written for uber_direct orders by uber-webhook, only read behind a
-- delivery_fulfillment_method === 'uber_direct' gate on the tablet.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS. Wrapped in BEGIN/COMMIT.
--
-- Rollback: see reverse SQL block at the bottom (commented out).
-- ============================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_pickup_eta timestamptz;

COMMENT ON COLUMN orders.uber_pickup_eta IS
  'Live Uber Direct pickup ETA (courier arrival at the restaurant), captured '
  'by uber-webhook from payload.data.pickup_eta on delivery_status / '
  'courier_update events. Nullable; never nulled once set. Read by the tablet '
  'OrdersTab tile/detail ETA suffix. Distinct from uber_dropoff_eta (customer '
  'delivery ETA, migration 037).';

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_pickup_eta;
-- COMMIT;
