-- 114_smoke.sql — one-time smoke test of migration 114, run by Matt in the SQL editor AFTER 114 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role) with exactly the grants 114 leaves.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data. NO Uber / Stripe call (those are TS — the copied uber-create-delivery / uber-self-deliver
-- glue); only the pending / release / finish bookkeeping around them. No orders row is read or written:
-- pos_online_actions.order_id has no FK, so made-up order ids (11400000-…) are used. One throwaway register (a free
-- prefix). Each function call is its own statement, checked in the next one (106 lesson).

begin;

do $$
declare
  n       int := 0;
  v_r     uuid;
  v_dev   uuid;
  v_pfx   text[];
  v_now   timestamptz := now();
  o1      uuid := '11400000-0000-4000-8000-0000000000d1';
  a1 uuid := '11400000-0000-4000-8000-000000000001';
  a2 uuid := '11400000-0000-4000-8000-000000000002';
  a3 uuid := '11400000-0000-4000-8000-000000000003';
  v_req   jsonb := '{"k":"smoke-114"}';
  r       jsonb;
  q       text;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 1 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;
  if exists (select 1 from public.pos_online_actions where action_id::text like '11400000-%') then
    raise exception 'SMOKE FAIL: an action id 11400000-… is already used';
  end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-114', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;

  -- 1. a pending dispatch_delivery: begin → started → pending (+ since)
  r := public.pos_online_action_begin(a1, 'order_action', v_r, v_dev, 'ordr', o1, 'dispatch_delivery', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 1 begin: %', r; end if;
  r := public.pos_online_action_begin(a1, 'order_action', v_r, v_dev, 'ordr', o1, 'dispatch_delivery', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'pending' or r->>'since' is null then raise exception 'SMOKE FAIL: 1 pending: %', r; end if;
  n := n + 1;

  -- 2. release (rate_limited): another device → device_mismatch; this device → released, the row is gone; a new begin
  --    with the same id starts fresh
  r := public.pos_online_action_release(a1, gen_random_uuid());
  if r->>'outcome' <> 'device_mismatch' then raise exception 'SMOKE FAIL: 2 device_mismatch: %', r; end if;
  r := public.pos_online_action_release(a1, v_dev);
  if r->>'outcome' <> 'released' or exists (select 1 from public.pos_online_actions where action_id = a1) then raise exception 'SMOKE FAIL: 2 released: %', r; end if;
  r := public.pos_online_action_begin(a1, 'order_action', v_r, v_dev, 'ordr', o1, 'dispatch_delivery', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 2 fresh begin: %', r; end if;
  n := n + 1;

  -- 3. finish with the stored error; then release → not_pending, a direct delete → refused by the guard (42501)
  r := public.pos_online_action_finish(a1, v_dev, 'error', 502, 'delivery_failed', '[provider_error] outcome unknown');
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 3 finish: %', r; end if;
  r := public.pos_online_action_release(a1, v_dev);
  if r->>'outcome' <> 'not_pending' then raise exception 'SMOKE FAIL: 3 release completed: %', r; end if;
  begin
    delete from public.pos_online_actions where action_id = a1;
    raise exception 'SMOKE FAIL: 3 a completed action was deleted';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  -- 4. a pending self_deliver: begin → release → released
  r := public.pos_online_action_begin(a2, 'order_action', v_r, v_dev, 'ordr', o1, 'self_deliver', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 4 begin: %', r; end if;
  r := public.pos_online_action_release(a2, v_dev);
  if r->>'outcome' <> 'released' then raise exception 'SMOKE FAIL: 4 release: %', r; end if;
  n := n + 1;

  -- 5. a pending cancel_refund (113) still begins, but is NOT releasable (function → not_pending; delete → 42501)
  r := public.pos_online_action_begin(a3, 'order_action', v_r, v_dev, 'ordr', o1, 'cancel_refund', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 5 begin cancel_refund: %', r; end if;
  r := public.pos_online_action_release(a3, v_dev);
  if r->>'outcome' <> 'not_pending' then raise exception 'SMOKE FAIL: 5 release cancel_refund: %', r; end if;
  begin
    delete from public.pos_online_actions where action_id = a3;
    raise exception 'SMOKE FAIL: 5 a pending cancel_refund was deleted';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  -- 6. the CHECK still refuses a pending row for any other order action
  begin
    r := public.pos_online_action_begin(gen_random_uuid(), 'order_action', v_r, v_dev, 'ordr', o1, 'accept', v_req, 'register', null, v_now);
    raise exception 'SMOKE FAIL: 6 a pending accept was accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 7. still forbidden by GRANTS: truncate
  begin
    execute 'truncate public.pos_online_actions';
    raise exception 'SMOKE FAIL: 7 truncate allowed as service_role';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
