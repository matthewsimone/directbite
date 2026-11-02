-- 097_service_schedules.sql
-- Per-service hours: separate pickup and delivery schedules on restaurants.
-- NULL = not configured (pickup falls back to the legacy `hours` table,
-- delivery falls back to effective pickup — see src/utils/serviceHours.js).
-- Shape: { "<dow 0-6, 0=Sun>": { "enabled": true, "windows": [ { "start": "HH:MM", "end": "HH:MM" } ] } }
-- Applied live 2026-11-02 before commit; written idempotent so re-running is a no-op.
alter table public.restaurants
  add column if not exists pickup_schedule jsonb,
  add column if not exists delivery_schedule jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurants_pickup_schedule_shape'
  ) then
    alter table public.restaurants
      add constraint restaurants_pickup_schedule_shape
      check (pickup_schedule is null or jsonb_typeof(pickup_schedule) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurants_delivery_schedule_shape'
  ) then
    alter table public.restaurants
      add constraint restaurants_delivery_schedule_shape
      check (delivery_schedule is null or jsonb_typeof(delivery_schedule) = 'object');
  end if;
end $$;
