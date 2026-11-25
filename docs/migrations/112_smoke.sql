-- 112_smoke.sql — one-time smoke test of migration 112, run by Matt in the SQL editor AFTER 112 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role), through the same SQL function
-- _shared/pos-online/store.ts (PgOnlineStore.tabletSettingChange) calls. NOTHING PERSISTS (BEGIN … ROLLBACK).
-- Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'. Prints no row data.
--
-- Writes Test Pizza's OWN restaurants row (estimates, delivery_available) and ONE of its menu_items (is_available)
-- inside the rolled-back transaction — no insert into restaurants / menu_items. New values are chosen to differ
-- from the current ones. Two throwaway registers (free prefixes). Action ids 11200000-… (pos_online_actions PK).
-- Each function call is its own statement, checked in the next one (106 lesson).
-- Mirrors _shared/pos-online/tests/settings.test.ts (MemoryOnlineStore = this function).

begin;

do $$
declare
  n        int := 0;
  v_r      uuid;
  v_dev_a  uuid;
  v_pfx    text[];
  v_now    timestamptz := now();
  v_rest0  jsonb;
  v_item   uuid;
  v_item0  jsonb;
  v_other_item uuid;
  v_p0 int; v_d0 int; v_da0 boolean; v_av0 boolean;
  v_p1 int; v_d1 int;
  a1 uuid := '11200000-0000-4000-8000-000000000001';
  a2 uuid := '11200000-0000-4000-8000-000000000002';
  a3 uuid := '11200000-0000-4000-8000-000000000003';
  a4 uuid := '11200000-0000-4000-8000-000000000004';
  a5 uuid := '11200000-0000-4000-8000-000000000005';
  a6 uuid := '11200000-0000-4000-8000-000000000006';
  e1 uuid := '11200000-0000-4000-8000-0000000000e1';
  v_req    jsonb := '{"k":"smoke-112"}';
  v_staff  uuid := gen_random_uuid();
  v_mgr    uuid := gen_random_uuid();
  r        jsonb;
  v_written text[] := array['estimated_pickup_minutes', 'estimated_delivery_minutes', 'delivery_available', 'updated_at'];
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select to_jsonb(x), x.estimated_pickup_minutes, x.estimated_delivery_minutes, x.delivery_available
    into v_rest0, v_p0, v_d0, v_da0 from public.restaurants x where x.id = v_r;
  select m.id, to_jsonb(m), m.is_available into v_item, v_item0, v_av0
    from public.menu_items m where m.restaurant_id = v_r order by m.id limit 1;
  if v_item is null then raise exception 'SMOKE FAIL: Test Pizza has no menu_items'; end if;
  select m.id into v_other_item from public.menu_items m where m.restaurant_id <> v_r order by m.id limit 1;
  v_p1 := case when v_p0 = 17 then 18 else 17 end;
  v_d1 := case when v_d0 = 47 then 48 else 47 end;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 1 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;
  if exists (select 1 from public.pos_online_actions where action_id::text like '11200000-%') then
    raise exception 'SMOKE FAIL: an action id 11200000-… is already used';
  end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-112-a', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_a;

  -- 1. estimates: applied (the two columns), again (another id) → noop, same id → duplicate, same id + another body → reused
  r := public.pos_online_tablet_setting_change(a1, v_r, v_dev_a, 'estimates', v_p1, v_d1, null, null, v_req, v_staff::text, v_mgr, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 1 estimates: %', r; end if;
  if (select estimated_pickup_minutes <> v_p1 or estimated_delivery_minutes <> v_d1 from public.restaurants where id = v_r) then
    raise exception 'SMOKE FAIL: 1 estimate columns';
  end if;
  r := public.pos_online_tablet_setting_change(a2, v_r, v_dev_a, 'estimates', v_p1, v_d1, null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 1 estimates again: %', r; end if;
  r := public.pos_online_tablet_setting_change(a1, v_r, v_dev_a, 'estimates', v_p1, v_d1, null, null, v_req, v_staff::text, v_mgr, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'applied' then raise exception 'SMOKE FAIL: 1 duplicate: %', r; end if;
  r := public.pos_online_tablet_setting_change(a1, v_r, v_dev_a, 'estimates', v_p1, v_d1, null, null, '{"k":"other"}', v_staff::text, v_mgr, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 1 reused: %', r; end if;
  n := n + 1;

  -- 2. delivery_available → the opposite (applied), again → noop
  r := public.pos_online_tablet_setting_change(a3, v_r, v_dev_a, 'delivery_available', null, null, not v_da0, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select delivery_available from public.restaurants where id = v_r) <> (not v_da0) then
    raise exception 'SMOKE FAIL: 2 delivery_available: %', r;
  end if;
  r := public.pos_online_tablet_setting_change(a4, v_r, v_dev_a, 'delivery_available', null, null, not v_da0, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 2 delivery_available again: %', r; end if;
  n := n + 1;

  -- 3. the restaurants row: ONLY the tablet's columns changed (updated_at ignored if a trigger stamps it)
  if ((select to_jsonb(x) from public.restaurants x where x.id = v_r) - v_written) is distinct from (v_rest0 - v_written) then
    raise exception 'SMOKE FAIL: 3 another restaurants column changed';
  end if;
  n := n + 1;

  -- 4. item_availability: 86 one Test Pizza item (applied, is_available only), again → noop; unknown item / another
  --    restaurant's item → item_not_found (nothing written)
  r := public.pos_online_tablet_setting_change(a5, v_r, v_dev_a, 'item_availability', null, null, not v_av0, v_item, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 4 86: %', r; end if;
  if ((select to_jsonb(m) from public.menu_items m where m.id = v_item) - 'is_available' - 'updated_at') is distinct from (v_item0 - 'is_available' - 'updated_at')
     or (select is_available from public.menu_items where id = v_item) <> (not v_av0) then
    raise exception 'SMOKE FAIL: 4 menu_items columns';
  end if;
  r := public.pos_online_tablet_setting_change(a6, v_r, v_dev_a, 'item_availability', null, null, not v_av0, v_item, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 4 86 again: %', r; end if;
  r := public.pos_online_tablet_setting_change(e1, v_r, v_dev_a, 'item_availability', null, null, false, gen_random_uuid(), v_req, 'register', null, v_now);
  if r->>'outcome' <> 'item_not_found' then raise exception 'SMOKE FAIL: 4 unknown item: %', r; end if;
  if v_other_item is not null then
    r := public.pos_online_tablet_setting_change(e1, v_r, v_dev_a, 'item_availability', null, null, false, v_other_item, v_req, 'register', null, v_now);
    if r->>'outcome' <> 'item_not_found' then raise exception 'SMOKE FAIL: 4 another restaurant''s item: %', r; end if;
  end if;
  n := n + 1;

  -- 5. bad input → 22023; unknown device → device_not_allowed
  begin
    r := public.pos_online_tablet_setting_change(e1, v_r, v_dev_a, 'estimates', 0, 45, null, null, v_req, 'register', null, v_now);
    raise exception 'SMOKE FAIL: 5 estimates 0 accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    r := public.pos_online_tablet_setting_change(e1, v_r, v_dev_a, 'pause', null, null, true, null, v_req, 'register', null, v_now);
    raise exception 'SMOKE FAIL: 5 pause accepted';
  exception when invalid_parameter_value then null;
  end;
  r := public.pos_online_tablet_setting_change(e1, v_r, gen_random_uuid(), 'delivery_available', null, null, true, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'device_not_allowed' then raise exception 'SMOKE FAIL: 5 device: %', r; end if;
  n := n + 1;

  -- 6. the action rows: 6 (a1–a6: 3 applied + 3 noop), none for the errors; actor + approver recorded
  if (select count(*) from public.pos_online_actions where action_id::text like '11200000-%') <> 6
     or exists (select 1 from public.pos_online_actions where action_id = e1) then
    raise exception 'SMOKE FAIL: 6 action row counts';
  end if;
  if (select function <> 'settings' or action <> 'estimates' or outcome <> 'applied' or actor_staff_id <> v_staff::text
             or approver_staff_id <> v_mgr or order_id is not null
        from public.pos_online_actions where action_id = a1) then
    raise exception 'SMOKE FAIL: 6 the estimates action row';
  end if;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
