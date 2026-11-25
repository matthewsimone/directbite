-- 117_smoke.sql — one-time smoke test of migration 117, run by Matt in the SQL editor AFTER 117 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role) with exactly the grants 117 leaves.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data. No KitchenHub call; external_orders / menu_items / menu_categories are only READ.
--
-- Uses Test Pizza (slug test): one of its menu items + one of its categories (read only), one throwaway register (a
-- free prefix). Action ids 11700000-…. Each statement is checked in the next one (106 lesson).

begin;

do $$
declare
  n      int := 0;
  v_r    uuid;
  v_dev  uuid;
  v_item uuid;
  v_cat  uuid;
  v_pfx  text[];
  v_now  timestamptz := now();
  v_ord  uuid := gen_random_uuid();          -- an external_orders-shaped id (pos_online_actions has no FK)
  a1 uuid := '11700000-0000-4000-8000-000000000001';
  a2 uuid := '11700000-0000-4000-8000-000000000002';
  a3 uuid := '11700000-0000-4000-8000-000000000003';
  a4 uuid := '11700000-0000-4000-8000-000000000004';
  a5 uuid := '11700000-0000-4000-8000-000000000005';
  a6 uuid := '11700000-0000-4000-8000-000000000006';
  a7 uuid := '11700000-0000-4000-8000-000000000007';
  a8 uuid := '11700000-0000-4000-8000-000000000008';
  a9 uuid := '11700000-0000-4000-8000-000000000009';
  r  jsonb;
  q  text;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select id into v_item from public.menu_items where restaurant_id = v_r order by id limit 1;
  select id into v_cat from public.menu_categories where restaurant_id = v_r order by id limit 1;
  if v_item is null or v_cat is null then raise exception 'SMOKE FAIL: Test Pizza needs a menu item and a category'; end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 1 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-117', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;

  -- 1. a pending ext_accept → released; a pending ext_ack → finished → not releasable, not deletable
  r := public.pos_online_action_begin(a1, 'order_action', v_r, v_dev, 'kitchenhub', v_ord, 'ext_accept', '{"k":"smoke-117"}', 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 1 begin ext_accept: %', r; end if;
  r := public.pos_online_action_release(a1, v_dev);
  if r->>'outcome' <> 'released' or exists (select 1 from public.pos_online_actions where action_id = a1) then raise exception 'SMOKE FAIL: 1 release: %', r; end if;
  r := public.pos_online_action_begin(a2, 'order_action', v_r, v_dev, 'kitchenhub', v_ord, 'ext_ack', '{"k":"smoke-117"}', 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 1 begin ext_ack: %', r; end if;
  r := public.pos_online_action_finish(a2, v_dev, 'applied', null, null, null);
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 1 finish: %', r; end if;
  r := public.pos_online_action_release(a2, v_dev);
  if r->>'outcome' <> 'not_pending' then raise exception 'SMOKE FAIL: 1 not_pending: %', r; end if;
  begin
    delete from public.pos_online_actions where action_id = a2;
    raise exception 'SMOKE FAIL: 1 a completed ext_ack was deleted';
  exception when insufficient_privilege then null;
  end;
  -- an order action that may NOT be pending (ack is single-statement) is still refused
  begin
    perform public.pos_online_action_begin(gen_random_uuid(), 'order_action', v_r, v_dev, 'kitchenhub', v_ord, 'accept', '{}', 'register', null, v_now);
    raise exception 'SMOKE FAIL: 1 a pending accept was accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 2. a name map → a menu item: applied, the same again (new action) → noop, the resend → duplicate, reused → 409
  r := public.pos_kitchenhub_item_map_change(a3, v_r, v_dev, 'set', 'name', 'doordash', 'cheese pizza', v_item, null, 'Cheese Pizza', '{"k":"a3"}', 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 2 set: %', r; end if;
  if not exists (select 1 from public.pos_kitchenhub_item_maps where restaurant_id = v_r and provider = 'doordash' and match_kind = 'name'
                  and match_key = 'cheese pizza' and menu_item_id = v_item and updated_by_device_id = v_dev) then
    raise exception 'SMOKE FAIL: 2 the map row';
  end if;
  r := public.pos_kitchenhub_item_map_change(a4, v_r, v_dev, 'set', 'name', 'doordash', 'cheese pizza', v_item, null, 'Cheese Pizza', '{"k":"a4"}', 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 2 same again: %', r; end if;
  r := public.pos_kitchenhub_item_map_change(a3, v_r, v_dev, 'set', 'name', 'doordash', 'cheese pizza', v_item, null, 'Cheese Pizza', '{"k":"a3"}', 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'applied' then raise exception 'SMOKE FAIL: 2 duplicate: %', r; end if;
  r := public.pos_kitchenhub_item_map_change(a3, v_r, v_dev, 'set', 'name', 'doordash', 'cheese pizza', v_item, null, 'Cheese Pizza', '{"k":"other"}', 'register', null, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 2 reused: %', r; end if;
  n := n + 1;

  -- 3. re-point it to a category (applied), an item / category not on the menu → *_not_found, a gone device → refused
  r := public.pos_kitchenhub_item_map_change(a5, v_r, v_dev, 'set', 'name', 'doordash', 'cheese pizza', null, v_cat, 'Cheese Pizza', '{"k":"a5"}', 'register', null, v_now);
  if r->>'outcome' <> 'applied' or not exists (select 1 from public.pos_kitchenhub_item_maps where match_key = 'cheese pizza' and restaurant_id = v_r
                                                  and category_id = v_cat and menu_item_id is null) then
    raise exception 'SMOKE FAIL: 3 re-point: %', r;
  end if;
  r := public.pos_kitchenhub_item_map_change(gen_random_uuid(), v_r, v_dev, 'set', 'item_id', '*', '12345', gen_random_uuid(), null, null, '{"k":"x"}', 'register', null, v_now);
  if r->>'outcome' <> 'item_not_found' then raise exception 'SMOKE FAIL: 3 item_not_found: %', r; end if;
  r := public.pos_kitchenhub_item_map_change(gen_random_uuid(), v_r, v_dev, 'set', 'item_id', '*', '12345', null, gen_random_uuid(), null, '{"k":"y"}', 'register', null, v_now);
  if r->>'outcome' <> 'category_not_found' then raise exception 'SMOKE FAIL: 3 category_not_found: %', r; end if;
  r := public.pos_kitchenhub_item_map_change(gen_random_uuid(), v_r, gen_random_uuid(), 'set', 'name', '*', 'x', v_item, null, null, '{}', 'register', null, v_now);
  if r->>'outcome' <> 'device_not_allowed' then raise exception 'SMOKE FAIL: 3 device_not_allowed: %', r; end if;
  begin
    perform public.pos_kitchenhub_item_map_change(gen_random_uuid(), v_r, v_dev, 'set', 'name', '*', 'x', v_item, v_cat, null, '{}', 'register', null, v_now);
    raise exception 'SMOKE FAIL: 3 both targets accepted';
  exception when invalid_parameter_value then null;
  end;
  n := n + 1;

  -- 4. clear (applied), clear again (noop)
  r := public.pos_kitchenhub_item_map_change(a6, v_r, v_dev, 'clear', 'name', 'doordash', 'cheese pizza', null, null, null, '{"k":"a6"}', 'register', null, v_now);
  if r->>'outcome' <> 'applied' or exists (select 1 from public.pos_kitchenhub_item_maps where restaurant_id = v_r and match_key = 'cheese pizza') then
    raise exception 'SMOKE FAIL: 4 clear: %', r;
  end if;
  r := public.pos_kitchenhub_item_map_change(a7, v_r, v_dev, 'clear', 'name', 'doordash', 'cheese pizza', null, null, null, '{"k":"a7"}', 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 4 clear again: %', r; end if;
  n := n + 1;

  -- 5. the fallback category: set → pos_restaurant_settings; clear → null
  r := public.pos_kitchenhub_item_map_change(a8, v_r, v_dev, 'set', 'fallback', null, null, null, v_cat, null, '{"k":"a8"}', 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select kitchenhub_fallback_category_id from public.pos_restaurant_settings where restaurant_id = v_r) is distinct from v_cat then
    raise exception 'SMOKE FAIL: 5 fallback set: %', r;
  end if;
  r := public.pos_kitchenhub_item_map_change(a9, v_r, v_dev, 'clear', 'fallback', null, null, null, null, null, '{"k":"a9"}', 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select kitchenhub_fallback_category_id from public.pos_restaurant_settings where restaurant_id = v_r) is not null then
    raise exception 'SMOKE FAIL: 5 fallback clear: %', r;
  end if;
  n := n + 1;

  -- 6. the menu pull cache: upsert (insert, then update); no delete / truncate
  insert into public.pos_kitchenhub_menu_pulls (restaurant_id, pulled_at, ok, providers) values (v_r, v_now, false, '[]')
  on conflict (restaurant_id) do update set pulled_at = excluded.pulled_at, ok = excluded.ok, providers = excluded.providers;
  insert into public.pos_kitchenhub_menu_pulls (restaurant_id, pulled_at, ok, providers)
  values (v_r, v_now, true, '[{"provider":"doordash","ok":true,"items":[{"item_id":null,"name":"Cheese Pizza"}]}]')
  on conflict (restaurant_id) do update set pulled_at = excluded.pulled_at, ok = excluded.ok, providers = excluded.providers;
  if not (select ok from public.pos_kitchenhub_menu_pulls where restaurant_id = v_r) then raise exception 'SMOKE FAIL: 6 upsert'; end if;
  foreach q in array array[
    format('delete from public.pos_kitchenhub_menu_pulls where restaurant_id = %L', v_r),
    'truncate public.pos_kitchenhub_item_maps'] loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: 6 allowed as service_role: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  n := n + 1;

  -- 7. a direct map row with no target / both targets → refused (check)
  begin
    insert into public.pos_kitchenhub_item_maps (restaurant_id, provider, match_kind, match_key, updated_by_device_id) values (v_r, '*', 'name', 'x', v_dev);
    raise exception 'SMOKE FAIL: 7 a map with no target';
  exception when check_violation then null;
  end;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
