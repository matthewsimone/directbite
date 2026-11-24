-- 109_smoke.sql — one-time smoke test of migration 109, run by Matt in the SQL editor AFTER 101, 105 and 109
-- are applied, as postgres. Everything after the restaurant lookup runs AS service_role (set local role), i.e.
-- with exactly the grants 109 leaves, through the same SQL functions _shared/pos-online/store.ts calls.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data.
--
-- No orders / order_items / print_logs row is read or written: claim and action rows take an order_id with no
-- FK, so the smoke uses made-up order ids (10900000-…, never a real order). Two throwaway registers are
-- created for Test Pizza with prefixes nobody uses there yet. Refusal probes only target rows this smoke
-- created. No TRUNCATE probes (109_verify.sql covers TRUNCATE).
--
-- Each function call is its own statement and is checked in the next one (the 106_smoke check 4 / 14 lesson).

begin;

do $$
declare
  n        int := 0;
  v_r      uuid;
  v_other  uuid;
  v_dev_a  uuid;
  v_dev_b  uuid;
  v_dev_x  uuid;
  v_pfx    text[];
  v_o1     uuid := '10900000-0000-4000-8000-000000000001';
  v_o2     uuid := '10900000-0000-4000-8000-000000000002';
  v_o3     uuid := '10900000-0000-4000-8000-000000000003';
  v_act    uuid := '10900000-0000-4000-8000-0000000000a1';
  v_req    jsonb := '{"action":"ack","order_id":"10900000-0000-4000-8000-000000000003"}';
  r        jsonb;
  q        text;
  v_refused text[];
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select id into v_other from public.restaurants where id <> v_r order by id limit 1;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 2 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-109-a', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_a;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[2], 'smoke-109-b', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_b;

  -- 1. auto-print is off until a register is set
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_a);
  if r->>'outcome' <> 'not_print_register' then raise exception 'SMOKE FAIL: 1 claim before a register is set: %', r->>'outcome'; end if;
  n := n + 1;

  -- 2. set register A (function), read it back
  r := public.pos_set_print_register(v_r, v_dev_a, 'smoke-109');
  if (select print_register_device_id from public.pos_restaurant_settings where restaurant_id = v_r) <> v_dev_a then
    raise exception 'SMOKE FAIL: 2 print register not set';
  end if;
  n := n + 1;

  -- 3. guard: a register of ANOTHER restaurant is refused (skipped when Test Pizza is the only restaurant)
  if v_other is not null then
    insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
    values (v_other, 'QA', 'smoke-109-x', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active')
    on conflict (restaurant_id, prefix) do nothing returning id into v_dev_x;
    if v_dev_x is not null then
      begin
        r := public.pos_set_print_register(v_r, v_dev_x, 'smoke-109');
        raise exception 'SMOKE FAIL: 3 another restaurant''s register accepted';
      exception when check_violation then null;
      end;
    end if;
  end if;
  n := n + 1;

  -- 4. B (not the register) can't claim; A claims attempt 1; A again → same attempt (idempotent)
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_b);
  if r->>'outcome' <> 'not_print_register' then raise exception 'SMOKE FAIL: 4 non-register claimed: %', r->>'outcome'; end if;
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_a);
  if r->>'outcome' <> 'claimed' or (r->>'attempt')::int <> 1 or (r->>'takeover')::boolean then raise exception 'SMOKE FAIL: 4 first claim: %', r; end if;
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_a);
  if r->>'outcome' <> 'claimed' or (r->>'attempt')::int <> 1 then raise exception 'SMOKE FAIL: 4 re-claim: %', r; end if;
  n := n + 1;

  -- 5. register moves to B while A holds the lease → held; lease runs out → B takes over (attempt 2)
  r := public.pos_set_print_register(v_r, v_dev_b, 'smoke-109');
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_b);
  if r->>'outcome' <> 'held' or (r->>'device_id')::uuid <> v_dev_a then raise exception 'SMOKE FAIL: 5 held: %', r; end if;
  update public.pos_online_print_claims set claimed_at = now() - interval '61 seconds' where order_id = v_o1;
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_b);
  if r->>'outcome' <> 'claimed' or (r->>'attempt')::int <> 2 or not (r->>'takeover')::boolean then raise exception 'SMOKE FAIL: 5 takeover: %', r; end if;
  n := n + 1;

  -- 6. A finishes late → lease_lost (logged, claim unchanged); B finishes printed → recorded; again → duplicate;
  --    claim again → already_printed
  r := public.pos_finish_online_print(v_r, v_o1, v_dev_a, 1, 'printed', '{"source":"smoke"}');
  if r->>'outcome' <> 'lease_lost' then raise exception 'SMOKE FAIL: 6 late finish: %', r; end if;
  r := public.pos_finish_online_print(v_r, v_o1, v_dev_b, 2, 'printed', '{}');
  if r->>'outcome' <> 'recorded' then raise exception 'SMOKE FAIL: 6 finish: %', r; end if;
  r := public.pos_finish_online_print(v_r, v_o1, v_dev_b, 2, 'printed', '{}');
  if r->>'outcome' <> 'duplicate' then raise exception 'SMOKE FAIL: 6 duplicate finish: %', r; end if;
  r := public.pos_claim_online_print(v_r, v_o1, v_dev_b);
  if r->>'outcome' <> 'already_printed' or (r->>'attempt')::int <> 2 then raise exception 'SMOKE FAIL: 6 already printed: %', r; end if;
  n := n + 1;

  -- 7. log: claimed 1, claimed 2 (takeover), printed 1 (lease_lost), printed 2
  if (select count(*) from public.pos_online_print_log where order_id = v_o1) <> 4
     or (select count(*) from public.pos_online_print_log where order_id = v_o1 and detail->>'lease_lost' = 'true') <> 1
     or (select count(*) from public.pos_online_print_log where order_id = v_o1 and detail->>'takeover' = 'true') <> 1 then
    raise exception 'SMOKE FAIL: 7 print log rows';
  end if;
  n := n + 1;

  -- 8. failed three times → attempts_exhausted
  r := public.pos_claim_online_print(v_r, v_o2, v_dev_b);
  r := public.pos_finish_online_print(v_r, v_o2, v_dev_b, 1, 'failed', '{"error":"cover open"}');
  if r->>'outcome' <> 'recorded' then raise exception 'SMOKE FAIL: 8 fail 1: %', r; end if;
  r := public.pos_claim_online_print(v_r, v_o2, v_dev_b);
  if (r->>'attempt')::int <> 2 then raise exception 'SMOKE FAIL: 8 claim 2: %', r; end if;
  r := public.pos_finish_online_print(v_r, v_o2, v_dev_b, 2, 'failed', '{}');
  r := public.pos_claim_online_print(v_r, v_o2, v_dev_b);
  if (r->>'attempt')::int <> 3 then raise exception 'SMOKE FAIL: 8 claim 3: %', r; end if;
  r := public.pos_finish_online_print(v_r, v_o2, v_dev_b, 3, 'failed', '{}');
  r := public.pos_claim_online_print(v_r, v_o2, v_dev_b);
  if r->>'outcome' <> 'attempts_exhausted' then raise exception 'SMOKE FAIL: 8 exhausted: %', r; end if;
  n := n + 1;

  -- 9. finish of an order nobody claimed; bad result → 22023
  r := public.pos_finish_online_print(v_r, v_o3, v_dev_b, 1, 'printed', '{}');
  if r->>'outcome' <> 'not_claimed' then raise exception 'SMOKE FAIL: 9 not claimed: %', r; end if;
  begin
    r := public.pos_finish_online_print(v_r, v_o2, v_dev_b, 3, 'claimed', '{}');
    raise exception 'SMOKE FAIL: 9 result claimed accepted';
  exception when invalid_parameter_value then null;
  end;
  n := n + 1;

  -- 10. actions: started → pending → completed → duplicate (stored result) → reuse refused; complete twice refused
  r := public.pos_online_action_begin(v_act, v_r, v_dev_a, null, v_o3, 'ack', v_req);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 10 begin: %', r; end if;
  r := public.pos_online_action_begin(v_act, v_r, v_dev_a, null, v_o3, 'ack', v_req);
  if r->>'outcome' <> 'pending' then raise exception 'SMOKE FAIL: 10 pending: %', r; end if;
  r := public.pos_online_action_complete(v_act, v_dev_b, '{"ok":true}', 200);
  if r->>'outcome' <> 'device_mismatch' then raise exception 'SMOKE FAIL: 10 other device completed: %', r; end if;
  r := public.pos_online_action_complete(v_act, v_dev_a, '{"ok":true}', 200);
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 10 complete: %', r; end if;
  r := public.pos_online_action_begin(v_act, v_r, v_dev_a, null, v_o3, 'ack', v_req);
  if r->>'outcome' <> 'duplicate' or (r->>'http_status')::int <> 200 or r->'result' <> '{"ok":true}'::jsonb then
    raise exception 'SMOKE FAIL: 10 duplicate: %', r;
  end if;
  r := public.pos_online_action_begin(v_act, v_r, v_dev_a, null, v_o3, 'ack', v_req || '{"x":1}');
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 10 reuse: %', r; end if;
  r := public.pos_online_action_complete(v_act, v_dev_a, '{"ok":false}', 500);
  if r->>'outcome' <> 'already_completed' then raise exception 'SMOKE FAIL: 10 complete twice: %', r; end if;
  n := n + 1;

  -- 11. guard triggers: a printed claim and a completed action can't be changed (42501)
  begin
    update public.pos_online_print_claims set result = 'failed', finished_at = now() where order_id = v_o1;
    raise exception 'SMOKE FAIL: 11 printed claim changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pos_online_actions set http_status = 500 where action_id = v_act;
    raise exception 'SMOKE FAIL: 11 completed action changed';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  -- 12. every forbidden UPDATE / DELETE is refused with insufficient_privilege (grants, not triggers)
  v_refused := array[
    format('delete from public.pos_restaurant_settings where restaurant_id = %L', v_r),
    format('delete from public.pos_online_print_claims where order_id = %L', v_o2),
    format('update public.pos_online_print_log set detail = %L where order_id = %L', '{}', v_o1),
    format('delete from public.pos_online_print_log where order_id = %L', v_o1),
    format('delete from public.pos_online_actions where action_id = %L', v_act)];
  foreach q in array v_refused loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: allowed as service_role: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  n := n + 1;

  -- 13. the rows the refused statements targeted are all still there
  if (select count(*) from public.pos_restaurant_settings where restaurant_id = v_r) <> 1
     or (select count(*) from public.pos_online_print_claims where order_id in (v_o1, v_o2)) <> 2
     or (select count(*) from public.pos_online_print_log where order_id = v_o1) <> 4
     or (select count(*) from public.pos_online_actions where action_id = v_act and http_status = 200) <> 1 then
    raise exception 'SMOKE FAIL: 13 a refused statement changed data';
  end if;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
