set lock_timeout = '3s';
-- 118_rollback.sql — undo migration 118: drop the alert-mark columns + their check + the restaurant index, restore
-- 116's pos_deliveries_guard (verbatim) and 115's pos_delivery_actions action check (dispatch | cancel). Run as postgres
-- in the SQL editor. Leaves 115–117.
--
-- The alert marks are staff actions; 'alert' rows in pos_delivery_actions can't exist under 115's check. If either
-- exists the rollback STOPS — unless you run, in the same session:   set pos.rollback_118_discard = 'yes';
-- which drops the marks and DELETES the 'alert' action rows (the actions guard is disabled for that one delete, inside
-- this transaction). Roll back only with pos-v1-delivery-alert undeployed and pos-v1-delivery-status /
-- pos-v1-delivery-dispatch / pos-v1-delivery-cancel redeployed from before 118's commit (they read the alert columns).

begin;

do $$
begin
  if (exists (select 1 from public.pos_deliveries where alert_handled_at is not null)
      or exists (select 1 from public.pos_delivery_actions where action = 'alert'))
     and coalesce(current_setting('pos.rollback_118_discard', true), '') <> 'yes' then
    raise exception '118 rollback: alert marks / alert actions exist — export them, then set pos.rollback_118_discard = ''yes'', or stop'
      using errcode = '55000';
  end if;
end;
$$;

alter table public.pos_delivery_actions disable trigger trg_pos_delivery_actions_guard;
delete from public.pos_delivery_actions where action = 'alert';
alter table public.pos_delivery_actions enable trigger trg_pos_delivery_actions_guard;

alter table public.pos_delivery_actions drop constraint pos_delivery_actions_action_check;
alter table public.pos_delivery_actions
  add constraint pos_delivery_actions_action_check check (action in ('dispatch', 'cancel'));

drop index if exists public.pos_deliveries_restaurant_recent;
alter table public.pos_deliveries
  drop constraint if exists pos_deliveries_alert_mark_complete,
  drop column if exists alert_handled_at,
  drop column if exists alert_handled_by,
  drop column if exists alert_handled_device_id,
  drop column if exists alert_choice;

-- 116's guard, verbatim
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

revoke all on table public.pos_deliveries, public.pos_delivery_actions from public, anon, authenticated, service_role;
grant select, insert, update         on table public.pos_deliveries       to service_role;  -- 115
grant select, insert, update, delete on table public.pos_delivery_actions to service_role;  -- 115

commit;
