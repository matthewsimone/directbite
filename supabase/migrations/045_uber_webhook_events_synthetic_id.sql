-- ============================================================================
-- Migration 045: allow uber_webhook_events rows without a real Uber event_id
-- ============================================================================
--
-- Problem: uber_webhook_events.event_id is the PRIMARY KEY (migration 034) —
-- implicitly NOT NULL, no default. uber-webhook only INSERTs when the payload
-- carries an event_id; events lacking one are processed but NOT recorded, so
-- the audit table is empty for those. We want EVERY verified webhook captured.
--
-- Fix: give event_id a default of gen_random_uuid()::text. Real Uber event_ids
-- are still supplied explicitly by the handler (dedup via the PK unique
-- constraint is unchanged); only event_id-absent inserts fall back to a
-- synthetic UUID so the row — and its raw payload — is persisted.
--
-- Idempotent: ALTER ... SET DEFAULT is safe to re-run. No data backfill.
-- Zero risk to existing rows or the dedup path for real event_ids.
-- ============================================================================

BEGIN;

ALTER TABLE uber_webhook_events
  ALTER COLUMN event_id SET DEFAULT gen_random_uuid()::text;

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- ============================================================================
-- BEGIN;
-- ALTER TABLE uber_webhook_events ALTER COLUMN event_id DROP DEFAULT;
-- COMMIT;
