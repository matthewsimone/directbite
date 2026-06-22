-- 049_default_order_type.sql
-- Per-restaurant default order type (pickup vs delivery) for the customer ordering page.
-- STATUS: already applied to the live DB via the Supabase SQL editor (June 22, 2026).
-- This file exists so the repo matches the live schema. Idempotent: safe no-op if re-run.
-- Additive + backwards-compatible: existing rows default to 'pickup' (current behavior unchanged).

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS default_order_type text NOT NULL DEFAULT 'pickup';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_default_order_type_check'
  ) THEN
    ALTER TABLE restaurants
      ADD CONSTRAINT restaurants_default_order_type_check
      CHECK (default_order_type IN ('pickup', 'delivery'));
  END IF;
END $$;
