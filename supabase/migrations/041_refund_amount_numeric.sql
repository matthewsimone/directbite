-- ============================================================================
-- Migration 041: Convert orders.refund_amount from INTEGER cents to numeric dollars
-- ============================================================================
--
-- Bug fix (order #1000436 displayed "$0.08" for an $8.03 refund). Root cause:
-- refund_amount was the lone money column stored as INTEGER, with an ambiguous
-- unit. Code stored Stripe CENTS and divided by 100 on display — internally
-- consistent, BUT the INTEGER type silently truncated any value mistakenly
-- written in dollars (8.03 -> 8), and the cents convention diverged from the
-- rest of the schema (total_amount, subtotal, etc. are all numeric dollars).
--
-- This migration aligns refund_amount with every other money column: numeric
-- dollars. Existing rows hold INTEGER cents, so the USING clause converts them
-- (cents / 100.0 -> dollars). After this, the 3 edge-function writers store
-- dollars (refund.amount / 100) and the 3 readers drop their / 100 division.
--
-- NOTE on corrupted rows: any row whose refund_amount was previously written
-- in DOLLARS-into-INTEGER (truncated) is wrong BEFORE this migration and stays
-- proportionally wrong after (e.g. #1000436: stored 8 -> becomes 0.08). Those
-- specific rows must be repaired manually after this runs (see the companion
-- repair SQL). This migration only does the units conversion; it cannot
-- distinguish a correctly-stored 8 cents from a truncated 8.03 dollars.
--
-- Zero impact on the 8 in_house production restaurants beyond the unit change;
-- refund_amount is read only through formatMoney, updated in lockstep.
--
-- Idempotency: guarded by a data_type check so re-running is a no-op once the
-- column is already numeric. Wrapped in BEGIN/COMMIT.
--
-- Rollback: see reverse SQL block at the bottom (commented out).
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'refund_amount'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE orders
      ALTER COLUMN refund_amount TYPE numeric(10, 2)
      USING (refund_amount / 100.0);
  END IF;
END $$;

COMMENT ON COLUMN orders.refund_amount IS
  'Refund amount in DOLLARS (numeric, matching total_amount/subtotal). Written '
  'by admin-refund / admin-approve-adjustment / stripe-webhook as '
  'refund.amount / 100; displayed via formatMoney() with no further division.';

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration.
-- Restores INTEGER cents. Only safe if writers/readers are reverted too.
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE orders
--   ALTER COLUMN refund_amount TYPE integer
--   USING (round(refund_amount * 100));
-- COMMIT;
