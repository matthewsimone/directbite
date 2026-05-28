-- ============================================================================
-- Migration 033: Uber Direct quote cache — tamper-proof server-side storage
-- ============================================================================
--
-- Milestone 6 of the Uber Direct integration. Server-side cache of Uber
-- delivery quotes so create-payment-intent can validate the customer-paid
-- amount against a trusted source (not the client's claim).
--
-- Written by: uber-quote/index.ts (on successful quote)
-- Read by:    create-payment-intent/index.ts (on payment intent creation)
--
-- Cleanup: lazy per-restaurant inline cleanup at quote-write time
-- (DELETE WHERE restaurant_id = ? AND expires_at < now() - interval '1 hour').
-- No cron job needed; rows are bounded per restaurant.
--
-- Zero impact on existing 8 production restaurants: none of them have
-- delivery_fulfillment != 'in_house', so uber-quote is never called for
-- them and no rows are ever written here.
--
-- Rollback: DROP TABLE uber_quotes; — safe, no FK references TO this table.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS uber_quotes (
  quote_id text PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  uber_quoted_fee_cents integer NOT NULL,
  customer_delivery_fee_cents integer NOT NULL,
  restaurant_absorbs_cents integer NOT NULL,
  uber_environment text NOT NULL,
  passthrough_mode text NOT NULL,
  passthrough_value numeric NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uber_quotes_restaurant ON uber_quotes(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_uber_quotes_expires ON uber_quotes(expires_at);

ALTER TABLE uber_quotes ENABLE ROW LEVEL SECURITY;

-- Same pattern as uber_oauth_tokens (M2): service_role only. Anon and
-- authenticated roles get zero access. The cache is internal infrastructure.
DROP POLICY IF EXISTS "service_role_only" ON uber_quotes;
CREATE POLICY "service_role_only"
  ON uber_quotes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- ============================================================================
--
-- BEGIN;
-- DROP TABLE IF EXISTS uber_quotes;
-- COMMIT;
