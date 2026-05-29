-- ============================================================================
-- Migration 034: Uber Direct dispatch — webhook events + dropoff coordinates
--                + dispatched-at timestamp
-- ============================================================================
--
-- Milestone 9a of the Uber Direct integration. Shipped alongside the
-- uber-create-delivery edge function and CheckoutPage / stripe-webhook
-- updates that persist dropoff coordinates at payment time.
--
-- Adds:
--   1. uber_webhook_events table — webhook event dedup keyed by event_id
--      (Uber retries on 5xx/timeout, no documented cutoff). M9a does NOT
--      write to this table — M9b's uber-webhook function will. Shipped in
--      M9a so the table exists by the time M9b deploys. Audit trail value:
--      payload jsonb preserves the entire webhook body for later debugging.
--   2. orders.dropoff_lat, orders.dropoff_lng — captured at checkout time
--      (Google Places autocomplete), persisted via stripe-webhook, read by
--      uber-create-delivery when refreshing an expired quote at Accept time.
--      Both nullable for backward compat: in_house orders may not need them
--      (haversine reads them from live state, not the orders row); pre-M9a
--      uber_direct orders for Test Pizza also don't have them.
--   3. orders.uber_dispatched_at — timestamptz stamped by
--      uber-create-delivery at successful dispatch. Distinct from
--      uber_status_updated_at (which moves on every webhook event in M9b);
--      this column captures only the moment of initial dispatch. Nullable
--      because pre-dispatch and in_house orders never set it.
--
-- Cleanup: lazy / unbounded for v1 on uber_webhook_events. Each webhook
-- delivery writes one row keyed by event_id (UUID). Realistic volume:
-- <100 events/order × ~50 orders/day per active restaurant × N restaurants.
-- Acceptable without proactive cleanup. Future enhancement: scheduled
-- deletion of rows older than 90 days.
--
-- Zero impact on existing 8 production restaurants:
--   - dropoff_lat/lng nullable; in_house orders never reference them in
--     the dispatch path (uber-create-delivery only handles uber_direct).
--   - uber_dispatched_at nullable; only set by uber-create-delivery.
--   - uber_webhook_events isolated; M9a writes nowhere here, and M9b's
--     webhook handler returns 200 + ignores any event whose order has
--     delivery_fulfillment_method != 'uber_direct'.
--
-- Idempotency: CREATE TABLE / ADD COLUMN use IF NOT EXISTS. Policy uses
-- DROP IF EXISTS + CREATE. Full migration wrapped in BEGIN/COMMIT;
-- partial failures roll back atomically.
--
-- Rollback: see reverse SQL block at the bottom of this file.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- uber_webhook_events: per-event dedup audit trail (written by M9b)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uber_webhook_events (
  event_id text PRIMARY KEY,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  event_kind text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb
);

CREATE INDEX IF NOT EXISTS idx_uber_webhook_events_order ON uber_webhook_events(order_id);
CREATE INDEX IF NOT EXISTS idx_uber_webhook_events_received ON uber_webhook_events(received_at);

ALTER TABLE uber_webhook_events ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS via BYPASSRLS; this explicit policy is
-- defensive documentation, matching the pattern used by uber_oauth_tokens
-- (migration 031) and uber_quotes (migration 033). Absence of policies
-- for anon and authenticated means those roles get zero access.
DROP POLICY IF EXISTS "service_role_only" ON uber_webhook_events;
CREATE POLICY "service_role_only"
  ON uber_webhook_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- orders: dropoff coordinates + dispatched-at timestamp
--
-- dropoff_lat, dropoff_lng — captured at Google Places autocomplete time,
-- persisted via stripe-webhook on payment success, read by
-- uber-create-delivery when an expired quote needs to be refreshed at
-- Accept time. Nullable for two reasons:
--   1. Existing in_house orders (rows pre-dating M9a) won't have these.
--   2. Pickup orders never need them.
--
-- uber_dispatched_at — stamped by uber-create-delivery when an Uber
-- delivery is successfully created for this order. Distinct from
-- uber_status_updated_at (which moves on every webhook event from M9b);
-- this column captures only the moment of initial dispatch. Nullable
-- because pre-dispatch and in_house orders never set it.
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dropoff_lat numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dropoff_lng numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_dispatched_at timestamptz;

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- Wrapped in BEGIN/COMMIT; uncomment and run as a single block in SQL
-- Editor.
-- ============================================================================
--
-- BEGIN;
--
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_dispatched_at;
-- ALTER TABLE orders DROP COLUMN IF EXISTS dropoff_lng;
-- ALTER TABLE orders DROP COLUMN IF EXISTS dropoff_lat;
--
-- DROP TABLE IF EXISTS uber_webhook_events;
--
-- COMMIT;
