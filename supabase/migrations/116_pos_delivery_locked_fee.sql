set lock_timeout = '3s';
-- 116_pos_delivery_locked_fee.sql — CP23 change (Matt): the customer's Uber delivery fee is LOCKED at the phone call.
-- At dispatch the server re-quotes an expired quote and books automatically (no 409, no staff prompt, the customer is
-- never re-charged); ANY difference (+ or −) is the restaurant's. Plus who canceled a delivery.
--
-- pos_deliveries ONLY (115's table). Nothing outside pos_*; no orders / order_items / uber_quotes / restaurants change.
--
--   restaurant_absorbs_cents  SIGNED now: 115's `check (restaurant_absorbs_cents >= 0)` is dropped and replaced by
--                             `absorbs = provider_fee_cents − customer_fee_cents` (negative when Uber got cheaper than
--                             the customer paid — stored, never floored).
--   quoted_provider_fee_cents + the provider fee quoted at the phone call (the order's quote), set on insert, immutable.
--                             fee_delta_cents on the wire = provider_fee_cents − this (0 normally). null on rows from
--                             before 116 (the wire answers 0).
--   canceled_by               + 'restaurant' (a POS cancel) | 'provider' (Uber canceled / returned it); set together with
--                             state canceled (check), set once (guard).
--   pos_deliveries_guard      re-created: 115's rules + quoted_provider_fee_cents immutable + canceled_by set once.
--
-- Access unchanged (115): service_role select insert update on pos_deliveries — re-asserted (108 pattern; the new
-- columns are covered by the table-level grant, verified column by column in 116_verify.sql).
--
-- NOT APPLIED. Needs 115. pos-v1-delivery-dispatch / -cancel / -status at or after this commit need 116 FIRST (they
-- write quoted_provider_fee_cents / canceled_by and a negative absorb). Rollback: docs/migrations/116_rollback.sql.
-- Smoke: docs/migrations/116_smoke.sql. Verify: docs/migrations/116_verify.sql.

begin;

do $$
declare
  n int;
begin
  if to_regclass('public.pos_deliveries') is null or to_regprocedure('public.pos_deliveries_guard()') is null then
    raise exception '116: needs 115 (pos_deliveries)' using errcode = '55000';
  end if;
  -- 115's inline check on restaurant_absorbs_cents (Postgres names it <table>_<column>_check); found by definition
  select count(*) into n from pg_constraint
   where conrelid = 'public.pos_deliveries'::regclass and contype = 'c'
     and conname = 'pos_deliveries_restaurant_absorbs_cents_check'
     and pg_get_constraintdef(oid) ilike '%restaurant_absorbs_cents >= 0%';
  if n <> 1 then
    raise exception '116: expected 115''s pos_deliveries_restaurant_absorbs_cents_check (>= 0), found %', n using errcode = '55000';
  end if;
end;
$$;

alter table public.pos_deliveries drop constraint pos_deliveries_restaurant_absorbs_cents_check;

alter table public.pos_deliveries
  add column quoted_provider_fee_cents int check (quoted_provider_fee_cents >= 0),
  add column canceled_by text check (canceled_by in ('restaurant', 'provider'));

alter table public.pos_deliveries
  -- signed: what the customer's locked fee does not cover (negative = the provider got cheaper)
  add constraint pos_deliveries_absorbs_is_difference
    check (restaurant_absorbs_cents is null
           or (provider_fee_cents is not null and restaurant_absorbs_cents = provider_fee_cents - customer_fee_cents)),
  add constraint pos_deliveries_canceled_by_iff_canceled
    check ((state = 'canceled') = (canceled_by is not null));

create or replace function public.pos_deliveries_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pos_deliveries: never deleted (the ledger)' using errcode = '42501';
  end if;
  if new.id <> old.id or new.pos_order_id <> old.pos_order_id or new.restaurant_id <> old.restaurant_id
     or new.provider <> old.provider or new.action_id <> old.action_id or new.created_at <> old.created_at
     or new.customer_fee_cents <> old.customer_fee_cents or new.driver_tip_cents <> old.driver_tip_cents
     or new.billing_mode <> old.billing_mode or new.provider_environment <> old.provider_environment
     or new.quoted_provider_fee_cents is distinct from old.quoted_provider_fee_cents then          -- 116
    raise exception 'pos_deliveries: identity / ledger columns are immutable' using errcode = '42501';
  end if;
  -- set once
  if (old.provider_delivery_id is not null and new.provider_delivery_id is distinct from old.provider_delivery_id)
     or (old.provider_fee_cents is not null and new.provider_fee_cents is distinct from old.provider_fee_cents)
     or (old.restaurant_absorbs_cents is not null and new.restaurant_absorbs_cents is distinct from old.restaurant_absorbs_cents)
     or (old.cancellation_fee_cents is not null and new.cancellation_fee_cents is distinct from old.cancellation_fee_cents)
     or (old.provider_quote_id is not null and new.provider_quote_id is distinct from old.provider_quote_id)
     or (old.canceled_by is not null and new.canceled_by is distinct from old.canceled_by) then          -- 116
    raise exception 'pos_deliveries: a provider id / ledger amount is set once' using errcode = '42501';
  end if;
  -- state machine
  if new.state is distinct from old.state and not (
       (old.state = 'booking' and new.state in ('booked', 'failed'))
    or (old.state = 'booked' and new.state in ('delivered', 'canceled'))) then
    raise exception 'pos_deliveries: % → % is not allowed', old.state, new.state using errcode = '42501';
  end if;
  if old.state in ('failed', 'canceled') and new.state = old.state
     and (to_jsonb(new) - 'updated_at' - 'last_polled_at') is distinct from (to_jsonb(old) - 'updated_at' - 'last_polled_at') then
    raise exception 'pos_deliveries: a % delivery is final', old.state using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.pos_deliveries_guard() from public, anon, authenticated;

revoke all on table public.pos_deliveries from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_deliveries to service_role;  -- unchanged (115): no delete (guard)

comment on column public.pos_deliveries.restaurant_absorbs_cents is 'Signed: provider_fee_cents − customer_fee_cents (the customer fee is locked at the phone call; negative = the provider got cheaper).';
comment on column public.pos_deliveries.quoted_provider_fee_cents is 'The provider fee quoted at the phone call (the order''s quote). fee_delta = provider_fee_cents − this.';
comment on column public.pos_deliveries.canceled_by is 'restaurant = a POS cancel; provider = the provider canceled / returned it.';

commit;
