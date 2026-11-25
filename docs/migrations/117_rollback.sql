set lock_timeout = '3s';
-- 117_rollback.sql — undo migration 117: drop pos_kitchenhub_item_maps, pos_kitchenhub_menu_pulls,
-- pos_kitchenhub_item_map_change and pos_restaurant_settings.kitchenhub_fallback_category_id / kitchenhub_maps_rev;
-- restore 114's outcome
-- CHECK, release guard and release function (dispatch_delivery / self_deliver only). Run as postgres in the SQL editor.
-- Leaves 109–116.
--
-- The maps are staff work (each one confirmed by hand). If any map or a fallback category exists the rollback STOPS —
-- export them first — unless you run, in the same session:   set pos.rollback_117_discard = 'yes';
-- A PENDING ext_* action can't exist under 114's CHECK: the same setting deletes those pending rows (a KitchenHub
-- call may be in flight — look first). Completed ext_* rows (applied / noop / error) and the settings-function map
-- action rows are valid 114 rows and stay.
-- Roll back only with pos-v1-kitchenhub-items undeployed and pos-v1-online-order-action / -orders / -print /
-- -settings redeployed from before 117's commit (they read the maps; the ext_* actions need pending rows).

begin;

do $$
begin
  if (exists (select 1 from public.pos_kitchenhub_item_maps)
      or exists (select 1 from public.pos_restaurant_settings where kitchenhub_fallback_category_id is not null)
      or exists (select 1 from public.pos_online_actions
                  where outcome is null and function = 'order_action' and action in ('ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel')))
     and coalesce(current_setting('pos.rollback_117_discard', true), '') <> 'yes' then
    raise exception '117 rollback: item maps / a fallback category / a pending ext_* action exist — export / check them, then set pos.rollback_117_discard = ''yes'', or stop'
      using errcode = '55000';
  end if;
  -- runs as postgres; 117's release guard allows exactly these rows
  delete from public.pos_online_actions
   where outcome is null and function = 'order_action' and action in ('ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel');
end;
$$;

drop function if exists public.pos_kitchenhub_item_map_change(uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb, text, uuid, timestamptz);
drop table if exists public.pos_kitchenhub_item_maps;
drop table if exists public.pos_kitchenhub_menu_pulls;
alter table public.pos_restaurant_settings drop column if exists kitchenhub_fallback_category_id,
                                          drop column if exists kitchenhub_maps_rev;

-- 114's outcome CHECK, release guard and release function, verbatim
alter table public.pos_online_actions drop constraint pos_online_actions_outcome_check;
alter table public.pos_online_actions
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and (function = 'print'
                          or (function = 'order_action' and action in ('cancel_refund', 'dispatch_delivery', 'self_deliver'))))
    or (outcome is not null and outcome in ('applied', 'noop', 'error')));

create or replace function public.pos_online_actions_release_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.outcome is not null or old.function <> 'order_action' or old.action not in ('dispatch_delivery', 'self_deliver') then
    raise exception 'pos_online_actions: only a pending dispatch_delivery / self_deliver may be released' using errcode = '42501';
  end if;
  return old;
end;
$$;

create or replace function public.pos_online_action_release(p_action_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  select * into a from public.pos_online_actions where action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if a.device_id <> p_device_id then
    return jsonb_build_object('outcome', 'device_mismatch');
  end if;
  if a.outcome is not null or a.function <> 'order_action' or a.action not in ('dispatch_delivery', 'self_deliver') then
    return jsonb_build_object('outcome', 'not_pending');
  end if;
  delete from public.pos_online_actions where action_id = p_action_id;
  return jsonb_build_object('outcome', 'released');
end;
$$;

revoke all on table public.pos_online_actions, public.pos_restaurant_settings from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pos_online_actions      to service_role;  -- 114
grant select, insert, update         on table public.pos_restaurant_settings to service_role;  -- 109
revoke all on function public.pos_online_action_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pos_online_action_release(uuid, uuid) to service_role;
revoke all on function public.pos_online_actions_release_guard() from public, anon, authenticated;

commit;
