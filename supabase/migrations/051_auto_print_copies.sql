-- 051_auto_print_copies.sql
-- Per-restaurant auto-print copy count. On the INITIAL auto-print only, the tablet
-- prints the kitchen ticket this many times (each its own print+cut). Manual reprint
-- and auto-retry always print exactly once, regardless of this value.
-- STATUS: already applied to the live DB via the Supabase SQL editor (June 22, 2026).
-- This file exists so the repo matches the live schema. Idempotent: safe no-op if re-run.
-- Additive + backwards-compatible: existing rows default to 1 (current behavior unchanged).

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS auto_print_copies integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_auto_print_copies_check'
  ) THEN
    ALTER TABLE restaurants
      ADD CONSTRAINT restaurants_auto_print_copies_check
      CHECK (auto_print_copies >= 1 AND auto_print_copies <= 5);
  END IF;
END $$;
