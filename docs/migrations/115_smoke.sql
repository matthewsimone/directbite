-- 115_smoke.sql — one-time smoke test of migration 115, run by Matt in the SQL editor AFTER 115 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role) with exactly the grants 115 leaves.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data. NO Uber / Google call (those are TS); only the pos_* tables, guards and action functions.
--
-- Uses ONE existing synced Test Pizza POS order (pos_deliveries.pos_order_id → pos_orders; the production smoke left
-- F-001) — read only; the delivery rows on it are rolled back. One throwaway register (a free prefix). Quote ids
-- dq_115… / pq_115…, action ids 11500000-…. Each statement is checked in the next one (106 lesson).

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
  a1 uuid := '11500000-0000-4000-8000-000000000001';
  a2 uuid := '11500000-0000-4000-8000-000000000002';
  a3 uuid := '11500000-0000-4000-8000-000000000003';
  a4 uuid := '11500000-0000-4000-8000-000000000004';
  dq text := 'dq_11500000000000000000000000000001';
  pq text := 'pq_11500000000000000000000000000001';
  r  jsonb;
  q  text;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select order_id into v_order from public.pos_orders where restaurant_id = v_r order by created_at limit 1;
  if v_order is null then raise exception 'SMOKE FAIL: needs one synced Test Pizza POS order (pos_orders)'; end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 1 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;
  if exists (select 1 from public.pos_deliveries where pos_order_id = v_order and state in ('booking', 'booked', 'delivered')) then
    raise exception 'SMOKE FAIL: the borrowed POS order already has a live delivery';
  end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-115', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;

  -- 1. quotes: the in-house quote + a provider quote whose split adds up; a split that doesn't add up / a bad id → refused
  insert into public.pos_delivery_quotes (id, restaurant_id, device_id, address, normalized_address, lat, lng, distance_miles, in_radius, tier,
                                          fee_cents, needs_confirmation, menu_snapshot_hash, expires_at)
  values (dq, v_r, v_dev, '{"street":"1 River St"}', '1 River St, Hoboken, NJ 07030, USA', 40.75, -74.03, 0.43, true, 1, 299, false, 'smoke', v_now + interval '24 hours');
  insert into public.pos_delivery_provider_quotes (id, provider, provider_quote_id, restaurant_id, device_id, delivery_quote_id, provider_fee_cents,
                                                   customer_fee_cents, restaurant_absorbs_cents, passthrough_mode, passthrough_value, billing_mode,
                                                   provider_environment, expires_at)
  values (pq, 'uber_direct', 'dqt_smoke_115', v_r, v_dev, dq, 900, 450, 450, 'split', 50, 'platform', 'sandbox', v_now + interval '10 minutes');
  begin
    insert into public.pos_delivery_provider_quotes (id, provider, provider_quote_id, restaurant_id, device_id, delivery_quote_id, provider_fee_cents,
                                                     customer_fee_cents, restaurant_absorbs_cents, passthrough_mode, passthrough_value, billing_mode,
                                                     provider_environment, expires_at)
    values ('pq_11500000000000000000000000000002', 'uber_direct', 'dqt_smoke_115b', v_r, v_dev, dq, 900, 450, 400, 'split', 50, 'platform', 'sandbox', v_now);
    raise exception 'SMOKE FAIL: 1 a split that does not add up was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.pos_delivery_quotes (id, restaurant_id, device_id, address, normalized_address, lat, lng, distance_miles, in_radius, tier,
                                            fee_cents, needs_confirmation, menu_snapshot_hash, expires_at)
    values ('dq_BAD', v_r, v_dev, '{}', 'x', 0, 0, 0, false, null, null, false, 'smoke', v_now + interval '1 hour');
    raise exception 'SMOKE FAIL: 1 a bad quote id was accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 2. one live booking per order: booking → a second booking on the same order → unique_violation
  insert into public.pos_deliveries (pos_order_id, restaurant_id, provider, state, action_id, provider_quote_ref, customer_fee_cents, driver_tip_cents,
                                     billing_mode, provider_environment)
  values (v_order, v_r, 'uber_direct', 'booking', a1, pq, 450, 300, 'platform', 'sandbox') returning id into v_del;
  begin
    insert into public.pos_deliveries (pos_order_id, restaurant_id, provider, state, action_id, customer_fee_cents, billing_mode, provider_environment)
    values (v_order, v_r, 'uber_direct', 'booking', a2, 450, 'platform', 'sandbox');
    raise exception 'SMOKE FAIL: 2 a second live booking was accepted';
  exception when unique_violation then null;
  end;
  n := n + 1;

  -- 3. booked needs the provider id (CHECK); then booked with it; the id / ledger / identity are set once (guard 42501)
  begin
    update public.pos_deliveries set state = 'booked' where id = v_del;
    raise exception 'SMOKE FAIL: 3 booked without a provider id';
  exception when check_violation then null;
  end;
  update public.pos_deliveries set state = 'booked', provider_delivery_id = 'del_smoke_115', provider_fee_cents = 900, restaurant_absorbs_cents = 450,
         provider_quote_id = 'dqt_smoke_115', dispatched_at = v_now where id = v_del;
  foreach q in array array[
    format('update public.pos_deliveries set provider_delivery_id = %L where id = %L', 'del_other', v_del),
    format('update public.pos_deliveries set provider_fee_cents = 1 where id = %L', v_del),
    format('update public.pos_deliveries set customer_fee_cents = 1 where id = %L', v_del),
    format('update public.pos_deliveries set driver_tip_cents = 0 where id = %L', v_del),
    format('update public.pos_deliveries set state = %L, failure_code = %L where id = %L', 'failed', 'x', v_del)] loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: 3 the guard allowed: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  -- a status refresh on a booked one is fine
  update public.pos_deliveries set provider_status = 'pickup', status_updated_at = v_now, courier = '{"name":"Sam","phone":null}' where id = v_del;
  n := n + 1;

  -- 4. booked → canceled (+ the cancellation fee, once); a canceled one is final; a NEW booking is then allowed
  update public.pos_deliveries set state = 'canceled', canceled_at = v_now, cancellation_fee_cents = 0 where id = v_del;
  begin
    update public.pos_deliveries set provider_status = 'pending' where id = v_del;
    raise exception 'SMOKE FAIL: 4 a canceled delivery changed';
  exception when insufficient_privilege then null;
  end;
  insert into public.pos_deliveries (pos_order_id, restaurant_id, provider, state, action_id, customer_fee_cents, billing_mode, provider_environment)
  values (v_order, v_r, 'uber_direct', 'booking', a2, 450, 'platform', 'sandbox') returning id into v_del2;
  update public.pos_deliveries set state = 'failed', failure_code = 'rate_limited' where id = v_del2;
  n := n + 1;

  -- 5. never deleted (no DELETE grant); quotes immutable (no UPDATE grant); no TRUNCATE
  foreach q in array array[
    format('delete from public.pos_deliveries where id = %L', v_del),
    format('update public.pos_delivery_quotes set fee_cents = 1 where id = %L', dq),
    format('update public.pos_delivery_provider_quotes set customer_fee_cents = 1 where id = %L', pq),
    'truncate public.pos_delivery_actions'] loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: 5 allowed as service_role: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  n := n + 1;

  -- 6. actions: begin → started → pending (+ since) → finish error (stored) → duplicate with the stored error
  r := public.pos_delivery_action_begin(a3, v_r, v_dev, v_order, 'dispatch', '{"k":"smoke-115"}', 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 6 begin: %', r; end if;
  r := public.pos_delivery_action_begin(a3, v_r, v_dev, v_order, 'dispatch', '{"k":"smoke-115"}', 'register', null, v_now);
  if r->>'outcome' <> 'pending' or r->>'since' is null then raise exception 'SMOKE FAIL: 6 pending: %', r; end if;
  r := public.pos_delivery_action_finish(a3, v_dev, 'error', 409, 'quote_price_changed', '{"message":"x","quote":{}}');
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 6 finish: %', r; end if;
  r := public.pos_delivery_action_begin(a3, v_r, v_dev, v_order, 'dispatch', '{"k":"smoke-115"}', 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'error' or r->>'error_code' <> 'quote_price_changed' then raise exception 'SMOKE FAIL: 6 duplicate: %', r; end if;
  r := public.pos_delivery_action_begin(a3, v_r, v_dev, v_order, 'dispatch', '{"k":"other"}', 'register', null, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 6 reused: %', r; end if;
  n := n + 1;

  -- 7. release: a pending action → released (gone); a completed one → not_pending, and a direct delete → 42501
  r := public.pos_delivery_action_begin(a4, v_r, v_dev, v_order, 'cancel', '{"k":"smoke-115"}', 'register', null, v_now);
  r := public.pos_delivery_action_release(a4, gen_random_uuid());
  if r->>'outcome' <> 'device_mismatch' then raise exception 'SMOKE FAIL: 7 device_mismatch: %', r; end if;
  r := public.pos_delivery_action_release(a4, v_dev);
  if r->>'outcome' <> 'released' or exists (select 1 from public.pos_delivery_actions where action_id = a4) then raise exception 'SMOKE FAIL: 7 released: %', r; end if;
  r := public.pos_delivery_action_release(a3, v_dev);
  if r->>'outcome' <> 'not_pending' then raise exception 'SMOKE FAIL: 7 not_pending: %', r; end if;
  begin
    delete from public.pos_delivery_actions where action_id = a3;
    raise exception 'SMOKE FAIL: 7 a completed action was deleted';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  -- 8. the dispatch switch: readable, false unless a restaurant turned it on
  perform pos_delivery_dispatch_enabled from public.pos_restaurant_settings where restaurant_id = v_r;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
