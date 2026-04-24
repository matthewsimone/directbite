-- Refund tracking columns on orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
