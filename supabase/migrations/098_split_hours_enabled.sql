-- 098_split_hours_enabled.sql
-- Per-restaurant switch for the tablet's split-hours editor (pickup/delivery
-- tabs, second windows). false = the existing single-window editor and
-- saveHours, unchanged. Idempotent.
alter table public.restaurants
  add column if not exists split_hours_enabled boolean not null default false;

comment on column public.restaurants.split_hours_enabled is
  'Tablet Settings: show the split pickup/delivery hours editor. false = legacy single-window editor.';
