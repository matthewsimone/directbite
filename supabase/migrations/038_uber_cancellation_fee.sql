-- ============================================================================
-- Migration 038: Uber Direct cancellation fee capture
-- ============================================================================
--
-- Adds orders.uber_cancellation_fee_cents — the fee Uber assessed when a
-- dispatched delivery was canceled via the cancel cascade (_shared/
-- uberCancel.ts). Written on a successful cancel when Uber reports a positive
-- fee; surfaced in the operator's post-cancel alert (OrdersTab) and available
-- for audit. The restaurant absorbs this fee; the customer still receives a
-- full Stripe refund.
--
-- Nullable for backward compat:
--   - in_house orders never set it (no Uber delivery).
--   - never-dispatched / zero-fee cancels leave it NULL.
--   - pre-migration canceled orders won't have it.
--
-- Read path: orders.* (the tablet polling query + detail fetch use select('*'),
-- so the column flows through once it exists — no query change needed).
--
-- Zero impact on existing 8 production in_house restaurants: nullable, only
-- written by the uber cancel path, only read behind a uber_direct gate.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS. Wrapped in BEGIN/COMMIT.
--
-- Rollback: see reverse SQL block at the bottom (commented out).
-- ============================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS uber_cancellation_fee_cents integer;

COMMENT ON COLUMN orders.uber_cancellation_fee_cents IS
  'Uber Direct cancellation fee in cents, captured by uberCancel.ts on a '
  'successful cancel (only when > 0). Nullable. The restaurant absorbs this '
  'fee; the customer still receives a full refund. Surfaced in the tablet '
  'post-cancel alert.';

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE orders DROP COLUMN IF EXISTS uber_cancellation_fee_cents;
-- COMMIT;
