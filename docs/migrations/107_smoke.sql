-- 107_smoke.sql — one-time smoke test of migration 107, run by Matt in the SQL editor AFTER 101, 103, 104
-- and 107 are applied, as postgres. NOTHING PERSISTS: BEGIN … ROLLBACK, also on success (one
-- pos_order_number_seq value is consumed — sequences are not transactional). Failure → 'SMOKE FAIL: <what>'.
-- Success → 'SMOKE OK (all 6 checks)'. Prints no row data. The content hash is a placeholder: the edge
-- function verifies hashes before it ever calls the apply function.

begin;

do $$
declare
  n      int := 0;
  v_r    uuid;
  v_dev  uuid;
  v_snap text := encode(sha256(convert_to('smoke-107-snapshot', 'UTF8')), 'hex');
  v_oid  uuid := gen_random_uuid();
  v_pay  uuid := gen_random_uuid();
  v_bd   jsonb := '{"lines":[],"subtotal_cents":0,"discountable_subtotal_cents":0,"promo_discount_cents":0,"discounted_subtotal_cents":0,"loyalty_discount_face_cents":0,"loyalty_discount_applied_cents":0,"net_subtotal_cents":0,"delivery_fee_cents":0,"tip_cents":0,"recoup_cents":0,"service_fee_cents":0,"taxable_cents":0,"tax_cents":0,"total_cents":2068,"loyalty_earn":{"basis_cents":0,"base_points":0},"rates":{"promo_percent":null,"recoup_rate":"0","tax_rate":"0.08875"}}';
  v_p    jsonb;
  v_resp jsonb;
  r      jsonb;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  -- 1. the constraint exists
  if not exists (select 1 from pg_constraint where conrelid = 'public.pos_payments'::regclass and conname = 'pos_payments_void_reason_length') then
    raise exception 'SMOKE FAIL: pos_payments_void_reason_length missing';
  end if;
  n := n + 1;

  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZV', 'smoke', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_snap, v_r, '{}');
  v_p := jsonb_build_object(
    'order_id', v_oid, 'version', 1, 'base_server_version', 0, 'content_hash', 'h1', 'restaurant_id', v_r, 'device_id', v_dev,
    'ticket', jsonb_build_object('prefix', 'ZV', 'business_date', '2026-11-19', 'counter', 1),
    'order_type', 'pickup', 'channel', 'counter', 'status', 'open', 'customer', jsonb_build_object('name', null, 'phone_e164', null),
    'note', null, 'ready_at', null, 'void_reason', null, 'delivery', null, 'menu_snapshot_hash', v_snap, 'lines', '[]'::jsonb,
    'tip', jsonb_build_object('mode', 'none', 'percent', null, 'amount_cents', null),
    'payments', jsonb_build_array(jsonb_build_object('id', v_pay, 'method', 'cash', 'amount_cents', 2068, 'tendered_cents', 2068,
      'change_cents', 0, 'status', 'captured', 'last4', null, 'external_ref', null, 'void_reason', null)),
    'provisional_pricing', v_bd, 'pricing_config', '{}'::jsonb, 'device_time', '2026-11-19T17:00:00Z');
  v_resp := jsonb_build_object('result', 'applied', 'order_number', 0, 'pricing', v_bd, 'priced_against_hash', v_snap, 'flags', '{}'::jsonb);

  -- 2. captured payment stored with a null reason
  r := public.pos_apply_order_submission(v_p, v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'applied' or (select void_reason from public.pos_payments where id = v_pay) is not null then raise exception 'SMOKE FAIL: captured payment'; end if;
  n := n + 1;
  -- 3. the void (v2) stores the reason, in the same call
  v_p := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '2'), '{content_hash}', '"h2"'), '{payments,0,status}', '"voided"'),
                   '{payments,0,void_reason}', '"Wrong amount entered"');
  r := public.pos_apply_order_submission(v_p, v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'applied'
     or (select status || '|' || void_reason from public.pos_payments where id = v_pay) <> 'voided|Wrong amount entered' then
    raise exception 'SMOKE FAIL: void reason not stored';
  end if;
  n := n + 1;
  -- 4. a 501-char reason is refused by the CHECK — and the whole apply with it (nothing of v3 is kept)
  begin
    perform public.pos_apply_order_submission(
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_p, '{version}', '3'), '{content_hash}', '"h3"'),
        '{payments}', (v_p->'payments') || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'method', 'cash', 'amount_cents', 1,
          'tendered_cents', 1, 'change_cents', 0, 'status', 'voided', 'last4', null, 'external_ref', null, 'void_reason', repeat('x', 501)))),
        '{note}', '"v3"'),
      v_dev, v_r, v_resp, now());
    raise exception 'SMOKE FAIL: a 501-char void_reason was stored';
  exception when check_violation then null;
  end;
  if (select version from public.pos_orders where order_id = v_oid) <> 2
     or exists (select 1 from public.pos_order_submissions where order_id = v_oid and version = 3)
     or (select count(*) from public.pos_payments where order_id = v_oid) <> 1 then
    raise exception 'SMOKE FAIL: a failed apply left something behind';
  end if;
  n := n + 1;
  -- 5. an empty reason is refused; 500 chars are fine
  begin
    insert into public.pos_payments (id, order_id, restaurant_id, method, amount_cents, tendered_cents, change_cents, status, void_reason)
    values (gen_random_uuid(), v_oid, v_r, 'cash', 1, 1, 0, 'voided', '');
    raise exception 'SMOKE FAIL: an empty void_reason was stored';
  exception when check_violation then null;
  end;
  insert into public.pos_payments (id, order_id, restaurant_id, method, amount_cents, tendered_cents, change_cents, status, void_reason)
  values (gen_random_uuid(), v_oid, v_r, 'cash', 1, 1, 0, 'voided', repeat('x', 500));
  n := n + 1;
  -- 6. the apply function's signature is unchanged (107 does not touch it)
  if to_regprocedure('public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz, date)') is null then
    raise exception 'SMOKE FAIL: pos_apply_order_submission signature changed';
  end if;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
