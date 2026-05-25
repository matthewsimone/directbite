-- ============================================================================
-- Migration 031: Uber Direct integration — schema foundation
-- ============================================================================
--
-- Milestone 2 of the Uber Direct integration. Pure schema change. No edge
-- function changes (M3+), no UI changes (M4+) — except a coordinated React
-- rename of `delivery_minimum` → `delivery_minimum_in_house` that ships in
-- the same commit as this migration.
--
-- Adds:
--   - 11 columns on `restaurants` (credentials, environment, passthrough
--     config, schedule, hard toggle, Uber-specific delivery minimum)
--   - 11 columns on `orders` (frozen fulfillment snapshot + Uber tracking
--     fields including environment stamp at dispatch time)
--   - 1 new table `uber_oauth_tokens` (per-restaurant token cache, RLS
--     restricted to service_role)
--
-- Renames:
--   - `restaurants.delivery_minimum` → `restaurants.delivery_minimum_in_house`
--     React code updated in same commit: SettingsTab.jsx, CheckoutPage.jsx
--
-- Deploy plan (manual, white-glove on Supabase Free tier — no automated
-- backups):
--   1. Manual data export from Supabase dashboard (restaurants + orders)
--   2. Push commit to GitHub → Vercel auto-deploys React with renamed refs
--   3. After Vercel build green: paste this file's contents into Supabase
--      SQL Editor and Run
--   4. Verify on Test Pizza: Settings Delivery save + customer checkout
--      minimum display
--
-- Idempotency:
--   - All ADD COLUMN use IF NOT EXISTS
--   - CHECK constraints inline with ADD COLUMN (only added when column is
--     newly created)
--   - RENAME COLUMN gated by an EXISTS check in a DO block (PG doesn't
--     support IF EXISTS on RENAME directly)
--   - CREATE TABLE uses IF NOT EXISTS
--   - Policy uses DROP IF EXISTS + CREATE
--   - Full migration wrapped in BEGIN/COMMIT; partial failures roll back
--     atomically
--
-- Rollback: see reverse SQL block at the bottom of this file (commented
-- out; uncomment and run if the migration must be undone post-COMMIT).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- restaurants: hard toggle for fulfillment mode (D5)
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS delivery_fulfillment text NOT NULL DEFAULT 'in_house'
    CHECK (delivery_fulfillment IN ('in_house', 'uber_direct'));

-- ----------------------------------------------------------------------------
-- restaurants: Uber Direct credentials (D1 plaintext, RLS-protected at
-- table level by existing tablet_update_own_restaurant policy)
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS uber_customer_id text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS uber_client_id text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS uber_client_secret text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS uber_credentials_verified_at timestamptz;

-- ----------------------------------------------------------------------------
-- restaurants: Uber environment routing (D10)
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS uber_environment text NOT NULL DEFAULT 'production'
    CHECK (uber_environment IN ('sandbox', 'production'));

-- ----------------------------------------------------------------------------
-- restaurants: Passthrough policy (D3 5-mode; value is multipurpose —
-- percent for split, dollars for caps, ignored for *_full modes)
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS uber_passthrough_mode text NOT NULL DEFAULT 'customer_full'
    CHECK (uber_passthrough_mode IN
      ('customer_full', 'split', 'restaurant_cap', 'customer_cap', 'restaurant_full'));

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS uber_passthrough_value numeric NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- restaurants: Schedule overlay (D5)
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS uber_schedule_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS uber_schedule jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- restaurants: Uber-specific delivery minimum (D14)
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS delivery_minimum_uber_direct numeric NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- restaurants: Rename delivery_minimum → delivery_minimum_in_house (D14)
-- PG ALTER ... RENAME COLUMN does not support IF EXISTS; the DO block
-- makes this re-runnable.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurants'
      AND column_name = 'delivery_minimum'
  ) THEN
    ALTER TABLE restaurants RENAME COLUMN delivery_minimum TO delivery_minimum_in_house;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- orders: Frozen fulfillment snapshot (D5) — captured at quote/checkout
-- entry; immune to mid-checkout restaurant config flips
-- ----------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_fulfillment_method text NOT NULL DEFAULT 'in_house'
    CHECK (delivery_fulfillment_method IN ('in_house', 'uber_direct'));

-- ----------------------------------------------------------------------------
-- orders: Uber quote + delivery tracking fields (populated by M9)
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_quote_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_quoted_fee numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_delivery_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_tracking_url text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_status_updated_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_actual_fee numeric;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_fee_delta_reason text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_courier_info jsonb;

-- ----------------------------------------------------------------------------
-- orders: Uber environment stamped at dispatch time
-- Nullable; NULL passes the IN-list check per standard SQL (NULL IN (...)
-- returns UNKNOWN, which CHECK treats as not-violating).
-- ----------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS uber_environment text
    CHECK (uber_environment IN ('sandbox', 'production'));

-- ----------------------------------------------------------------------------
-- uber_oauth_tokens: per-restaurant OAuth token cache (Uber tokens have a
-- 30-day TTL; we mint on demand via Uber's client_credentials grant and
-- reuse until expires_at).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uber_oauth_tokens (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE uber_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS by default in Supabase (the service_role DB
-- role has the BYPASSRLS attribute). This explicit policy is defensive
-- documentation — it makes the access model legible without relying on
-- the reader knowing about BYPASSRLS. Absence of policies for anon and
-- authenticated (tablet) means those roles get zero access.
DROP POLICY IF EXISTS "service_role_only" ON uber_oauth_tokens;
CREATE POLICY "service_role_only"
  ON uber_oauth_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- Wrapped in BEGIN/COMMIT; uncomment and run as a single block in SQL
-- Editor.
-- ============================================================================
--
-- BEGIN;
--
-- -- Restore delivery_minimum column name
-- DO $$
-- BEGIN
--   IF EXISTS (
--     SELECT 1 FROM information_schema.columns
--     WHERE table_schema = 'public'
--       AND table_name = 'restaurants'
--       AND column_name = 'delivery_minimum_in_house'
--   ) THEN
--     ALTER TABLE restaurants RENAME COLUMN delivery_minimum_in_house TO delivery_minimum;
--   END IF;
-- END $$;
--
-- -- Drop OAuth token cache
-- DROP TABLE IF EXISTS uber_oauth_tokens;
--
-- -- Drop orders Uber columns (reverse order of additions)
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_environment;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_courier_info;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_fee_delta_reason;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_actual_fee;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_status_updated_at;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_status;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_tracking_url;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_delivery_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_quoted_fee;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_quote_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS delivery_fulfillment_method;
--
-- -- Drop restaurants Uber columns (reverse order of additions)
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS delivery_minimum_uber_direct;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_schedule;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_schedule_enabled;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_passthrough_value;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_passthrough_mode;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_environment;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_credentials_verified_at;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_client_secret;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_client_id;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS uber_customer_id;
-- ALTER TABLE restaurants DROP COLUMN IF EXISTS delivery_fulfillment;
--
-- COMMIT;
