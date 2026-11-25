-- 118_smoke.sql — one-time smoke test of migration 118, run by Matt in the SQL editor AFTER 118 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role) with exactly the grants 118 leaves.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data. No Uber call; only pos_deliveries / pos_delivery_actions (+ one throwaway register).
--
-- Borrows ONE existing synced Test Pizza POS order (read only; the delivery rows on it are rolled back), like 115 /
-- 116's smokes. Action ids 11800000-…. Each statement is checked in the next one (106 lesson).

begin;

do $$
declare
  n       int := 0;
  v_r     uuid;
  v_dev   uuid;
  v_order uuid;
  v_pfx   text[];
  v_now   timestamptz := now();
  v_del   uuid;
  v_rows  int;
  a1 uuid := '11800000-0000-4000-8000-000000000001';
  a2 uuid := '11800000-0000-4000-8000-000000000002';
  r  jsonb;
  q  text;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select order_id into v_order from public.pos_orders where restaurant_id = v_r order by created_at limit 1;
  if v_order is null then raise exception 'SMOKE FAIL: needs one synced Test Pizza POS order (pos_orders)'; end if;
  if exists (select 1 from public.pos_deliveries where pos_order_id = v_order and state in ('booking', 'booked', 'delivered')) then
    raise exception 'SMOKE FAIL: the borrowed POS order already has a live delivery';
  end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 1 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-118', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;

  -- 1. a delivery Uber canceled: booking → booked → canceled by the provider (a final row)
  insert into public.pos_deliveries (pos_order_id, restaurant_id, provider, state, action_id, customer_fee_cents, quoted_provider_fee_cents,
                                     billing_mode, provider_environment)
  values (v_order, v_r, 'uber_direct', 'booking', a1, 450, 900, 'platform', 'production') returning id into v_del;
  update public.pos_deliveries set state = 'booked', provider_delivery_id = 'del_smoke_118', provider_fee_cents = 900,
         restaurant_absorbs_cents = 450, dispatched_at = v_now where id = v_del;
  update public.pos_deliveries set state = 'canceled', canceled_by = 'provider', canceled_at = v_now where id = v_del;
  if (select alert_handled_at from public.pos_deliveries where id = v_del) is not null then raise exception 'SMOKE FAIL: 1 a fresh row is marked'; end if;
  n := n + 1;

  -- 2. the mark is all-or-nothing (check) and alert_choice in in_house | acknowledged (check)
  begin
    update public.pos_deliveries set alert_handled_at = v_now where id = v_del;
    raise exception 'SMOKE FAIL: 2 a partial mark was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.pos_deliveries set alert_handled_at = v_now, alert_handled_by = 'register', alert_handled_device_id = v_dev,
           alert_choice = 'refund' where id = v_del;
    raise exception 'SMOKE FAIL: 2 alert_choice refund accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 3. the first register's mark on the FINAL row: allowed (the conditional update the server runs → 1 row)
  update public.pos_deliveries set alert_handled_at = v_now, alert_handled_by = 'register', alert_handled_device_id = v_dev,
         alert_choice = 'in_house' where id = v_del and alert_handled_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'SMOKE FAIL: 3 the first mark updated % rows', v_rows; end if;
  n := n + 1;

  -- 4. a second register's conditional mark → 0 rows; a direct change → 42501 (set once); the row stays final otherwise
  update public.pos_deliveries set alert_handled_at = v_now, alert_handled_by = 'register', alert_handled_device_id = v_dev,
         alert_choice = 'acknowledged' where id = v_del and alert_handled_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'SMOKE FAIL: 4 a second mark updated % rows', v_rows; end if;
  foreach q in array array[
    format('update public.pos_deliveries set alert_choice = %L where id = %L', 'acknowledged', v_del),
    format('update public.pos_deliveries set provider_status = %L where id = %L', 'pending', v_del)] loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: 4 the guard allowed: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  if (select alert_choice from public.pos_deliveries where id = v_del) is distinct from 'in_house' then
    raise exception 'SMOKE FAIL: 4 the first mark changed';
  end if;
  n := n + 1;

  -- 5. the 'alert' action (pos-v1-delivery-alert's idempotency): begin → finish; an unknown action → refused (check)
  r := public.pos_delivery_action_begin(a2, v_r, v_dev, v_order, 'alert', '{"k":"smoke-118"}', 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 5 begin alert: %', r; end if;
  r := public.pos_delivery_action_finish(a2, v_dev, 'applied', null, null, null);
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 5 finish: %', r; end if;
  begin
    perform public.pos_delivery_action_begin(gen_random_uuid(), v_r, v_dev, v_order, 'refund', '{}', 'register', null, v_now);
    raise exception 'SMOKE FAIL: 5 action refund accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 6. still never deleted
  begin
    delete from public.pos_deliveries where id = v_del;
    raise exception 'SMOKE FAIL: 6 a delivery was deleted';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
