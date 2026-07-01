-- 056_restaurant_seo_fields.sql
-- SEO fields for the prerendered restaurant marketing pages (SSG Phase 2).
-- All additive + nullable/defaulted → backwards-compatible, no existing row
-- behavior changes.
--   cuisine          — used in the auto-generated <title>/description
--                      ("Best {cuisine} in {city}, {state}"); defaults to
--                      'Pizza' (the current hardcoded servesCuisine value).
--   seo_title        — optional manual override of the page <title>.
--   seo_description  — optional manual override of the meta description.
-- When seo_title/seo_description are NULL, the head-builder derives them
-- from name + cuisine + parsed city/state (see src/pages/website/utils/seoHead.js).
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS cuisine text DEFAULT 'Pizza';

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS seo_title text;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS seo_description text;
