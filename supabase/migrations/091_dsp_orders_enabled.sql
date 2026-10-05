-- 091_dsp_orders_enabled.sql
-- Per-restaurant gate for consolidated DSP orders on the tablet. Default false:
-- every existing restaurant's tablet behavior is unchanged.
-- Applied live in the SQL Editor 2026-10-05 before this file was committed.
alter table public.restaurants
  add column if not exists dsp_orders_enabled boolean not null default false;
