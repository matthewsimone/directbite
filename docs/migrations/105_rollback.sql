-- Rollback for supabase/migrations/105_pos_staff.sql.
-- DESTRUCTIVE: drops every staff record, PIN hash, published staff snapshot and staff event. Registers
-- keep their last installed staff list (PINs stay on locally — STAFF.md §8) until a new one is published.

begin;
drop function if exists public.pos_staff_snapshot_source(uuid);
drop function if exists public.pos_staff_set_settings(uuid, int, int, boolean);
drop function if exists public.pos_staff_reactivate(uuid);
drop function if exists public.pos_staff_deactivate(uuid);
drop function if exists public.pos_staff_set_pin(uuid, text, text, jsonb);
drop function if exists public.pos_staff_add(uuid, text, text, text, text, jsonb);
drop function if exists public.pos_staff_bump(uuid);
drop function if exists public.pos_staff_lock(uuid);
drop table if exists public.pos_staff_events;
drop table if exists public.pos_staff_snapshots;
drop table if exists public.pos_staff_settings;
drop table if exists public.pos_staff;
commit;
