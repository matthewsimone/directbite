-- Rollback for supabase/migrations/102_restaurants_tablet_guard.sql.
-- Re-opens N2: a tablet login can again change every column of its own restaurant.

begin;
drop trigger if exists trg_restaurants_tablet_guard on public.restaurants;
drop function if exists public.restaurants_tablet_guard();
commit;
