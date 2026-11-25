set lock_timeout = '3s';
-- 118_pos_delivery_alerts.sql — the every-register delivery toast (POS-005, Matt 2026-11-25): a shared "handled" mark
-- on pos_deliveries, so when one register handles a provider cancel / a failed booking every register clears the
-- toast on its next pos-v1-delivery-status poll (scope 'restaurant').
--
-- pos_* ONLY. Nothing on orders / order_items / uber_quotes / restaurants or any live-path table.
--
--   pos_deliveries          + alert_handled_at timestamptz, alert_handled_by text (staff uuid | 'register'),
--                           alert_handled_device_id uuid → pos_devices, alert_choice text (in_house | acknowledged):
--                           all four set together (check), SET ONCE (guard) — the first register wins.
--   pos_deliveries_guard    re-created: 116's rules, + the alert columns set once, + a final (canceled / failed) row
--                           may still receive the alert mark (the only change a final row allows besides
--                           last_polled_at).
--   pos_delivery_actions    action check: dispatch | cancel | + alert (pos-v1-delivery-alert's idempotency).
--   index                   pos_deliveries (restaurant_id, updated_at desc): the restaurant-wide read.
--
-- Access unchanged (115): pos_deliveries select insert update; pos_delivery_actions select insert update delete —
-- re-asserted (108 pattern; the new columns are covered by the table-level grant, verified column by column).
--
-- NOT APPLIED. Needs 115–117. Rollback: docs/migrations/118_rollback.sql. Smoke: docs/migrations/118_smoke.sql.
-- Verify: docs/migrations/118_verify.sql.

begin;

do $$
declare
  n int;
begin
  if to_regclass('public.pos_deliveries') is null or to_regclass('public.pos_delivery_actions') is null then
    raise exception '118: needs 115 (pos_deliveries, pos_delivery_actions)' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pos_deliveries' and column_name = 'canceled_by') then
    raise exception '118: needs 116 (pos_deliveries.canceled_by)' using errcode = '55000';
  end if;
  if to_regclass('public.pos_kitchenhub_item_maps') is null then
    raise exception '118: needs 117 (pos_kitchenhub_item_maps)' using errcode = '55000';
  end if;
  -- 115's inline check on pos_delivery_actions.action (Postgres names it <table>_<column>_check); found by definition
  select count(*) into n from pg_constraint
   where conrelid = 'public.pos_delivery_actions'::regclass and contype = 'c'
     and conname = 'pos_delivery_actions_action_check'
     and pg_get_constraintdef(oid) ilike '%dispatch%' and pg_get_constraintdef(oid) ilike '%cancel%';
  if n <> 1 then
    raise exception '118: expected 115''s pos_delivery_actions_action_check (dispatch, cancel), found %', n using errcode = '55000';
  end if;
end;
$$;

alter table public.pos_deliveries
  add column alert_handled_at        timestamptz,
  add column alert_handled_by        text check (alert_handled_by is null or alert_handled_by = 'register'
                                                 or alert_handled_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  add column alert_handled_device_id uuid references public.pos_devices(id),
  add column alert_choice            text check (alert_choice in ('in_house', 'acknowledged'));
alter table public.pos_deliveries
  add constraint pos_deliveries_alert_mark_complete check (
    (alert_handled_at is null) = (alert_handled_by is null)
    and (alert_handled_at is null) = (alert_handled_device_id is null)
    and (alert_handled_at is null) = (alert_choice is null));

create index pos_deliveries_restaurant_recent on public.pos_deliveries (restaurant_id, updated_at desc);

alter table public.pos_delivery_actions drop constraint pos_delivery_actions_action_check;
alter table public.pos_delivery_actions
  add constraint pos_delivery_actions_action_check check (action in ('dispatch', 'cancel', 'alert'));

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
     or (old.canceled_by is not null and new.canceled_by is distinct from old.canceled_by)          -- 116
     or (old.alert_handled_at is not null                                                            -- 118
         and (new.alert_handled_at, new.alert_handled_by, new.alert_handled_device_id, new.alert_choice)
             is distinct from (old.alert_handled_at, old.alert_handled_by, old.alert_handled_device_id, old.alert_choice)) then
    raise exception 'pos_deliveries: a provider id / ledger amount / the alert mark is set once' using errcode = '42501';
  end if;
  -- state machine
  if new.state is distinct from old.state and not (
       (old.state = 'booking' and new.state in ('booked', 'failed'))
    or (old.state = 'booked' and new.state in ('delivered', 'canceled'))) then
    raise exception 'pos_deliveries: % → % is not allowed', old.state, new.state using errcode = '42501';
  end if;
  -- a final row: only last_polled_at, updated_at and (118) the alert mark may change
  if old.state in ('failed', 'canceled') and new.state = old.state
     and (to_jsonb(new) - 'updated_at' - 'last_polled_at' - 'alert_handled_at' - 'alert_handled_by' - 'alert_handled_device_id' - 'alert_choice')
         is distinct from
         (to_jsonb(old) - 'updated_at' - 'last_polled_at' - 'alert_handled_at' - 'alert_handled_by' - 'alert_handled_device_id' - 'alert_choice') then
    raise exception 'pos_deliveries: a % delivery is final', old.state using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.pos_deliveries_guard() from public, anon, authenticated;

revoke all on table public.pos_deliveries, public.pos_delivery_actions from public, anon, authenticated, service_role;
grant select, insert, update         on table public.pos_deliveries       to service_role;  -- unchanged (115): no delete (guard)
grant select, insert, update, delete on table public.pos_delivery_actions to service_role;  -- unchanged (115): delete = release pending only

comment on column public.pos_deliveries.alert_handled_at is 'The every-register toast''s shared handled mark (set once, the first register wins): when.';
comment on column public.pos_deliveries.alert_choice is 'What staff did about a provider cancel / failed booking: in_house | acknowledged.';

commit;
