-- ============================================================================
-- Migration 042: Stuck-pending alert + self-delivery + cancellation attribution
-- ============================================================================
--
-- Three schema additions supporting the Stuck-Pending Alert / Failed-State /
-- Self-Delivery feature:
--
--   1. status += 'self_delivering' — the restaurant cancelled the Uber dispatch
--      and is delivering the order with their own driver. Active state; lives in
--      the In Progress tab until marked complete.
--
--   2. orders.stuck_acknowledged_at — when the operator taps a stuck-pending
--      tile to silence the alert chime. DB-backed (not local) so the ack
--      survives a Fully Kiosk reload, mirroring acknowledged_at for new orders.
--
--   3. orders.cancelled_by — WHO initiated a cancellation, so the UI can tell a
--      restaurant-initiated cancel apart from an Uber-initiated one (the latter
--      is a "no driver / failed dispatch" alert; Uber Direct doesn't emit a
--      'failed' status, so an Uber cancel is the signal):
--        'restaurant_refund'       — admin-refund (Cancel & Refund flow)
--        'restaurant_self_deliver' — uber-self-deliver (Deliver Yourself flow)
--        'uber'                    — Uber initiated (webhook writes if null)
--        null                      — not cancelled
--
-- Idempotent: drop-then-add for CHECK constraints (the only way to amend a
-- Postgres CHECK), ADD COLUMN IF NOT EXISTS for columns. Wrapped in
-- BEGIN/COMMIT. Zero impact on in_house restaurants — new columns are nullable
-- and only written on the Uber paths.
--
-- Rollback: see reverse block at the bottom (commented out).
-- ============================================================================

BEGIN;

-- 1. status enum gains 'self_delivering' (mirror migration 028's drop-then-add)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('new', 'in_progress', 'scheduled', 'complete', 'cancelled', 'self_delivering'));

-- 2. stuck-pending alert acknowledgement (DB-backed, survives reload)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stuck_acknowledged_at timestamptz;

-- 3. cancellation attribution
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cancelled_by_check;
ALTER TABLE orders ADD CONSTRAINT orders_cancelled_by_check
  CHECK (cancelled_by IS NULL OR cancelled_by IN ('restaurant_refund', 'restaurant_self_deliver', 'uber'));

COMMENT ON COLUMN orders.stuck_acknowledged_at IS
  'When the operator acknowledged a stuck-pending alert by tapping the tile. '
  'DB-backed so it survives a Fully Kiosk reload (mirrors acknowledged_at).';
COMMENT ON COLUMN orders.cancelled_by IS
  'Who initiated cancellation: restaurant_refund (admin-refund), '
  'restaurant_self_deliver (uber-self-deliver), uber (Uber-initiated, written '
  'by the webhook only when previously null), or null (not cancelled).';

COMMIT;

-- ============================================================================
-- REVERSE SQL (rollback) — DO NOT RUN unless undoing this migration. Only safe
-- if no row uses status='self_delivering' or a cancelled_by value.
-- ============================================================================
--
-- BEGIN;
-- ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cancelled_by_check;
-- ALTER TABLE orders DROP COLUMN IF EXISTS cancelled_by;
-- ALTER TABLE orders DROP COLUMN IF EXISTS stuck_acknowledged_at;
-- ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
-- ALTER TABLE orders ADD CONSTRAINT orders_status_check
--   CHECK (status IN ('new', 'in_progress', 'scheduled', 'complete', 'cancelled'));
-- COMMIT;
