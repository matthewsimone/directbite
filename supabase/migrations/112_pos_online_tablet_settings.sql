-- 112_pos_online_tablet_settings.sql — pos-v1-online-settings: the WEB TABLET's own settings from a register (CP18b;
-- ordr-pos @ 4f729e4 SYNC-CONTRACT §3c :647-671, src/dev/onlineSettingsRules.ts :7-14, :55-70).
--
-- ONE new function, nothing else. NO column / trigger / default / constraint on restaurants, menu_items, toppings
-- or any live-path table; 111's tables / functions unchanged.
--
--   pos_online_tablet_setting_change(…)  ONE transaction: idempotency by action_id (pos_online_actions, 111 shape:
--   function 'settings', action = the kind) + EXACTLY the web tablet's write + the action row:
--     estimates           restaurants.estimated_pickup_minutes / estimated_delivery_minutes
--                         (tablet SettingsTab.jsx saveOrdering :414-421 — the same two columns, the integer as typed)
--     delivery_available  restaurants.delivery_available   (tablet OrdersTab.jsx toggleDelivery :1873-1878)
--     item_availability   menu_items.is_available of one item of THIS restaurant   (tablet MenuTab.jsx
--                         toggleAvailability :81-84; "the current menu" = every menu_items row of the restaurant,
--                         _shared/pos-sync/menuSnapshot.ts getItems) — else item_not_found, nothing written
--   Absolute values: an UPDATE … WHERE <column> IS DISTINCT FROM <value>; no row changed → noop (no write).
--   None of these columns is admin-only (102_restaurants_tablet_guard.sql :40-50; its header :25-27 lists estimates
--   and delivery_available as tablet-written; 102 guards restaurants only, and service_role bypasses it, :56-58).
--   Validation (whole minutes 1–240, booleans) is the caller's (handlers.ts, the reference's 400s) and re-checked
--   here (22023).
--
-- Access: EXECUTE to service_role only; SECURITY INVOKER (service_role's existing privileges on restaurants /
-- menu_items — 112_verify checks them, grants nothing on live tables).
--
-- NOT APPLIED. Needs 111. Rollback: docs/migrations/112_rollback.sql. Smoke: docs/migrations/112_smoke.sql.
-- Verify: docs/migrations/112_verify.sql.

begin;

do $$
begin
  if to_regprocedure('public.pos_online_settings_change(uuid, uuid, uuid, text, uuid, boolean, jsonb, text, uuid, timestamptz)') is null then
    raise exception '112: migration 111 is not applied (pos_online_settings_change missing)' using errcode = '55000';
  end if;
end;
$$;

-- → device_not_allowed | action_id_reused | duplicate {stored} | item_not_found | applied | noop.
create or replace function public.pos_online_tablet_setting_change(
  p_action_id uuid, p_restaurant_id uuid, p_device_id uuid, p_kind text,
  p_pickup_minutes int, p_delivery_minutes int, p_on boolean, p_item_id uuid,
  p_request jsonb, p_actor text, p_approver uuid, p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a      public.pos_online_actions;
  v_hash text;
  v_now  timestamptz := now();
  v_out  text;
  v_n    int;
begin
  if p_kind is null or p_kind not in ('estimates', 'delivery_available', 'item_availability') then
    raise exception 'pos_online_tablet_setting_change: unknown kind %', p_kind using errcode = '22023';
  end if;
  if p_kind = 'estimates' and (p_pickup_minutes is null or p_pickup_minutes not between 1 and 240
                               or p_delivery_minutes is null or p_delivery_minutes not between 1 and 240) then
    raise exception 'pos_online_tablet_setting_change: estimates are whole minutes 1–240' using errcode = '22023';
  end if;
  if p_kind in ('delivery_available', 'item_availability') and p_on is null then
    raise exception 'pos_online_tablet_setting_change: on / available is required' using errcode = '22023';
  end if;
  if p_kind = 'item_availability' and p_item_id is null then
    raise exception 'pos_online_tablet_setting_change: item_id is required' using errcode = '22023';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_online_tablet_setting_change: request must be an object' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;

  v_hash := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('pos_online_action:' || p_action_id::text, 0));
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if found then
    if a.function <> 'settings' or a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id
       or a.action <> p_kind or a.request_hash <> v_hash then
      return jsonb_build_object('outcome', 'action_id_reused');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome);
  end if;

  if p_kind = 'estimates' then
    -- SettingsTab.jsx :414-421 (the two estimate columns; utensils_option_enabled is not part of this change)
    update public.restaurants
       set estimated_pickup_minutes = p_pickup_minutes, estimated_delivery_minutes = p_delivery_minutes
     where id = p_restaurant_id
       and (estimated_pickup_minutes, estimated_delivery_minutes) is distinct from (p_pickup_minutes, p_delivery_minutes);
  elsif p_kind = 'delivery_available' then
    -- OrdersTab.jsx toggleDelivery :1873-1878 (the tablet writes !current; the POS sends the absolute value)
    update public.restaurants set delivery_available = p_on
     where id = p_restaurant_id and delivery_available is distinct from p_on;
  else
    if not exists (select 1 from public.menu_items m where m.id = p_item_id and m.restaurant_id = p_restaurant_id) then
      return jsonb_build_object('outcome', 'item_not_found');
    end if;
    -- MenuTab.jsx toggleAvailability :81-84 (scoped to the restaurant as well)
    update public.menu_items set is_available = p_on
     where id = p_item_id and restaurant_id = p_restaurant_id and is_available is distinct from p_on;
  end if;
  get diagnostics v_n = row_count;
  v_out := case when v_n > 0 then 'applied' else 'noop' end;

  insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                         request, request_hash, outcome, actor_staff_id, approver_staff_id, device_time,
                                         created_at, completed_at)
  values (p_action_id, 'settings', p_restaurant_id, p_device_id, null, null, p_kind, p_request, v_hash, v_out,
          p_actor, p_approver, p_device_time, v_now, v_now);
  return jsonb_build_object('outcome', v_out);
end;
$$;

revoke all on function public.pos_online_tablet_setting_change(uuid, uuid, uuid, text, int, int, boolean, uuid, jsonb, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.pos_online_tablet_setting_change(uuid, uuid, uuid, text, int, int, boolean, uuid, jsonb, text, uuid, timestamptz)
  to service_role;

comment on function public.pos_online_tablet_setting_change(uuid, uuid, uuid, text, int, int, boolean, uuid, jsonb, text, uuid, timestamptz) is
  'pos-v1-online-settings: estimates / delivery_available / item_availability = the web tablet''s exact write + the action row, in one transaction.';

commit;
