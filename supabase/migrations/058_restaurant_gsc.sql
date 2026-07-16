-- ============================================================
-- 058_restaurant_gsc.sql
-- Per-restaurant Google Search Console verification token.
-- Injected into the home page <head> as
-- <meta name="google-site-verification" content="..."> by the
-- prerender, so each custom domain can be verified in GSC without
-- DNS access. Nullable + additive; null = no tag emitted.
-- Applied manually in Supabase first, then committed here.
-- ============================================================
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS gsc_verification text;
