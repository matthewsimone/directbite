-- ============================================================
-- 059_restaurant_receipt_font.sql
-- Per-restaurant kitchen-receipt font size. 'large' doubles the
-- HEIGHT of the item-block lines (item name/price, size, modifiers,
-- per-item notes) on the Epson thermal receipt; 'standard' is the
-- default and prints exactly as before. Read by _printOrder in
-- src/utils/epsonPrint.js via rest.receipt_font and set from the
-- tablet Settings > Printer section.
-- Applied manually in Supabase first, then committed here.
-- Idempotent.
-- ============================================================
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS receipt_font text NOT NULL DEFAULT 'standard';

ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS restaurants_receipt_font_check;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_receipt_font_check CHECK (receipt_font IN ('standard','large'));
