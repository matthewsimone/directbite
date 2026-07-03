-- ============================================================
-- 057_seo_pages.sql
-- Per-page SEO overrides for the prerendered /places/* (location) and
-- /tags/* (dish) marketing pages.
--
-- OVERRIDES-ONLY pattern: a row exists ONLY when a page is customized or
-- disabled. Zero rows for a (restaurant, page_type, slug) → the prerender's
-- auto-generated defaults apply (title/description/h1/body derived from
-- restaurant + address + menu data, same idea as seoHead.js for the homepage).
-- So an empty table = every page auto-generates; rows are the exception.
-- ============================================================

create table seo_pages (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  -- 'place' = location page (/places/:slug), 'tag' = dish page (/tags/:slug).
  page_type text not null check (page_type in ('place', 'tag')),
  -- URL segment, e.g. 'pompton-lakes' (place) or 'buffalo-chicken-pizza' (tag).
  slug text not null,
  -- Optional overrides — NULL means "use the auto-generated value".
  title_override text,
  meta_description_override text,
  h1_override text,
  body_override text,
  -- Kill switch: set false to suppress an otherwise auto-generated page.
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- One override row per page identity.
  unique (restaurant_id, page_type, slug)
);

create index idx_seo_pages_restaurant on seo_pages(restaurant_id);

alter table seo_pages enable row level security;

-- Anon can read overrides — the build-time prerender fetches these with the
-- public anon key (RLS-governed), same read path as the live site.
create policy "anon_read_seo_pages" on seo_pages
  for select to anon using (true);

-- Admin full access (mirrors the admin_all_* idiom in 004_admin_policies.sql).
create policy "admin_all_seo_pages" on seo_pages
  for all using (is_admin()) with check (is_admin());
