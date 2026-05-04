-- ============================================================
-- QR redirect system: stable /r/:slug URL → restaurant.redirect_url
-- with scan logging for analytics.
-- ============================================================

-- 1. Restaurant columns
alter table restaurants
  add column if not exists redirect_url text,
  add column if not exists qr_code_url text;

-- 2. Backfill existing rows
update restaurants
set redirect_url = 'https://directbite.co/' || slug
where redirect_url is null;

-- 3. Auto-default for new rows so admins never see a NULL redirect.
--    Self-maintaining: any future restaurant gets the ordering-page
--    URL filled in by Postgres at INSERT time.
create or replace function set_default_redirect_url()
returns trigger as $$
begin
  if new.redirect_url is null then
    new.redirect_url := 'https://directbite.co/' || new.slug;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_default_redirect_url on restaurants;
create trigger trg_default_redirect_url
  before insert on restaurants
  for each row
  execute function set_default_redirect_url();

-- 4. Scans table
create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  scanned_at timestamptz not null default now()
);

create index if not exists idx_scans_restaurant_scanned_at
  on scans(restaurant_id, scanned_at desc);

-- 5. RLS — anon can INSERT (middleware logs scans), admin reads all.
alter table scans enable row level security;

drop policy if exists "anon_insert_scans" on scans;
create policy "anon_insert_scans" on scans
  for insert to anon
  with check (true);

drop policy if exists "admin_all_scans" on scans;
create policy "admin_all_scans" on scans
  for all using (is_admin()) with check (is_admin());

-- 6. Storage bucket for QR SVGs. Public read; uploads via service role.
insert into storage.buckets (id, name, public)
values ('qr-codes', 'qr-codes', true)
on conflict (id) do nothing;
