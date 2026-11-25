-- 110_smoke.sql — one-time smoke test of migration 110, run by Matt in the SQL editor AFTER 110 is applied, as
-- postgres. Everything after the restaurant lookup runs AS service_role (set local role), i.e. with exactly the
-- grants 110 leaves, through the same SQL functions _shared/pos-online/store.ts (PgOnlineStore) calls.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data.
--
-- No orders / external_orders / print_logs row is read or written: the print rows take an order_id with no FK, so
-- the smoke uses made-up order ids (11000000-…, never a real order). Two throwaway registers are created for Test
-- Pizza with prefixes nobody uses there yet. Test Pizza's pos_restaurant_settings row is upserted INSIDE the
-- rolled-back transaction only. Each function call is its own statement, checked in the next one (106 lesson).
-- Mirrors _shared/pos-online/tests/store.test.ts (MemoryOnlineStore = these functions).

begin;

do $$
declare
  n        int := 0;
  v_r      uuid;
  v_dev_a  uuid;
  v_dev_b  uuid;
  v_pfx    text[];
  v_o1     uuid := '11000000-0000-4000-8000-000000000001';
  v_o2     uuid := '11000000-0000-4000-8000-000000000002';
  v_o3     uuid := '11000000-0000-4000-8000-000000000003';
  v_o4     uuid := '11000000-0000-4000-8000-000000000004';
  v_st2    jsonb := '[{"station":"p-counter","name":"Counter","lines":[0,1]},{"station":"p-oven","name":"Pizza oven","lines":[0]}]';
  v_counter jsonb := '{"station":"p-counter","name":"Counter","lines":[0,1]}';
  v_oven   jsonb := '{"station":"p-oven","name":"Pizza oven","lines":[0]}';
  v_bar    jsonb := '{"station":"p-bar","name":"Bar","lines":[1]}';
  r        jsonb;
  q        text;
  v_refused text[];
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 2 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-110-a', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_a;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[2], 'smoke-110-b', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_b;

  -- 1. no print register → not_designated; register A, flags off → auto_print_off (both channels)
  update public.pos_restaurant_settings set print_register_device_id = null, online_auto_print_enabled = false,
         kitchenhub_auto_print_enabled = false where restaurant_id = v_r;
  r := public.pos_claim_online_print(v_r, 'ordr', v_o1, v_dev_a, v_st2, false);
  if r->>'outcome' <> 'not_designated' then raise exception 'SMOKE FAIL: 1 no register: %', r; end if;
  r := public.pos_set_print_register(v_r, v_dev_a, 'smoke-110');
  r := public.pos_claim_online_print(v_r, 'ordr', v_o1, v_dev_a, v_st2, false);
  if r->>'outcome' <> 'auto_print_off' then raise exception 'SMOKE FAIL: 1 ordr flag off: %', r; end if;
  update public.pos_restaurant_settings set online_auto_print_enabled = true where restaurant_id = v_r;
  r := public.pos_claim_online_print(v_r, 'kitchenhub', v_o4, v_dev_a, v_st2, false);
  if r->>'outcome' <> 'auto_print_off' then raise exception 'SMOKE FAIL: 1 kitchenhub flag off: %', r; end if;
  n := n + 1;

  -- 2. B (not the register) → not_designated; A claims (applied, 2 stations, counter first); A again → noop, claimed
  r := public.pos_claim_online_print(v_r, 'ordr', v_o1, v_dev_b, v_st2, false);
  if r->>'outcome' <> 'not_designated' then raise exception 'SMOKE FAIL: 2 non-register: %', r; end if;
  r := public.pos_claim_online_print(v_r, 'ordr', v_o1, v_dev_a, v_st2, false);
  if r->>'outcome' <> 'ok' or not (r->>'applied')::boolean or not (r->>'claimed')::boolean then raise exception 'SMOKE FAIL: 2 claim: %', r; end if;
  r := public.pos_claim_online_print(v_r, 'ordr', v_o1, v_dev_a, v_st2, false);
  if (r->>'applied')::boolean or not (r->>'claimed')::boolean then raise exception 'SMOKE FAIL: 2 re-claim: %', r; end if;
  if (select string_agg(station || ':' || position || ':' || coalesce(result, '-'), ',' order by position)
        from public.pos_online_print_stations where order_id = v_o1) <> 'p-counter:0:-,p-oven:1:-' then
    raise exception 'SMOKE FAIL: 2 station rows';
  end if;
  n := n + 1;

  -- 3. no takeover: the register moves to B → B's claim is a noop, claimed false
  r := public.pos_set_print_register(v_r, v_dev_b, 'smoke-110');
  r := public.pos_claim_online_print(v_r, 'ordr', v_o1, v_dev_b, v_st2, false);
  if r->>'outcome' <> 'ok' or (r->>'applied')::boolean or (r->>'claimed')::boolean then raise exception 'SMOKE FAIL: 3 takeover: %', r; end if;
  n := n + 1;

  -- 4. the counter prints → order result null (oven still printing); the oven prints → printed + printed_at
  r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_a, '11000000-0000-4000-8000-0000000000a1', 'auto', 'printed', v_counter, null, now());
  if r->>'outcome' <> 'recorded' or r->>'order_result' is not null then raise exception 'SMOKE FAIL: 4 counter: %', r; end if;
  r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_a, '11000000-0000-4000-8000-0000000000a2', 'auto', 'printed', v_oven, null, now());
  if r->>'order_result' <> 'printed' or (r->>'claimed_by')::uuid <> v_dev_a then raise exception 'SMOKE FAIL: 4 oven: %', r; end if;
  if (select result || ':' || (printed_at is not null) from public.pos_online_print_claims where order_id = v_o1) <> 'printed:true' then
    raise exception 'SMOKE FAIL: 4 claim row';
  end if;
  n := n + 1;

  -- 5. the same action_id again → duplicate (nothing logged twice)
  r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_a, '11000000-0000-4000-8000-0000000000a2', 'auto', 'printed', v_oven, null, now());
  if r->>'outcome' <> 'duplicate' then raise exception 'SMOKE FAIL: 5 duplicate: %', r; end if;
  if (select count(*) from public.pos_online_print_log where order_id = v_o1) <> 2 then raise exception 'SMOKE FAIL: 5 log rows'; end if;
  n := n + 1;

  -- 6. a failed auto result on a printed station leaves it printed; an unknown station is added (position 2) and its
  --    failure fails the order
  r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_a, '11000000-0000-4000-8000-0000000000a3', 'auto', 'failed', v_oven, 'Cover open', now());
  if r->>'order_result' <> 'printed' then raise exception 'SMOKE FAIL: 6 printed stays printed: %', r; end if;
  r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_b, '11000000-0000-4000-8000-0000000000a4', 'manual', 'failed', v_bar, 'Paper out', now());
  if r->>'order_result' <> 'failed' then raise exception 'SMOKE FAIL: 6 new station: %', r; end if;
  if (select position from public.pos_online_print_stations where order_id = v_o1 and station = 'p-bar') <> 2 then
    raise exception 'SMOKE FAIL: 6 new station position';
  end if;
  n := n + 1;

  -- 7. NOT CONFIRMED on a claimed order: the claimer's auto result printed_unconfirmed → order printed_unconfirmed;
  --    a reprint that prints settles it
  r := public.pos_set_print_register(v_r, v_dev_a, 'smoke-110');
  r := public.pos_claim_online_print(v_r, 'ordr', v_o2, v_dev_a, '[{"station":"p-counter","name":"Counter","lines":[0]}]', false);
  r := public.pos_record_online_print(v_r, 'ordr', v_o2, v_dev_a, '11000000-0000-4000-8000-0000000000b1', 'auto', 'printed_unconfirmed', '{"station":"p-counter","name":"Counter","lines":[0]}', null, now());
  if r->>'order_result' <> 'printed_unconfirmed' then raise exception 'SMOKE FAIL: 7 unconfirmed: %', r; end if;
  r := public.pos_record_online_print(v_r, 'ordr', v_o2, v_dev_b, '11000000-0000-4000-8000-0000000000b2', 'reprint', 'printed', '{"station":"p-counter","name":"Counter","lines":[0]}', null, now());
  if r->>'order_result' <> 'printed' then raise exception 'SMOKE FAIL: 7 reprint settles: %', r; end if;
  n := n + 1;

  -- 8. manual on an UNCLAIMED order claims it for that device; the register's auto claim then is a noop
  r := public.pos_record_online_print(v_r, 'ordr', v_o3, v_dev_b, '11000000-0000-4000-8000-0000000000c1', 'manual', 'printed', v_counter, null, now());
  if (r->>'claimed_by')::uuid <> v_dev_b then raise exception 'SMOKE FAIL: 8 manual claims: %', r; end if;
  r := public.pos_claim_online_print(v_r, 'ordr', v_o3, v_dev_a, v_st2, false);
  if (r->>'applied')::boolean or (r->>'claimed')::boolean then raise exception 'SMOKE FAIL: 8 auto after manual: %', r; end if;
  n := n + 1;

  -- 9. the tablet printed it (print_status printed) → never claimed; a failed reprint with no claim leaves a null
  --    station that the auto claim REPLACES with its own stations (applyClaim)
  r := public.pos_claim_online_print(v_r, 'ordr', v_o4, v_dev_a, v_st2, true);
  if (r->>'applied')::boolean then raise exception 'SMOKE FAIL: 9 tablet-printed claimed: %', r; end if;
  r := public.pos_record_online_print(v_r, 'ordr', v_o4, v_dev_b, '11000000-0000-4000-8000-0000000000d1', 'reprint', 'failed', v_bar, 'x', now());
  if r->>'order_result' is not null or r->>'claimed_by' is not null then raise exception 'SMOKE FAIL: 9 reprint: %', r; end if;
  r := public.pos_claim_online_print(v_r, 'ordr', v_o4, v_dev_a, v_st2, false);
  if not (r->>'applied')::boolean then raise exception 'SMOKE FAIL: 9 claim over a null station: %', r; end if;
  if (select string_agg(station, ',' order by position) from public.pos_online_print_stations where order_id = v_o4) <> 'p-counter,p-oven' then
    raise exception 'SMOKE FAIL: 9 stations replaced';
  end if;
  n := n + 1;

  -- 10. the state read: restaurant-scoped, counts
  r := public.pos_online_print_state(v_r, array[v_o1, v_o2, v_o3, v_o4]);
  if jsonb_array_length(r->'claims') <> 4 or jsonb_array_length(r->'stations') <> 7 or jsonb_array_length(r->'log') <> 8 then
    raise exception 'SMOKE FAIL: 10 state counts % % %', jsonb_array_length(r->'claims'), jsonb_array_length(r->'stations'), jsonb_array_length(r->'log');
  end if;
  r := public.pos_online_print_state(gen_random_uuid(), array[v_o1]);
  if jsonb_array_length(r->'claims') + jsonb_array_length(r->'stations') + jsonb_array_length(r->'log') <> 0 then
    raise exception 'SMOKE FAIL: 10 another restaurant sees rows';
  end if;
  n := n + 1;

  -- 11. bad input → 22023 (unknown variant; a result with no station)
  begin
    r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_a, gen_random_uuid(), 'bogus', 'printed', v_counter, null, now());
    raise exception 'SMOKE FAIL: 11 bad variant accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    r := public.pos_record_online_print(v_r, 'ordr', v_o1, v_dev_a, gen_random_uuid(), 'auto', 'printed', null, null, now());
    raise exception 'SMOKE FAIL: 11 no station accepted';
  exception when invalid_parameter_value then null;
  end;
  n := n + 1;

  -- 12. guard triggers (42501): a printed station can't go back; a station's lines can't change; a CLAIMED order's
  --     stations can't be deleted; the claimer can't change
  begin
    update public.pos_online_print_stations set result = 'failed' where order_id = v_o2 and station = 'p-counter';
    raise exception 'SMOKE FAIL: 12 printed station changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pos_online_print_stations set lines = '{5}' where order_id = v_o1 and station = 'p-bar';
    raise exception 'SMOKE FAIL: 12 lines changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.pos_online_print_stations where order_id = v_o1;
    raise exception 'SMOKE FAIL: 12 claimed stations deleted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pos_online_print_claims set device_id = v_dev_b where order_id = v_o1;
    raise exception 'SMOKE FAIL: 12 claimer changed';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  -- 13. forbidden by GRANTS (insufficient_privilege): delete claims / log, update log, delete settings
  v_refused := array[
    format('delete from public.pos_online_print_claims where order_id = %L', v_o2),
    format('update public.pos_online_print_log set error = %L where order_id = %L', 'x', v_o1),
    format('delete from public.pos_online_print_log where order_id = %L', v_o1),
    format('delete from public.pos_restaurant_settings where restaurant_id = %L', v_r)];
  foreach q in array v_refused loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: allowed as service_role: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  n := n + 1;

  -- 14. the rows the refused statements targeted are all still there
  if (select count(*) from public.pos_online_print_claims where order_id in (v_o1, v_o2, v_o3, v_o4)) <> 4
     or (select count(*) from public.pos_online_print_log where order_id = v_o1) <> 4
     or (select count(*) from public.pos_online_print_stations where order_id = v_o1) <> 3
     or (select count(*) from public.pos_restaurant_settings where restaurant_id = v_r) <> 1 then
    raise exception 'SMOKE FAIL: 14 a refused statement changed data';
  end if;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
