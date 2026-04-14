-- ============================================================
-- Create storage buckets for image uploads
-- ============================================================

-- Create buckets (public so images can be served without auth)
insert into storage.buckets (id, name, public) values ('menu-images', 'menu-images', true);
insert into storage.buckets (id, name, public) values ('hero-images', 'hero-images', true);

-- ============================================================
-- Storage RLS policies
-- ============================================================

-- Anyone can read public images
create policy "public_read_menu_images" on storage.objects
  for select using (bucket_id = 'menu-images');

create policy "public_read_hero_images" on storage.objects
  for select using (bucket_id = 'hero-images');

-- Admin users can upload/update/delete menu and hero images
create policy "admin_write_menu_images" on storage.objects
  for insert with check (
    bucket_id = 'menu-images'
    and exists (select 1 from admin_users where email = auth.jwt() ->> 'email')
  );

create policy "admin_update_menu_images" on storage.objects
  for update using (
    bucket_id = 'menu-images'
    and exists (select 1 from admin_users where email = auth.jwt() ->> 'email')
  );

create policy "admin_delete_menu_images" on storage.objects
  for delete using (
    bucket_id = 'menu-images'
    and exists (select 1 from admin_users where email = auth.jwt() ->> 'email')
  );

create policy "admin_write_hero_images" on storage.objects
  for insert with check (
    bucket_id = 'hero-images'
    and exists (select 1 from admin_users where email = auth.jwt() ->> 'email')
  );

create policy "admin_update_hero_images" on storage.objects
  for update using (
    bucket_id = 'hero-images'
    and exists (select 1 from admin_users where email = auth.jwt() ->> 'email')
  );

create policy "admin_delete_hero_images" on storage.objects
  for delete using (
    bucket_id = 'hero-images'
    and exists (select 1 from admin_users where email = auth.jwt() ->> 'email')
  );

-- Tablet users can upload/update hero images for their own restaurant
create policy "tablet_write_hero_images" on storage.objects
  for insert with check (
    bucket_id = 'hero-images'
    and exists (
      select 1 from restaurants
      where tablet_email = auth.jwt() ->> 'email'
        and (storage.foldername(name))[1] = slug
    )
  );

create policy "tablet_update_hero_images" on storage.objects
  for update using (
    bucket_id = 'hero-images'
    and exists (
      select 1 from restaurants
      where tablet_email = auth.jwt() ->> 'email'
        and (storage.foldername(name))[1] = slug
    )
  );
