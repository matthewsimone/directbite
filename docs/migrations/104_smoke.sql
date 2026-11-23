-- 104_smoke.sql — one-time smoke test of migration 104, run by Matt in the SQL editor AFTER 101, 103
-- and 104 are applied, as postgres. NOTHING PERSISTS (BEGIN … ROLLBACK; the sequence value consumed
-- is the only side effect — sequences are not transactional). Failure → 'SMOKE FAIL: <what>'.
-- Success → 'SMOKE OK (all 15 checks)'. Prints no row data. Content hashes here are placeholders:
-- the edge function verifies them before it ever calls the apply function.

begin;

do $$
declare
  n       int := 0;
  v_r     uuid;
  v_dev_a uuid;
  v_dev_b uuid;
  v_snap  text := encode(sha256(convert_to('smoke-104-snapshot', 'UTF8')), 'hex');
  v_oid   uuid := gen_random_uuid();
  v_line  uuid := gen_random_uuid();
  v_line2 uuid := gen_random_uuid();
  v_mod   uuid := gen_random_uuid();
  v_pay   uuid := gen_random_uuid();
  v_card  uuid := gen_random_uuid();
  v_bd    jsonb := '{"lines":[],"subtotal_cents":0,"discountable_subtotal_cents":0,"promo_discount_cents":0,"discounted_subtotal_cents":0,"loyalty_discount_face_cents":0,"loyalty_discount_applied_cents":0,"net_subtotal_cents":0,"delivery_fee_cents":0,"tip_cents":0,"recoup_cents":0,"service_fee_cents":0,"taxable_cents":0,"tax_cents":0,"total_cents":2068,"loyalty_earn":{"basis_cents":0,"base_points":0},"rates":{"promo_percent":null,"recoup_rate":"0","tax_rate":"0.08875"}}';
  v_p     jsonb;
  v_resp  jsonb;
  r       jsonb;
  v_num   bigint;
  v_cnt   int;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZY', 'smoke A', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_a;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZZ', 'smoke B', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev_b;
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_snap, v_r, '{"smoke":true}');

  v_p := jsonb_build_object(
    'order_id', v_oid, 'version', 1, 'base_server_version', 0, 'content_hash', 'h1',
    'restaurant_id', v_r, 'device_id', v_dev_a,
    'ticket', jsonb_build_object('prefix', 'ZY', 'business_date', '2026-11-19', 'counter', 1),
    'order_type', 'pickup', 'channel', 'counter', 'status', 'open',
    'customer', jsonb_build_object('name', null, 'phone_e164', null),
    'note', 'smoke', 'ready_at', null, 'void_reason', null,
    'created_by', 'register', 'closed_by', null, 'voided_by', null, 'void_approved_by', null,
    'delivery', null, 'table', jsonb_build_object('label', null, 'guest_count', null),
    'menu_snapshot_hash', v_snap,
    'lines', jsonb_build_array(
      jsonb_build_object('id', v_line, 'position', 0, 'menu_item_id', 'item-pie', 'item_size_id', 'size-pie-large',
        'item_name', 'Pie', 'size_name', 'Large', 'quantity', 1, 'base_price_cents', 1899, 'discount_exempt', false,
        'status', 'active', 'void_reason', null, 'special_instructions', null,
        'modifiers', jsonb_build_array(jsonb_build_object('id', v_mod, 'position', 0, 'kind', 'pizza', 'topping_id', 't1',
          'name', 'Mushrooms', 'placement', 'left', 'price_cents', 225, 'price_half_cents', 125,
          'size_prices', '[{"size_key":"large 16\"","price_cents":225,"half_cents":null}]'::jsonb, 'charge_cents', 125))),
      jsonb_build_object('id', v_line2, 'position', 1, 'menu_item_id', 'item-soda', 'item_size_id', 'size-soda-reg',
        'item_name', 'Soda', 'size_name', 'Regular', 'quantity', 1, 'base_price_cents', 349, 'discount_exempt', true,
        'status', 'active', 'void_reason', null, 'special_instructions', null, 'modifiers', '[]'::jsonb)),
    'tip', jsonb_build_object('mode', 'none', 'percent', null, 'amount_cents', null),
    'payments', jsonb_build_array(
      jsonb_build_object('id', v_pay, 'method', 'cash', 'amount_cents', 1000, 'tendered_cents', 2000, 'change_cents', 1000,
        'status', 'captured', 'last4', null, 'external_ref', null, 'taken_by', 'register'),
      jsonb_build_object('id', v_card, 'method', 'external_card', 'amount_cents', 1068, 'tendered_cents', 1068, 'change_cents', 0,
        'status', 'captured', 'last4', '1234', 'external_ref', 'AUTH 004211', 'taken_by', 'register')),
    'provisional_pricing', v_bd, 'pricing_config', '{}'::jsonb, 'device_time', '2026-11-19T17:00:00Z');
  v_resp := jsonb_build_object('result', 'applied', 'order_id', v_oid, 'version', 1, 'server_version', 1, 'order_number', 0,
    'pricing', v_bd, 'priced_against_hash', v_snap, 'flags', '{"mismatch":false}'::jsonb, 'diff', '{}'::jsonb,
    'pricing_module_hash', 'x', 'server_time', '2026-11-19T17:00:01Z');

  -- 1. new order applied; order_number from the sequence, written into the stored response
  r := public.pos_apply_order_submission(v_p, v_dev_a, v_r, v_resp, now());
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: new order not applied (%)', r->>'outcome'; end if;
  v_num := (r #>> '{response,order_number}')::bigint;
  if v_num < 5000001 then raise exception 'SMOKE FAIL: order_number % not from pos_order_number_seq', v_num; end if;
  n := n + 1;
  -- 2. rows written: 1 order, 2 lines, 1 modifier (size_prices array kept), 2 payments, 1 submission
  if (select count(*) from public.pos_order_lines where order_id = v_oid) <> 2
     or (select size_prices #>> '{0,size_key}' from public.pos_order_line_modifiers where id = v_mod) <> 'large 16"'
     or (select count(*) from public.pos_payments where order_id = v_oid) <> 2
     or (select (response->>'order_number')::bigint from public.pos_order_submissions where order_id = v_oid and version = 1) <> v_num then
    raise exception 'SMOKE FAIL: aggregate rows';
  end if;
  n := n + 1;
  -- 3. same key + same hash → duplicate with the ORIGINAL response
  r := public.pos_apply_order_submission(v_p, v_dev_a, v_r, v_resp, now());
  if r->>'outcome' <> 'duplicate' or (r #>> '{response,order_number}')::bigint <> v_num then raise exception 'SMOKE FAIL: duplicate'; end if;
  n := n + 1;
  -- 4. same key + other hash → idempotency_key_reuse
  r := public.pos_apply_order_submission(jsonb_set(v_p, '{content_hash}', '"h1-other"'), v_dev_a, v_r, v_resp, now());
  if r->>'outcome' <> 'idempotency_key_reuse' then raise exception 'SMOKE FAIL: key reuse'; end if;
  n := n + 1;
  -- 5. v2 by A drops line 2 and voids the card payment → applied; line 2 gone; payment voided, same number
  v_p := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '2'), '{content_hash}', '"h2"'),
           '{lines}', jsonb_build_array(v_p #> '{lines,0}')),
           '{payments,1,status}', '"voided"');
  r := public.pos_apply_order_submission(v_p, v_dev_a, v_r, jsonb_set(v_resp, '{version}', '2'), now());
  if r->>'outcome' <> 'applied' or (r #>> '{response,order_number}')::bigint <> v_num then raise exception 'SMOKE FAIL: v2 apply'; end if;
  if (select count(*) from public.pos_order_lines where order_id = v_oid) <> 1 then raise exception 'SMOKE FAIL: dropped line kept'; end if;
  if (select status from public.pos_payments where id = v_card) <> 'voided' or (select voided_at from public.pos_payments where id = v_card) is null then
    raise exception 'SMOKE FAIL: card payment not voided';
  end if;
  n := n + 1;
  -- 6. B writes with a stale base (1 < 2) → version_conflict naming A
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '3'), '{base_server_version}', '1'), '{content_hash}', '"h3b"'),
                                         v_dev_b, v_r, jsonb_set(v_resp, '{version}', '3'), now());
  if r->>'outcome' <> 'version_conflict' or (r->>'server_version')::int <> 2 or (r->>'server_writer_device_id')::uuid <> v_dev_a then
    raise exception 'SMOKE FAIL: stale base from another device';
  end if;
  n := n + 1;
  -- 7. B writes with base = 2 → applied; ownership passes to B
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '3'), '{base_server_version}', '2'), '{content_hash}', '"h3"'),
                                         v_dev_b, v_r, jsonb_set(v_resp, '{version}', '3'), now());
  if r->>'outcome' <> 'applied' or (select writer_device_id from public.pos_orders where order_id = v_oid) <> v_dev_b then
    raise exception 'SMOKE FAIL: ownership did not pass';
  end if;
  n := n + 1;
  -- 8. a seen key with other content → reuse; an unseen version below the stored one, same writer → stale_ignored
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(v_p, '{version}', '2'), '{content_hash}', '"h2-b"'), v_dev_b, v_r, v_resp, now());
  if r->>'outcome' <> 'idempotency_key_reuse' then raise exception 'SMOKE FAIL: (order, 2) is a seen key → reuse, got %', r->>'outcome'; end if;
  update public.pos_orders set version = 5 where order_id = v_oid;   -- simulate a newer B version landing
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(v_p, '{version}', '4'), '{content_hash}', '"h4"'), v_dev_b, v_r, v_resp, now());
  if r->>'outcome' <> 'stale_ignored' or (r #>> '{head,version}')::int <> 5 or (r #>> '{head,order_number}')::bigint <> v_num then
    raise exception 'SMOKE FAIL: stale_ignored (got %)', r->>'outcome';
  end if;
  n := n + 1;
  -- 9. un-voiding a payment → invalid_payload, nothing written
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '6'), '{content_hash}', '"h6"'), '{payments,1,status}', '"captured"'),
                                         v_dev_b, v_r, v_resp, now());
  if r->>'outcome' <> 'invalid_payload' or (select count(*) from public.pos_order_submissions where order_id = v_oid and version = 6) <> 0 then
    raise exception 'SMOKE FAIL: un-void accepted';
  end if;
  n := n + 1;
  -- 10. changed payment amount → invalid_payload
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '6'), '{content_hash}', '"h6"'), '{payments,0,amount_cents}', '999'),
                                         v_dev_b, v_r, v_resp, now());
  if r->>'outcome' <> 'invalid_payload' then raise exception 'SMOKE FAIL: payment amount change accepted'; end if;
  n := n + 1;
  -- 11. new order with base > 0 → version_conflict with no server version
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(v_p, '{order_id}', to_jsonb(gen_random_uuid())), '{base_server_version}', '3'), v_dev_a, v_r, v_resp, now());
  if r->>'outcome' <> 'version_conflict' or r->'server_version' <> 'null'::jsonb then raise exception 'SMOKE FAIL: unknown order with base > 0'; end if;
  n := n + 1;
  -- 12. another order reusing this order's line id → invalid_payload
  r := public.pos_apply_order_submission(jsonb_set(jsonb_set(v_p, '{order_id}', to_jsonb(gen_random_uuid())), '{base_server_version}', '0'), v_dev_a, v_r, v_resp, now());
  if r->>'outcome' <> 'invalid_payload' then raise exception 'SMOKE FAIL: line id of another order accepted (got %)', r->>'outcome'; end if;
  n := n + 1;
  -- 13. the payment guard refuses a direct money edit
  begin
    update public.pos_payments set amount_cents = 1 where id = v_pay;
    raise exception 'SMOKE FAIL: payment amount updated directly';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;
  -- 14. card CHECKs: cash with last4 refused
  begin
    insert into public.pos_payments (id, order_id, restaurant_id, method, amount_cents, tendered_cents, change_cents, status, last4)
    values (gen_random_uuid(), v_oid, v_r, 'cash', 1, 1, 0, 'captured', '1234');
    raise exception 'SMOKE FAIL: cash with last4 accepted';
  exception when check_violation then null;
  end;
  n := n + 1;
  -- 15. API roles can't read POS orders
  set local role anon;
  begin
    perform 1 from public.pos_orders limit 1;
    raise exception 'SMOKE FAIL: anon can read pos_orders';
  exception when insufficient_privilege then null;
  end;
  reset role;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
