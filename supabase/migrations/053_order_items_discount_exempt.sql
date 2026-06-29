-- 053_order_items_discount_exempt.sql
-- Per-line record of whether this order line was exempt from the order's
-- percentage promo. Enables the "Discount not eligible" marker on the
-- confirmation page (after refresh), email, and thermal receipt — surfaces
-- that read persisted order_items rather than live cart data.
-- Default false = backwards-compatible (existing lines were not exempt-marked).
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS discount_exempt boolean NOT NULL DEFAULT false;
