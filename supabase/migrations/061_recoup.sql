-- 061: credit-processing recoup (Pazza + future opt-ins)
-- APPLIED LIVE in the Supabase SQL Editor on 2026-07-23, then committed.
-- Idempotent — safe to re-run.
--
-- restaurants.recoup_enabled / recoup_rate  -> config (rarely toggled)
-- orders.recoup_amount / recoup_rate        -> historical stamp; the rate
--   actually charged is frozen per order so the settlement report stays
--   accurate even if the restaurant's configured rate changes later.
--
-- IMPORTANT: orders.service_fee ALREADY CONTAINS recoup_amount.
-- Never add the two together — that double-counts.

alter table restaurants
  add column if not exists recoup_enabled boolean not null default false,
  add column if not exists recoup_rate numeric(5,4) not null default 0;

alter table restaurants
  drop constraint if exists restaurants_recoup_rate_check;
alter table restaurants
  add constraint restaurants_recoup_rate_check
  check (recoup_rate >= 0 and recoup_rate <= 0.10);

alter table orders
  add column if not exists recoup_amount numeric(10,2) not null default 0,
  add column if not exists recoup_rate numeric(5,4) not null default 0;
