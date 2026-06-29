-- 052_discount_exempt.sql
-- Per-category discount exemption. Items in an exempt category do not
-- receive the active percentage promo. Default false = existing behavior
-- (all current categories remain fully discountable). Backwards-compatible.
ALTER TABLE menu_categories
  ADD COLUMN IF NOT EXISTS discount_exempt boolean NOT NULL DEFAULT false;
