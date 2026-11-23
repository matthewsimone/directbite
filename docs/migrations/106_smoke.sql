-- 106_smoke.sql — one-time smoke test of migration 106, run by Matt in the SQL editor AFTER 101, 103,
-- 104, 105 and 106 are applied, as postgres. NOTHING PERSISTS (BEGIN … ROLLBACK; one pos_order_number_seq
-- value is consumed). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all 16 checks)'. Prints no
-- row data. Hashes are placeholders: the edge functions verify content hashes before any apply.

begin;

do $$
declare
  n      int := 0;
  v_r    uuid;
  v_dev  uuid;
  v_snap text := encode(sha256(convert_to('smoke-106-snapshot', 'UTF8')), 'hex');
  v_oid  uuid := gen_random_uuid();
  v_pay  uuid := gen_random_uuid();
  v_sid  uuid := gen_random_uuid();
  v_mov  uuid := gen_random_uuid();
  v_ref  uuid := gen_random_uuid();
  v_z1   uuid := gen_random_uuid();
  v_z2   uuid := gen_random_uuid();
  v_bd   jsonb := '{"lines":[],"subtotal_cents":0,"discountable_subtotal_cents":0,"promo_discount_cents":0,"discounted_subtotal_cents":0,"loyalty_discount_face_cents":0,"loyalty_discount_applied_cents":0,"net_subtotal_cents":0,"delivery_fee_cents":0,"tip_cents":0,"recoup_cents":0,"service_fee_cents":0,"taxable_cents":0,"tax_cents":0,"total_cents":2068,"loyalty_earn":{"basis_cents":0,"base_points":0},"rates":{"promo_percent":null,"recoup_rate":"0","tax_rate":"0.08875"}}';
  v_shift jsonb;
  v_rf   jsonb;
  v_z    jsonb;
  v_resp jsonb := '{"result":"applied","flags":{}}';
  r      jsonb;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZW', 'smoke', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_snap, v_r, '{}');
  -- a closed cash order (sales day 2026-11-19) through 104's apply
  r := public.pos_apply_order_submission(jsonb_build_object(
      'order_id', v_oid, 'version', 1, 'base_server_version', 0, 'content_hash', 'o1', 'restaurant_id', v_r, 'device_id', v_dev,
      'ticket', jsonb_build_object('prefix', 'ZW', 'business_date', '2026-11-19', 'counter', 1),
      'order_type', 'pickup', 'channel', 'counter', 'status', 'closed', 'customer', jsonb_build_object('name', null, 'phone_e164', null),
      'note', null, 'ready_at', null, 'void_reason', null, 'delivery', null, 'menu_snapshot_hash', v_snap, 'lines', '[]'::jsonb,
      'tip', jsonb_build_object('mode', 'none', 'percent', null, 'amount_cents', null),
      'payments', jsonb_build_array(jsonb_build_object('id', v_pay, 'method', 'cash', 'amount_cents', 2068, 'tendered_cents', 2068,
                                    'change_cents', 0, 'status', 'captured', 'last4', null, 'external_ref', null)),
      'provisional_pricing', v_bd, 'pricing_config', '{}'::jsonb, 'device_time', '2026-11-19T17:00:00Z'),
    v_dev, v_r, jsonb_build_object('result', 'applied', 'order_number', 0, 'pricing', v_bd, 'priced_against_hash', v_snap, 'flags', '{}'::jsonb),
    now(), '2026-11-19'::date);
  if r->>'outcome' <> 'applied' or (select sales_day from public.pos_orders where order_id = v_oid) <> '2026-11-19' then raise exception 'SMOKE FAIL: order setup'; end if;

  v_shift := jsonb_build_object('shift_id', v_sid, 'version', 1, 'content_hash', 's1', 'restaurant_id', v_r, 'device_id', v_dev,
    'business_date', '2026-11-19', 'status', 'open', 'opened_at', '2026-11-19T15:00:00Z', 'opened_by', 'register',
    'starting_cash_cents', 15000, 'closed_at', null, 'closed_by', null, 'close_approved_by', null, 'counted_cash_cents', null,
    'expected_cash_cents', null, 'over_short_cents', null, 'movements', '[]'::jsonb, 'attribution', null, 'device_time', '2026-11-19T15:00:00Z');

  -- 1. shift v1 applied; 2. same key + hash → duplicate; 3. other hash → reuse
  if public.pos_apply_shift(v_shift, v_dev, v_r, v_resp, now())->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: shift v1'; end if;
  n := n + 1;
  if public.pos_apply_shift(v_shift, v_dev, v_r, v_resp, now())->>'outcome' <> 'duplicate' then raise exception 'SMOKE FAIL: shift duplicate'; end if;
  n := n + 1;
  if public.pos_apply_shift(jsonb_set(v_shift, '{content_hash}', '"s1x"'), v_dev, v_r, v_resp, now())->>'outcome' <> 'idempotency_key_reuse' then raise exception 'SMOKE FAIL: shift reuse'; end if;
  n := n + 1;
  -- 4. v2 with a paid-out → movement inserted once
  v_shift := jsonb_set(jsonb_set(jsonb_set(v_shift, '{version}', '2'), '{content_hash}', '"s2"'), '{movements}',
    jsonb_build_array(jsonb_build_object('id', v_mov, 'kind', 'paid_out', 'amount_cents', 2000, 'reason', 'Driver gas', 'actor', 'register', 'approved_by', null, 'created_at', '2026-11-19T16:00:00Z')));
  if public.pos_apply_shift(v_shift, v_dev, v_r, v_resp, now())->>'outcome' <> 'applied' or (select count(*) from public.pos_cash_movements where shift_id = v_sid) <> 1 then raise exception 'SMOKE FAIL: movement'; end if;
  n := n + 1;
  -- 5. the movement's amount changed → invalid_payload
  if public.pos_apply_shift(jsonb_set(jsonb_set(jsonb_set(v_shift, '{version}', '3'), '{content_hash}', '"s3x"'), '{movements,0,amount_cents}', '1'), v_dev, v_r, v_resp, now())->>'outcome' <> 'invalid_payload' then
    raise exception 'SMOKE FAIL: movement change accepted';
  end if;
  n := n + 1;
  -- 6. closing v4 applied (v3 skipped); 7. the late v3 → stale_ignored with server_version 4
  v_shift := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_shift, '{version}', '4'), '{content_hash}', '"s4"'), '{status}', '"closed"'),
    '{attribution}', jsonb_build_object('cash_payments', jsonb_build_array(jsonb_build_object('payment_id', v_pay, 'order_id', v_oid, 'amount_cents', 2068)), 'cash_payment_voids', '[]'::jsonb, 'cash_refunds', '[]'::jsonb));
  if public.pos_apply_shift(v_shift, v_dev, v_r, jsonb_build_object('flags', jsonb_build_object('drawer_unverified', true)), now())->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: close'; end if;
  n := n + 1;
  r := public.pos_apply_shift(jsonb_set(jsonb_set(v_shift, '{version}', '3'), '{content_hash}', '"s3"'), v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'stale_ignored' or (r->>'server_version')::int <> 4 then raise exception 'SMOKE FAIL: stale shift'; end if;
  n := n + 1;
  -- 8. v5 of a closed shift → shift_closed; 9. a direct edit of a closed shift → refused; flags may change
  if public.pos_apply_shift(jsonb_set(jsonb_set(v_shift, '{version}', '5'), '{content_hash}', '"s5"'), v_dev, v_r, v_resp, now())->>'outcome' <> 'shift_closed' then raise exception 'SMOKE FAIL: closed shift changed'; end if;
  n := n + 1;
  begin
    update public.pos_shifts set counted_cash_cents = 1 where shift_id = v_sid;
    raise exception 'SMOKE FAIL: closed shift edited';
  exception when insufficient_privilege then null;
  end;
  perform public.pos_set_shift_drawer_flags(v_sid, false, false);
  if (select flags->>'drawer_unverified' from public.pos_shifts where shift_id = v_sid) <> 'false' then raise exception 'SMOKE FAIL: re-verify flags'; end if;
  n := n + 1;

  -- refunds: 10. unknown payment / method / amount; 11. applied + duplicate
  v_rf := jsonb_build_object('refund_id', v_ref, 'version', 1, 'content_hash', 'r1', 'restaurant_id', v_r, 'device_id', v_dev,
    'order_id', v_oid, 'payment_id', gen_random_uuid(), 'method', 'cash', 'amount_cents', 300, 'reason', 'Wrong item', 'actor', 'register',
    'approved_by', null, 'business_date', '2026-11-19', 'shift_id', v_sid, 'created_at', '2026-11-19T18:00:00Z', 'device_time', '2026-11-19T18:00:00Z');
  if public.pos_apply_refund(v_rf, v_dev, v_r, v_resp, now())->>'outcome' <> 'unknown_payment' then raise exception 'SMOKE FAIL: unknown payment'; end if;
  v_rf := jsonb_set(v_rf, '{payment_id}', to_jsonb(v_pay));
  if public.pos_apply_refund(jsonb_set(v_rf, '{method}', '"external_card"'), v_dev, v_r, v_resp, now())->>'field' <> 'method'
     or public.pos_apply_refund(jsonb_set(v_rf, '{amount_cents}', '0'), v_dev, v_r, v_resp, now())->>'field' <> 'amount_cents' then
    raise exception 'SMOKE FAIL: refund method / amount';
  end if;
  n := n + 1;
  if public.pos_apply_refund(v_rf, v_dev, v_r, v_resp, now())->>'outcome' <> 'applied' or public.pos_apply_refund(v_rf, v_dev, v_r, v_resp, now())->>'outcome' <> 'duplicate' then
    raise exception 'SMOKE FAIL: refund apply / duplicate';
  end if;
  n := n + 1;

  -- Z: 12. #1 applied; 13. same sequence again → taken; supplemental rule; 14. post_z view before / after a covering supplemental
  v_z := jsonb_build_object('day_close_id', v_z1, 'version', 1, 'content_hash', 'z1', 'restaurant_id', v_r, 'device_id', v_dev,
    'business_date', '2026-11-19', 'z_number', 1, 'sequence', 1, 'supplemental', false, 'closed_at', '2026-11-20T03:00:00Z',
    'closed_by', 'register', 'approved_by', null, 'report', '{}'::jsonb,
    'covered', jsonb_build_object('order_ids', '[]'::jsonb, 'voided_order_ids', '[]'::jsonb, 'payment_ids', '[]'::jsonb, 'payment_void_ids', '[]'::jsonb, 'refund_ids', '[]'::jsonb, 'shift_ids', jsonb_build_array(v_sid)),
    'carried_over_order_ids', '[]'::jsonb, 'device_time', '2026-11-20T03:00:00Z');
  if public.pos_apply_day_close(v_z, v_dev, v_r, v_resp, now())->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: Z #1'; end if;
  n := n + 1;
  if public.pos_apply_day_close(jsonb_set(jsonb_set(v_z, '{day_close_id}', to_jsonb(v_z2)), '{content_hash}', '"z1b"'), v_dev, v_r, v_resp, now())->>'outcome' <> 'day_close_sequence_taken'
     or public.pos_apply_day_close(jsonb_set(jsonb_set(jsonb_set(v_z, '{day_close_id}', to_jsonb(v_z2)), '{content_hash}', '"z2x"'), '{sequence}', '2'), v_dev, v_r, v_resp, now())->>'field' <> 'supplemental' then
    raise exception 'SMOKE FAIL: Z sequence / supplemental rules';
  end if;
  n := n + 1;
  if (select count(*) from public.pos_post_z where device_id = v_dev and entity_type in ('order', 'refund')) <> 2
     or exists (select 1 from public.pos_post_z where entity_id = v_sid) then
    raise exception 'SMOKE FAIL: post_z view after Z #1';
  end if;
  v_z := jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_z, '{day_close_id}', to_jsonb(v_z2)), '{content_hash}', '"z2"'), '{sequence}', '2'), '{supplemental}', 'true'),
    '{covered}', (v_z->'covered') || jsonb_build_object('order_ids', jsonb_build_array(v_oid), 'refund_ids', jsonb_build_array(v_ref)));
  if public.pos_apply_day_close(v_z, v_dev, v_r, v_resp, now())->>'outcome' <> 'applied'
     or exists (select 1 from public.pos_post_z where device_id = v_dev) then
    raise exception 'SMOKE FAIL: a covering supplemental Z does not clear post_z';
  end if;
  n := n + 1;
  -- 15. insert-only: service_role can't update / delete movements, refunds, Zs
  if has_table_privilege('service_role', 'public.pos_refunds', 'UPDATE') or has_table_privilege('service_role', 'public.pos_cash_movements', 'DELETE') then
    raise exception 'SMOKE FAIL: insert-only privileges';
  end if;
  n := n + 1;
  -- 16. API roles can't read
  set local role anon;
  begin
    perform 1 from public.pos_shifts limit 1;
    raise exception 'SMOKE FAIL: anon can read pos_shifts';
  exception when insufficient_privilege then null;
  end;
  reset role;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
