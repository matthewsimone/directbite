-- Migration 060: print_trigger — per-restaurant control of WHEN the kitchen ticket prints.
-- 'received'    = current behavior: auto-print on order arrival (default, all restaurants unchanged)
-- 'in_progress' = opt-in: suppress arrival print; print on operator take (Mark In Progress / Accept)
-- Additive, backwards-compatible. Default preserves existing behavior for every restaurant.
-- Applied manually in Supabase SQL Editor first (per workflow); this file is the idempotent record.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS print_trigger text NOT NULL DEFAULT 'received';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_print_trigger_check'
  ) THEN
    ALTER TABLE restaurants
      ADD CONSTRAINT restaurants_print_trigger_check
      CHECK (print_trigger IN ('received', 'in_progress'));
  END IF;
END $$;
