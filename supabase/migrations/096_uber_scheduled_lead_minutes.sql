-- 096_uber_scheduled_lead_minutes.sql
-- Scheduled Uber Direct: minutes before scheduled_for that Uber pickup is requested. NULL = 25.
alter table public.restaurants
  add column if not exists uber_scheduled_lead_minutes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurants_uber_scheduled_lead_minutes_range'
  ) then
    alter table public.restaurants
      add constraint restaurants_uber_scheduled_lead_minutes_range
      check (uber_scheduled_lead_minutes is null
             or uber_scheduled_lead_minutes between 10 and 60);
  end if;
end $$;

comment on column public.restaurants.uber_scheduled_lead_minutes is
  'Scheduled Uber Direct only: minutes before scheduled_for that Uber pickup is requested. NULL = 25.';
