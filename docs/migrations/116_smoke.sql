-- 116_smoke.sql — one-time smoke test of migration 116, run by Matt in the SQL editor AFTER 116 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role) with exactly the grants 116 leaves.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data. Only pos_deliveries (+ one throwaway register); no Uber call.
--
-- Borrows ONE existing synced Test Pizza POS order (read only; the delivery rows on it are rolled back), like 115's
-- smoke. Action ids 11600000-…. Each statement is checked in the next one (106 lesson).

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
  v_del2  uuid;
  a1 uuid := '11600000-0000-4000-8000-000000000001';
  a2 uuid := '11600000-0000-4000-8000-000000000002';
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
  values (v_r, v_pfx[1], 'smoke-116', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;

  -- 1. a booking with the phone-call quote (Uber 900, customer locked at 450)
  insert into public.pos_deliveries (pos_order_id, restaurant_id, provider, state, action_id, customer_fee_cents, quoted_provider_fee_cents,
                                     billing_mode, provider_environment)
  values (v_order, v_r, 'uber_direct', 'booking', a1, 450, 900, 'platform', 'sandbox') returning id into v_del;
  if (select quoted_provider_fee_cents from public.pos_deliveries where id = v_del) is distinct from 900 then
    raise exception 'SMOKE FAIL: 1 quoted_provider_fee_cents not stored';
  end if;
  n := n + 1;

  -- 2. absorbs must be exactly provider − customer: 1400 / 500 → refused; then Uber got CHEAPER: 300 / −150 → stored
  begin
    update public.pos_deliveries set state = 'booked', provider_delivery_id = 'del_smoke_116', provider_fee_cents = 1400,
           restaurant_absorbs_cents = 500, dispatched_at = v_now where id = v_del;
    raise exception 'SMOKE FAIL: 2 an absorb that is not provider − customer was accepted';
  exception when check_violation then null;
  end;
  update public.pos_deliveries set state = 'booked', provider_delivery_id = 'del_smoke_116', provider_fee_cents = 300,
         restaurant_absorbs_cents = -150, dispatched_at = v_now where id = v_del;
  if (select restaurant_absorbs_cents from public.pos_deliveries where id = v_del) is distinct from -150 then
    raise exception 'SMOKE FAIL: 2 the negative absorb was not stored';
  end if;
  n := n + 1;

  -- 3. quoted_provider_fee_cents is immutable (guard 42501); canceled_by only with state canceled (check)
  foreach q in array array[
    format('update public.pos_deliveries set quoted_provider_fee_cents = 1 where id = %L', v_del),
    format('update public.pos_deliveries set quoted_provider_fee_cents = null where id = %L', v_del)] loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: 3 the guard allowed: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    update public.pos_deliveries set canceled_by = 'provider' where id = v_del;
    raise exception 'SMOKE FAIL: 3 canceled_by on a booked delivery';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 4. canceled needs canceled_by; a bad value is refused; restaurant + a 725 fee → stored; then final
  begin
    update public.pos_deliveries set state = 'canceled', canceled_at = v_now where id = v_del;
    raise exception 'SMOKE FAIL: 4 canceled without canceled_by';
  exception when check_violation then null;
  end;
  begin
    update public.pos_deliveries set state = 'canceled', canceled_by = 'customer', canceled_at = v_now where id = v_del;
    raise exception 'SMOKE FAIL: 4 canceled_by customer accepted';
  exception when check_violation then null;
  end;
  update public.pos_deliveries set state = 'canceled', canceled_by = 'restaurant', canceled_at = v_now, cancellation_fee_cents = 725 where id = v_del;
  begin
    update public.pos_deliveries set canceled_by = 'provider' where id = v_del;
    raise exception 'SMOKE FAIL: 4 canceled_by changed';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  -- 5. a provider cancel (no fee) on a new booking; a row from before 116 (no quoted fee) still books
  insert into public.pos_deliveries (pos_order_id, restaurant_id, provider, state, action_id, customer_fee_cents, billing_mode, provider_environment)
  values (v_order, v_r, 'uber_direct', 'booking', a2, 450, 'platform', 'sandbox') returning id into v_del2;
  update public.pos_deliveries set state = 'booked', provider_delivery_id = 'del_smoke_116b', provider_fee_cents = 900,
         restaurant_absorbs_cents = 450, dispatched_at = v_now where id = v_del2;
  update public.pos_deliveries set state = 'canceled', canceled_by = 'provider', canceled_at = v_now where id = v_del2;
  if (select canceled_by from public.pos_deliveries where id = v_del2) is distinct from 'provider' then
    raise exception 'SMOKE FAIL: 5 provider cancel not stored';
  end if;
  n := n + 1;

  -- 6. still never deleted
  begin
    delete from public.pos_deliveries where id = v_del2;
    raise exception 'SMOKE FAIL: 6 a delivery was deleted';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
