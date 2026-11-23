-- Rollback for supabase/migrations/103_pos_menu_snapshots.sql.
-- DESTRUCTIVE: drops every stored snapshot (orders pinned to them would price as unknown_snapshot
-- once submit-order exists) and the structured address columns (and any backfilled values).

begin;
drop table if exists public.pos_menu_snapshots;
alter table public.restaurants
  drop column if exists address_street,
  drop column if exists address_city,
  drop column if exists address_state,
  drop column if exists address_zip;
commit;
