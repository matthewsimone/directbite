-- ============================================================
-- Website settings (Phase 1)
-- Adds restaurant-website fields and per-item featured flag.
-- ============================================================

alter table restaurants
  add column if not exists website_enabled boolean not null default false,
  add column if not exists tagline text,
  add column if not exists about_text text,
  add column if not exists about_section_visible boolean not null default true,
  add column if not exists gallery_section_visible boolean not null default true,
  add column if not exists featured_menu_section_visible boolean not null default true,
  add column if not exists reviews_section_visible boolean not null default true,
  add column if not exists logo_url text,
  add column if not exists gallery_urls jsonb not null default '[]'::jsonb,
  add column if not exists instagram_url text,
  add column if not exists facebook_url text,
  add column if not exists primary_color text,
  add column if not exists custom_domain text,
  add column if not exists reviews jsonb not null default '[]'::jsonb;

-- Unique custom_domain (nulls allowed) — wrapped in DO block so re-runs are safe
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurants_custom_domain_key'
  ) then
    alter table restaurants add constraint restaurants_custom_domain_key unique (custom_domain);
  end if;
end$$;

alter table menu_items
  add column if not exists featured_on_website boolean not null default false,
  add column if not exists featured_order integer;

create index if not exists idx_menu_items_featured_website
  on menu_items(restaurant_id) where featured_on_website = true;
