set lock_timeout = '3s';
-- 116_rollback.sql — undo migration 116: restore 115's `restaurant_absorbs_cents >= 0` check and 115's guard; drop
-- quoted_provider_fee_cents, canceled_by and the two 116 checks. Run as postgres in the SQL editor. Leaves 115.
--
-- A NEGATIVE restaurant_absorbs_cents (the provider got cheaper than the customer's locked fee) cannot go back under
-- 115's check: the rollback STOPS if any row has one — export the ledger first. quoted_provider_fee_cents / canceled_by
-- are ledger detail: the rollback STOPS if any row has one set, unless you run, in the same session:
--   set pos.rollback_116_discard = 'yes';
-- Roll back only with pos-v1-delivery-dispatch / -cancel / -status undeployed or redeployed from before 116's commit
-- (they write the 116 columns).

begin;

do $$
begin
  if to_regclass('public.pos_deliveries') is null then
    raise exception '116 rollback: pos_deliveries is missing (115 not applied?)' using errcode = '55000';
  end if;
  if exists (select 1 from public.pos_deliveries where restaurant_absorbs_cents < 0) then
    raise exception '116 rollback: pos_deliveries has negative restaurant_absorbs_cents (115''s check would refuse them) — export the ledger and stop'
      using errcode = '55000';
  end if;
  if exists (select 1 from public.pos_deliveries where quoted_provider_fee_cents is not null or canceled_by is not null)
     and coalesce(current_setting('pos.rollback_116_discard', true), '') <> 'yes' then
    raise exception '116 rollback: pos_deliveries has quoted_provider_fee_cents / canceled_by values — export them, then set pos.rollback_116_discard = ''yes'', or stop'
      using errcode = '55000';
  end if;
end;
$$;

alter table public.pos_deliveries
  drop constraint if exists pos_deliveries_absorbs_is_difference,
  drop constraint if exists pos_deliveries_canceled_by_iff_canceled,
  drop column if exists quoted_provider_fee_cents,
  drop column if exists canceled_by;
alter table public.pos_deliveries
  add constraint pos_deliveries_restaurant_absorbs_cents_check check (restaurant_absorbs_cents >= 0);

-- 115's guard, verbatim
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
     or new.billing_mode <> old.billing_mode or new.provider_environment <> old.provider_environment then
    raise exception 'pos_deliveries: identity / ledger columns are immutable' using errcode = '42501';
  end if;
  -- set once
  if (old.provider_delivery_id is not null and new.provider_delivery_id is distinct from old.provider_delivery_id)
     or (old.provider_fee_cents is not null and new.provider_fee_cents is distinct from old.provider_fee_cents)
     or (old.restaurant_absorbs_cents is not null and new.restaurant_absorbs_cents is distinct from old.restaurant_absorbs_cents)
     or (old.cancellation_fee_cents is not null and new.cancellation_fee_cents is distinct from old.cancellation_fee_cents)
     or (old.provider_quote_id is not null and new.provider_quote_id is distinct from old.provider_quote_id) then
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

comment on column public.pos_deliveries.restaurant_absorbs_cents is null;

revoke all on table public.pos_deliveries from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_deliveries to service_role;  -- 115

commit;
