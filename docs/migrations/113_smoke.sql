-- 113_smoke.sql — one-time smoke test of migration 113, run by Matt in the SQL editor AFTER 113 is applied, as
-- postgres. Everything after the lookups runs AS service_role (set local role), through the SQL functions
-- _shared/pos-online/store.ts (PgOnlineStore) calls. NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL:
-- <what>'. Success → 'SMOKE OK (all N checks)'. Prints no row data. NO Stripe / Uber call (those are TS — the
-- admin-refund glue — and are not part of 113); only the pending / finish bookkeeping around them.
--
-- Inserts two throwaway Test Pizza orders inside the rolled-back transaction: explicit NEGATIVE order_number
-- (-113001 / -113002; assign_order_number only calls nextval when it is null — the sequence is untouched), every
-- unique column distinct or NULL (order_number 001:110; uber_delivery_id 046:39-41 → NULL), plus the adjustment
-- requests on them (adjustment_requests FK → those orders; rolled back). One throwaway register (a free prefix).
-- Action ids 11300000-…. Each function call is its own statement, checked in the next one (106 lesson).
-- Mirrors _shared/pos-online/tests/money.test.ts (MemoryOnlineStore = these functions).

begin;

do $$
declare
  n        int := 0;
  v_r      uuid;
  v_dev    uuid;
  v_pfx    text[];
  v_now    timestamptz := now();
  o_done   uuid;
  o_live   uuid;
  v_row0   jsonb;
  a1 uuid := '11300000-0000-4000-8000-000000000001';
  a2 uuid := '11300000-0000-4000-8000-000000000002';
  a3 uuid := '11300000-0000-4000-8000-000000000003';
  a4 uuid := '11300000-0000-4000-8000-000000000004';
  a5 uuid := '11300000-0000-4000-8000-000000000005';
  e1 uuid := '11300000-0000-4000-8000-0000000000e1';
  v_req    jsonb := '{"k":"smoke-113"}';
  r        jsonb;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 1 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;
  if exists (select 1 from public.orders where order_number in (-113001, -113002)) then
    raise exception 'SMOKE FAIL: an orders row already has order_number -113001 / -113002';
  end if;
  if exists (select 1 from public.pos_online_actions where action_id::text like '11300000-%') then
    raise exception 'SMOKE FAIL: an action id 11300000-… is already used';
  end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-113', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;
  begin
    insert into public.orders (order_number, restaurant_id, status, order_type, customer_name, customer_phone, customer_email,
                               subtotal, tax_amount, total_amount, items_written_at)
    values (-113001, v_r, 'complete', 'pickup', 'Smoke 113', '0000000000', 'smoke-113@example.invalid', 10, 0, 10, v_now)
    returning id into o_done;
    insert into public.orders (order_number, restaurant_id, status, order_type, customer_name, customer_phone, customer_email,
                               subtotal, tax_amount, total_amount, items_written_at)
    values (-113002, v_r, 'in_progress', 'pickup', 'Smoke 113', '0000000000', 'smoke-113@example.invalid', 10, 0, 10, v_now)
    returning id into o_live;
  exception when unique_violation then
    raise exception 'SMOKE FAIL: setup — a test order hit a unique index on orders: %', sqlerrm;
  end;
  select to_jsonb(o) into v_row0 from public.orders o where o.id = o_done;

  -- 1. adjustment on a complete order: applied; the tablet's row (amount in dollars, pending); the order row untouched
  r := public.pos_online_adjustment_request(a1, v_r, v_dev, o_done, 'complete', 'charge', 500, 'Extra cheese', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 1 adjustment: %', r; end if;
  if (select count(*) from public.adjustment_requests where order_id = o_done and order_number = -113001 and restaurant_id = v_r
        and type = 'charge' and amount = 5.00 and note = 'Extra cheese' and status = 'pending') <> 1 then
    raise exception 'SMOKE FAIL: 1 the adjustment_requests row';
  end if;
  if (select to_jsonb(o) from public.orders o where o.id = o_done) is distinct from v_row0 then raise exception 'SMOKE FAIL: 1 the order changed'; end if;
  n := n + 1;

  -- 2. the same id → duplicate (no second row); another body → reused
  r := public.pos_online_adjustment_request(a1, v_r, v_dev, o_done, 'complete', 'charge', 500, 'Extra cheese', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'applied' then raise exception 'SMOKE FAIL: 2 duplicate: %', r; end if;
  r := public.pos_online_adjustment_request(a1, v_r, v_dev, o_done, 'complete', 'charge', 700, 'Extra cheese', '{"k":"other"}', 'register', null, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 2 reused: %', r; end if;
  if (select count(*) from public.adjustment_requests where order_id = o_done) <> 1 then raise exception 'SMOKE FAIL: 2 a second row'; end if;
  n := n + 1;

  -- 3. refusals are STORED: not complete → 400 action_not_allowed; expected ≠ current → 409 status_conflict; the
  --    resend answers the stored error; nothing inserted
  r := public.pos_online_adjustment_request(a2, v_r, v_dev, o_live, 'in_progress', 'refund', 300, 'cold', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'error' or (r->>'error_status')::int <> 400 or r->>'error_code' <> 'action_not_allowed' then raise exception 'SMOKE FAIL: 3 not complete: %', r; end if;
  r := public.pos_online_adjustment_request(a2, v_r, v_dev, o_live, 'in_progress', 'refund', 300, 'cold', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'error' or r->>'error_code' <> 'action_not_allowed' then raise exception 'SMOKE FAIL: 3 stored: %', r; end if;
  r := public.pos_online_adjustment_request(a3, v_r, v_dev, o_done, 'in_progress', 'refund', 300, 'cold', v_req, 'register', null, v_now);
  if r->>'error_code' <> 'status_conflict' or (r->>'error_status')::int <> 409 then raise exception 'SMOKE FAIL: 3 conflict: %', r; end if;
  if exists (select 1 from public.adjustment_requests where order_id = o_live) then raise exception 'SMOKE FAIL: 3 inserted on a refusal'; end if;
  n := n + 1;

  -- 4. bad input → 22023 (nothing stored); unknown order; unknown device
  begin
    r := public.pos_online_adjustment_request(e1, v_r, v_dev, o_done, 'complete', 'charge', 0, 'x', v_req, 'register', null, v_now);
    raise exception 'SMOKE FAIL: 4 amount 0 accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    r := public.pos_online_adjustment_request(e1, v_r, v_dev, o_done, 'complete', 'charge', 500, ' padded ', v_req, 'register', null, v_now);
    raise exception 'SMOKE FAIL: 4 untrimmed note accepted';
  exception when invalid_parameter_value then null;
  end;
  r := public.pos_online_adjustment_request(e1, v_r, v_dev, gen_random_uuid(), 'complete', 'charge', 500, 'x', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'unknown_order' then raise exception 'SMOKE FAIL: 4 unknown order: %', r; end if;
  r := public.pos_online_adjustment_request(e1, v_r, gen_random_uuid(), o_done, 'complete', 'charge', 500, 'x', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'device_not_allowed' then raise exception 'SMOKE FAIL: 4 device: %', r; end if;
  if exists (select 1 from public.pos_online_actions where action_id = e1) then raise exception 'SMOKE FAIL: 4 stored an input error'; end if;
  n := n + 1;

  -- 5. a PENDING cancel_refund: begin → started; again → pending + since; finish with the error → completed; begin →
  --    duplicate with the stored error; finish again → already_completed
  r := public.pos_online_action_begin(a4, 'order_action', v_r, v_dev, 'ordr', o_live, 'cancel_refund', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 5 begin: %', r; end if;
  r := public.pos_online_action_begin(a4, 'order_action', v_r, v_dev, 'ordr', o_live, 'cancel_refund', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'pending' or (r->>'since')::timestamptz <> v_now then raise exception 'SMOKE FAIL: 5 pending + since: %', r; end if;
  r := public.pos_online_action_finish(a4, v_dev, 'error', 502, 'refund_failed', 'Your card was declined');
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 5 finish: %', r; end if;
  r := public.pos_online_action_begin(a4, 'order_action', v_r, v_dev, 'ordr', o_live, 'cancel_refund', v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'error' or (r->>'error_status')::int <> 502 or r->>'error_code' <> 'refund_failed' then
    raise exception 'SMOKE FAIL: 5 stored error: %', r;
  end if;
  r := public.pos_online_action_finish(a4, v_dev, 'applied', null, null, null);
  if r->>'outcome' <> 'already_completed' then raise exception 'SMOKE FAIL: 5 finish twice: %', r; end if;
  n := n + 1;

  -- 6. finish: applied works; bad args → 22023; another device → device_mismatch
  r := public.pos_online_action_begin(a5, 'order_action', v_r, v_dev, 'ordr', o_live, 'cancel_refund', '{"k":"a5"}', 'register', null, v_now);
  r := public.pos_online_action_finish(a5, gen_random_uuid(), 'applied', null, null, null);
  if r->>'outcome' <> 'device_mismatch' then raise exception 'SMOKE FAIL: 6 device_mismatch: %', r; end if;
  begin
    r := public.pos_online_action_finish(a5, v_dev, 'error', null, null, 'x');
    raise exception 'SMOKE FAIL: 6 an error without status / code accepted';
  exception when invalid_parameter_value then null;
  end;
  r := public.pos_online_action_finish(a5, v_dev, 'applied', null, null, null);
  if r->>'outcome' <> 'completed' or (select outcome from public.pos_online_actions where action_id = a5) <> 'applied' then raise exception 'SMOKE FAIL: 6 applied: %', r; end if;
  n := n + 1;

  -- 7. the CHECK still refuses a pending row for any other order action (only cancel_refund / print may be pending)
  begin
    r := public.pos_online_action_begin(gen_random_uuid(), 'order_action', v_r, v_dev, 'ordr', o_live, 'accept', v_req, 'register', null, v_now);
    raise exception 'SMOKE FAIL: 7 a pending accept was accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
