-- 111_smoke.sql — one-time smoke test of migration 111, run by Matt in the SQL editor AFTER 111 is applied, as
-- postgres. Everything after the restaurant lookup runs AS service_role (set local role), i.e. with exactly the
-- grants 111 leaves, through the same SQL functions _shared/pos-online/store.ts (PgOnlineStore) calls.
-- NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data.
--
-- The order actions write `orders`, so this smoke INSERTS its own throwaway Test Pizza orders inside the
-- rolled-back transaction: explicit NEGATIVE order_number (-111001 …) so order_number_seq is never advanced
-- (assign_order_number only calls nextval when order_number is null), customer smoke-111@example.invalid. One
-- order goes on another restaurant (restaurant_mismatch). complete_all_in_progress completes EVERY in-progress Test
-- Pizza order inside the transaction — rolled back with the rest. Two throwaway registers are created for Test Pizza
-- with prefixes nobody uses there yet; Test Pizza's pos_restaurant_settings row is changed inside the transaction
-- only. Each function call is its own statement, checked in the next one (106 lesson).
-- Mirrors _shared/pos-online/tests/actions.test.ts (MemoryOnlineStore = these functions).

begin;

do $$
declare
  n          int := 0;
  v_r        uuid;
  v_other    uuid;
  v_dev_a    uuid;
  v_dev_b    uuid;
  v_pfx      text[];
  v_now      timestamptz := now();
  o_new      uuid; o_quote uuid; o_sched uuid; o_uber uuid; o_ip uuid; o_ip2 uuid; o_wake uuid; o_late uuid;
  o_unwritten uuid; o_foreign uuid;
  a1 uuid := '11100000-0000-4000-8000-000000000001';
  a2 uuid := '11100000-0000-4000-8000-000000000002';
  a3 uuid := '11100000-0000-4000-8000-000000000003';
  a4 uuid := '11100000-0000-4000-8000-000000000004';
  a5 uuid := '11100000-0000-4000-8000-000000000005';
  a6 uuid := '11100000-0000-4000-8000-000000000006';
  a7 uuid := '11100000-0000-4000-8000-000000000007';
  a8 uuid := '11100000-0000-4000-8000-000000000008';
  a9 uuid := '11100000-0000-4000-8000-000000000009';
  a10 uuid := '11100000-0000-4000-8000-00000000000a';
  a11 uuid := '11100000-0000-4000-8000-00000000000b';
  a12 uuid := '11100000-0000-4000-8000-00000000000c';
  a13 uuid := '11100000-0000-4000-8000-00000000000d';
  a14 uuid := '11100000-0000-4000-8000-00000000000e';
  a15 uuid := '11100000-0000-4000-8000-00000000000f';
  e1 uuid := '11100000-0000-4000-8000-0000000000e1';
  e2 uuid := '11100000-0000-4000-8000-0000000000e2';
  e3 uuid := '11100000-0000-4000-8000-0000000000e3';
  s1 uuid := '11100000-0000-4000-8000-0000000000f1';
  r          jsonb;
  q          text;
  v_refused  text[];
  v_req      jsonb := '{"k":"smoke"}';
  t          record;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  select id into v_other from public.restaurants where id <> v_r order by id limit 1;
  if v_other is null then raise exception 'SMOKE FAIL: no second restaurant for restaurant_mismatch'; end if;
  select array_agg(p order by p) into v_pfx
    from (select chr(81 + i) || chr(65 + j) as p from generate_series(0, 8) i, generate_series(0, 25) j) c   -- QA..YZ
   where p not in (select prefix from public.pos_devices where restaurant_id = v_r);
  if coalesce(array_length(v_pfx, 1), 0) < 2 then raise exception 'SMOKE FAIL: no free test prefixes'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[1], 'smoke-111-a', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_a;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, v_pfx[2], 'smoke-111-b', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_b;

  -- throwaway orders (negative order_number: the sequence is untouched)
  for t in select * from (values
      (-111001, 'new',         'pickup',   'in_house',    null::text, null::timestamptz,          true),
      (-111002, 'new',         'pickup',   'in_house',    null,       null,                       true),
      (-111003, 'new',         'pickup',   'in_house',    null,       v_now + interval '3 hours', true),
      (-111004, 'new',         'delivery', 'uber_direct', null,       null,                       true),
      (-111005, 'in_progress', 'pickup',   'in_house',    null,       null,                       true),
      (-111006, 'in_progress', 'delivery', 'in_house',    null,       null,                       true),
      (-111007, 'scheduled',   'delivery', 'uber_direct', 'smoke-111-uber', v_now + interval '10 minutes', true),
      (-111008, 'scheduled',   'delivery', 'uber_direct', 'smoke-111-uber', v_now + interval '5 hours',   true),
      (-111009, 'new',         'pickup',   'in_house',    null,       null,                       false)) x(num, st, typ, meth, uber, sched, written) loop
    insert into public.orders (order_number, restaurant_id, status, order_type, customer_name, customer_phone, customer_email,
                               subtotal, tax_amount, total_amount, delivery_fulfillment_method, uber_delivery_id,
                               scheduled_for, items_written_at)
    values (t.num, v_r, t.st, t.typ, 'Smoke 111', '0000000000', 'smoke-111@example.invalid', 10, 0, 10, t.meth, t.uber,
            t.sched, case when t.written then v_now end);
  end loop;
  select id into o_new from public.orders where order_number = -111001;
  select id into o_quote from public.orders where order_number = -111002;
  select id into o_sched from public.orders where order_number = -111003;
  select id into o_uber from public.orders where order_number = -111004;
  select id into o_ip from public.orders where order_number = -111005;
  select id into o_ip2 from public.orders where order_number = -111006;
  select id into o_wake from public.orders where order_number = -111007;
  select id into o_late from public.orders where order_number = -111008;
  select id into o_unwritten from public.orders where order_number = -111009;
  insert into public.orders (order_number, restaurant_id, status, order_type, customer_name, customer_phone, customer_email,
                             subtotal, tax_amount, total_amount, items_written_at)
  values (-111010, v_other, 'new', 'pickup', 'Smoke 111', '0000000000', 'smoke-111@example.invalid', 10, 0, 10, v_now)
  returning id into o_foreign;

  -- 1. ack: applied (acknowledged_at = now), again (another id) → noop; same id + same request → duplicate;
  --    same id + another request → action_id_reused
  r := public.pos_online_order_action(a1, v_r, v_dev_a, o_new, 'ack', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 1 ack: %', r; end if;
  if (select acknowledged_at from public.orders where id = o_new) is distinct from v_now then raise exception 'SMOKE FAIL: 1 acknowledged_at'; end if;
  r := public.pos_online_order_action(a2, v_r, v_dev_a, o_new, 'ack', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 1 ack again: %', r; end if;
  r := public.pos_online_order_action(a1, v_r, v_dev_a, o_new, 'ack', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'applied' then raise exception 'SMOKE FAIL: 1 duplicate: %', r; end if;
  r := public.pos_online_order_action(a1, v_r, v_dev_a, o_new, 'ack', null, null, '{"k":"other"}', 'register', null, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 1 reused: %', r; end if;
  n := n + 1;

  -- 2. stuck_ack: applied every time (stuck_acknowledged_at = now)
  r := public.pos_online_order_action(a3, v_r, v_dev_b, o_ip, 'stuck_ack', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select stuck_acknowledged_at from public.orders where id = o_ip) is distinct from v_now then
    raise exception 'SMOKE FAIL: 2 stuck_ack: %', r;
  end if;
  n := n + 1;

  -- 3. accept (Mark In Progress, no quote): in_progress + accepted_at, quoted_for untouched, no ready email
  r := public.pos_online_order_action(a4, v_r, v_dev_a, o_new, 'accept', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (r->>'ready_email')::boolean then raise exception 'SMOKE FAIL: 3 accept: %', r; end if;
  if (select status <> 'in_progress' or accepted_at is distinct from v_now or quoted_for is not null from public.orders where id = o_new) then
    raise exception 'SMOKE FAIL: 3 accept columns';
  end if;
  n := n + 1;

  -- 4. accept with 25 min (Confirm): quoted_for = now + 25 min, ready_email true ONCE; out-of-range → invalid
  r := public.pos_online_order_action(a5, v_r, v_dev_a, o_quote, 'accept', 'new', 0, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'invalid' then raise exception 'SMOKE FAIL: 4 quote 0: %', r; end if;
  r := public.pos_online_order_action(a5, v_r, v_dev_a, o_quote, 'accept', 'new', 25, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or not (r->>'ready_email')::boolean then raise exception 'SMOKE FAIL: 4 confirm: %', r; end if;
  if (select quoted_for from public.orders where id = o_quote) is distinct from v_now + interval '25 minutes' then
    raise exception 'SMOKE FAIL: 4 quoted_for';
  end if;
  r := public.pos_online_order_action(a5, v_r, v_dev_a, o_quote, 'accept', 'new', 25, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or r ? 'ready_email' then raise exception 'SMOKE FAIL: 4 duplicate (no email): %', r; end if;
  if (select count(*) from public.pos_online_actions where order_id = o_quote and ready_email_sent) <> 1 then
    raise exception 'SMOKE FAIL: 4 ready_email_sent once';
  end if;
  n := n + 1;

  -- 5. compare-and-set: B accepts the same order expecting new → status_conflict (in_progress); complete from new → not_allowed
  r := public.pos_online_order_action(a6, v_r, v_dev_b, o_quote, 'accept', 'new', 30, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'status_conflict' or r->>'status' <> 'in_progress' then raise exception 'SMOKE FAIL: 5 conflict: %', r; end if;
  r := public.pos_online_order_action(e1, v_r, v_dev_b, o_unwritten, 'complete', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'unknown_order' then raise exception 'SMOKE FAIL: 5 unwritten: %', r; end if;
  r := public.pos_online_order_action(e2, v_r, v_dev_b, o_sched, 'complete', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'not_allowed' then raise exception 'SMOKE FAIL: 5 complete from new: %', r; end if;
  if (select quoted_for from public.orders where id = o_quote) is distinct from v_now + interval '25 minutes' then
    raise exception 'SMOKE FAIL: 5 the loser changed the order';
  end if;
  n := n + 1;

  -- 6. scheduled order: accept → not_allowed; schedule → scheduled + accepted_at. Uber (not booked): accept /
  --    schedule → not_allowed. Another restaurant's order → restaurant_mismatch. Unknown device → device_not_allowed.
  r := public.pos_online_order_action(e3, v_r, v_dev_a, o_sched, 'accept', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'not_allowed' then raise exception 'SMOKE FAIL: 6 accept scheduled: %', r; end if;
  r := public.pos_online_order_action(a7, v_r, v_dev_a, o_sched, 'schedule', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select status <> 'scheduled' or accepted_at is distinct from v_now from public.orders where id = o_sched) then
    raise exception 'SMOKE FAIL: 6 schedule: %', r;
  end if;
  r := public.pos_online_order_action(e3, v_r, v_dev_a, o_uber, 'accept', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'not_allowed' then raise exception 'SMOKE FAIL: 6 accept uber: %', r; end if;
  r := public.pos_online_order_action(e3, v_r, v_dev_a, o_foreign, 'accept', 'new', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'restaurant_mismatch' then raise exception 'SMOKE FAIL: 6 foreign: %', r; end if;
  r := public.pos_online_order_action(e3, v_r, gen_random_uuid(), o_new, 'ack', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'device_not_allowed' then raise exception 'SMOKE FAIL: 6 device: %', r; end if;
  if exists (select 1 from public.pos_online_actions where action_id in (e1, e2, e3)) then
    raise exception 'SMOKE FAIL: 6 an error wrote an action row';
  end if;
  n := n + 1;

  -- 7. complete (in_progress → complete); complete from scheduled allowed
  r := public.pos_online_order_action(a8, v_r, v_dev_a, o_ip, 'complete', 'in_progress', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select status from public.orders where id = o_ip) <> 'complete' then raise exception 'SMOKE FAIL: 7 complete: %', r; end if;
  n := n + 1;

  -- 8. wake_scheduled: not due (5 h out) → not_allowed; due (10 min out, lead ≥ 30) → in_progress, accepted_at untouched
  r := public.pos_online_order_action(e3, v_r, v_dev_a, o_late, 'wake_scheduled', 'scheduled', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'not_allowed' then raise exception 'SMOKE FAIL: 8 not due: %', r; end if;
  r := public.pos_online_order_action(a9, v_r, v_dev_a, o_wake, 'wake_scheduled', 'scheduled', null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' or (select status <> 'in_progress' or accepted_at is not null from public.orders where id = o_wake) then
    raise exception 'SMOKE FAIL: 8 wake: %', r;
  end if;
  n := n + 1;

  -- 9. complete_all_in_progress: every in-progress Test Pizza order (o_new, o_quote, o_ip2, o_wake among them) →
  --    complete, order_ids recorded; duplicate returns the same ids; a new id → noop
  r := public.pos_online_order_action(a10, v_r, v_dev_b, null, 'complete_all_in_progress', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 9 bulk: %', r; end if;
  if not ((r->'order_ids') @> to_jsonb(array[o_new, o_quote, o_ip2, o_wake])) then raise exception 'SMOKE FAIL: 9 bulk ids'; end if;
  if exists (select 1 from public.orders where restaurant_id = v_r and status = 'in_progress') then raise exception 'SMOKE FAIL: 9 left in progress'; end if;
  if (select status from public.orders where id = o_sched) <> 'scheduled' then raise exception 'SMOKE FAIL: 9 touched a scheduled order'; end if;
  r := public.pos_online_order_action(a10, v_r, v_dev_b, null, 'complete_all_in_progress', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' or not ((r->'order_ids') @> to_jsonb(array[o_new, o_quote, o_ip2, o_wake])) then raise exception 'SMOKE FAIL: 9 duplicate: %', r; end if;
  r := public.pos_online_order_action(a11, v_r, v_dev_b, null, 'complete_all_in_progress', null, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 9 noop: %', r; end if;
  n := n + 1;

  -- 10. settings: print register A (applied), again → noop, same id → duplicate, other body → reused, a foreign
  --     device → invalid_print_register; both flags on (applied) then on again (noop); updated_by = the actor
  r := public.pos_online_settings_change(a12, v_r, v_dev_a, 'online_print_device', v_dev_a, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 10 register: %', r; end if;
  r := public.pos_online_settings_change(a13, v_r, v_dev_a, 'online_print_device', v_dev_a, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'noop' then raise exception 'SMOKE FAIL: 10 register again: %', r; end if;
  r := public.pos_online_settings_change(a12, v_r, v_dev_a, 'online_print_device', v_dev_a, null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'duplicate' then raise exception 'SMOKE FAIL: 10 duplicate: %', r; end if;
  r := public.pos_online_settings_change(a12, v_r, v_dev_a, 'online_print_device', v_dev_b, null, '{"k":"other"}', 'register', null, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 10 reused: %', r; end if;
  r := public.pos_online_settings_change(e1, v_r, v_dev_a, 'online_print_device', gen_random_uuid(), null, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'invalid_print_register' then raise exception 'SMOKE FAIL: 10 invalid register: %', r; end if;
  update public.pos_restaurant_settings set online_auto_print_enabled = false, kitchenhub_auto_print_enabled = false where restaurant_id = v_r;
  r := public.pos_online_settings_change(a14, v_r, v_dev_a, 'online_auto_print', null, true, v_req, v_dev_b::text, v_dev_a, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 10 auto print: %', r; end if;
  r := public.pos_online_settings_change(a15, v_r, v_dev_a, 'kitchenhub_auto_print', null, true, v_req, 'register', null, v_now);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: 10 kh auto print: %', r; end if;
  if (select not (online_auto_print_enabled and kitchenhub_auto_print_enabled) or print_register_device_id <> v_dev_a or updated_by <> 'register'
        from public.pos_restaurant_settings where restaurant_id = v_r) then
    raise exception 'SMOKE FAIL: 10 settings row';
  end if;
  if (select actor_staff_id <> v_dev_b::text or approver_staff_id <> v_dev_a from public.pos_online_actions where action_id = a14) then
    raise exception 'SMOKE FAIL: 10 actor / approver recorded';
  end if;
  n := n + 1;

  -- 11. print idempotency: begin started → pending → complete → duplicate (stored applied); other body → reused
  r := public.pos_online_action_begin(s1, 'print', v_r, v_dev_a, 'ordr', o_new, 'print_result', v_req, null, null, v_now);
  if r->>'outcome' <> 'started' then raise exception 'SMOKE FAIL: 11 begin: %', r; end if;
  r := public.pos_online_action_begin(s1, 'print', v_r, v_dev_a, 'ordr', o_new, 'print_result', v_req, null, null, v_now);
  if r->>'outcome' <> 'pending' then raise exception 'SMOKE FAIL: 11 pending: %', r; end if;
  r := public.pos_online_action_complete(s1, v_dev_a, 'applied');
  if r->>'outcome' <> 'completed' then raise exception 'SMOKE FAIL: 11 complete: %', r; end if;
  r := public.pos_online_action_begin(s1, 'print', v_r, v_dev_a, 'ordr', o_new, 'print_result', v_req, null, null, v_now);
  if r->>'outcome' <> 'duplicate' or r->>'stored' <> 'applied' then raise exception 'SMOKE FAIL: 11 duplicate: %', r; end if;
  r := public.pos_online_action_begin(s1, 'print', v_r, v_dev_a, 'ordr', o_new, 'print_result', '{"k":"other"}', null, null, v_now);
  if r->>'outcome' <> 'action_id_reused' then raise exception 'SMOKE FAIL: 11 reused: %', r; end if;
  r := public.pos_online_action_complete(s1, v_dev_a, 'noop');
  if r->>'outcome' <> 'already_completed' then raise exception 'SMOKE FAIL: 11 complete twice: %', r; end if;
  n := n + 1;

  -- 12. the guard: a completed action is immutable (42501); a bad row is refused by the CHECKs (23514)
  begin
    update public.pos_online_actions set outcome = 'noop' where action_id = a1;
    raise exception 'SMOKE FAIL: 12 a completed action changed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action, request, request_hash)
    values (gen_random_uuid(), 'order_action', v_r, v_dev_a, 'ordr', o_new, 'ack', v_req, repeat('0', 64));
    raise exception 'SMOKE FAIL: 12 a pending order_action row was accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- 13. forbidden by GRANTS (insufficient_privilege): delete / truncate pos_online_actions
  v_refused := array[
    format('delete from public.pos_online_actions where action_id = %L', a1),
    'truncate public.pos_online_actions'];
  foreach q in array v_refused loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: allowed as service_role: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  n := n + 1;

  -- 14. the rows: 10 applied/noop order actions (a1 a2 a3 a4 a5 a7 a8 a9 a10 a11; a6 conflicted → none),
  --     4 settings rows (a12 a13 a14 a15), 1 print row (s1)
  if (select count(*) from public.pos_online_actions where function = 'order_action' and restaurant_id = v_r and action_id::text like '11100000-%') <> 10
     or (select count(*) from public.pos_online_actions where function = 'settings' and action_id::text like '11100000-%') <> 4
     or (select count(*) from public.pos_online_actions where function = 'print' and action_id = s1) <> 1 then
    raise exception 'SMOKE FAIL: 14 action row counts';
  end if;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
