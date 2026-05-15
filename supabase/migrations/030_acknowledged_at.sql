-- Bulletproof chime: per-order acknowledgment so the alert keeps firing
-- across page reloads, tab switches, and multiple tablets viewing the
-- same restaurant. Tablet writes acknowledged_at when the user taps a
-- new-status order; polling computes "any un-acked new orders exist?" to
-- decide whether to keep the audio looping.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

-- Partial index makes the per-poll "any un-acked new?" check cheap. The
-- (restaurant_id, status, acknowledged_at) tuple covers the WHERE clause
-- exactly; the partial predicate keeps the index tiny (one row per
-- live new-and-unacknowledged order).
CREATE INDEX IF NOT EXISTS idx_orders_unacked_new
  ON orders(restaurant_id, status, acknowledged_at)
  WHERE status = 'new' AND acknowledged_at IS NULL;
