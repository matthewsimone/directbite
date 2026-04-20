-- ============================================================
-- Delivery zip codes table
-- ============================================================

create table delivery_zip_codes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  zip_code text not null,
  created_at timestamptz not null default now(),
  unique (restaurant_id, zip_code)
);

create index idx_delivery_zip_codes_restaurant on delivery_zip_codes(restaurant_id);

alter table delivery_zip_codes enable row level security;

-- Anon can read zip codes (needed for checkout validation)
create policy "anon_read_zip_codes" on delivery_zip_codes
  for select to anon using (true);

-- Tablet users can manage their own restaurant's zip codes
create policy "tablet_read_own_zip_codes" on delivery_zip_codes
  for select using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_insert_own_zip_codes" on delivery_zip_codes
  for insert with check (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_delete_own_zip_codes" on delivery_zip_codes
  for delete using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Admin full access
create policy "admin_all_zip_codes" on delivery_zip_codes
  for all using (is_admin()) with check (is_admin());
