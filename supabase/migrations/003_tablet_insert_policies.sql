-- ============================================================
-- Additional tablet insert policies
-- Tablet users need to insert into these tables
-- ============================================================

-- Promotions: tablet can insert for own restaurant
create policy "tablet_insert_own_promotions"
  on promotions for insert
  with check (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Promotions: tablet can delete own promotions
create policy "tablet_delete_own_promotions"
  on promotions for delete
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Adjustment requests: tablet can insert for own restaurant
create policy "tablet_insert_own_adjustments"
  on adjustment_requests for insert
  with check (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Adjustment requests: tablet can read own
create policy "tablet_read_own_adjustments"
  on adjustment_requests for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Print logs: tablet can insert for own restaurant
create policy "tablet_insert_own_print_logs"
  on print_logs for insert
  with check (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Print logs: tablet can read own
create policy "tablet_read_own_print_logs"
  on print_logs for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Hours: tablet can insert (for initial setup)
create policy "tablet_insert_own_hours"
  on hours for insert
  with check (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));
