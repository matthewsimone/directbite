-- Migration 052: uber_billing_mode (Phase 1, platform-billing opt-in)
-- Already applied live via SQL editor. Idempotent.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS uber_billing_mode text NOT NULL DEFAULT 'self';

ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS restaurants_uber_billing_mode_check;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_uber_billing_mode_check
  CHECK (uber_billing_mode IN ('self', 'platform'));
