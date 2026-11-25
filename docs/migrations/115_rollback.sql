set lock_timeout = '3s';
-- 115_rollback.sql — undo migration 115: drop the POS delivery tables + functions + guards and the
-- pos_restaurant_settings.pos_delivery_dispatch_enabled column. Run as postgres in the SQL editor. Leaves 109–114.
--
-- pos_deliveries is the provider LEDGER (what DirectBite / the restaurant owes Uber). If any delivery row exists the
-- rollback STOPS — export it first — unless you run, in the same session:   set pos.rollback_115_discard = 'yes';
-- Quotes / actions alone are disposable. Nothing outside pos_* is touched (no orders / uber_quotes rows were ever
-- written by 115's functions). Roll back only with pos-v1-quote-delivery / -delivery-dispatch / -delivery-cancel /
-- -delivery-status undeployed and pos-v1-submit-order redeployed without the deliveryQuotes lookup (else 500s on
-- quoted / uber delivery orders).

begin;

do $$
begin
  if exists (select 1 from public.pos_deliveries)
     and coalesce(current_setting('pos.rollback_115_discard', true), '') <> 'yes' then
    raise exception '115 rollback: pos_deliveries has rows (the provider ledger) — export them, then set pos.rollback_115_discard = ''yes'', or stop'
      using errcode = '55000';
  end if;
end;
$$;

drop function if exists public.pos_delivery_action_begin(uuid, uuid, uuid, uuid, text, jsonb, text, uuid, timestamptz);
drop function if exists public.pos_delivery_action_finish(uuid, uuid, text, int, text, text);
drop function if exists public.pos_delivery_action_release(uuid, uuid);
drop table if exists public.pos_delivery_actions;            -- its guard trigger goes with it
drop table if exists public.pos_deliveries;
drop table if exists public.pos_delivery_provider_quotes;
drop table if exists public.pos_delivery_quotes;
drop function if exists public.pos_delivery_actions_guard();
drop function if exists public.pos_deliveries_guard();
alter table public.pos_restaurant_settings drop column if exists pos_delivery_dispatch_enabled;

-- 109's grants on pos_restaurant_settings, exactly
revoke all on table public.pos_restaurant_settings from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_restaurant_settings to service_role;

commit;
