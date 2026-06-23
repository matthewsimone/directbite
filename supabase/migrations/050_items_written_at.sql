-- 050_items_written_at.sql
-- Print-race fix (B2): deterministic "order write complete" signal.
-- STATUS: already applied to the live DB via the Supabase SQL editor (June 22, 2026).
-- This file exists so the repo matches the live schema. Idempotent: safe no-op if re-run.
-- The stripe-webhook stamps this as its FINAL write step, after all order_items +
-- order_item_toppings are persisted. The tablet auto-print gate (useOrderPolling.js)
-- keys on this instead of a blind 5s timer, so a poll can never print a half-written ticket.
-- Additive + backwards-compatible: NULL on existing rows (historical orders print via the age fallback).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS items_written_at timestamptz DEFAULT NULL;
