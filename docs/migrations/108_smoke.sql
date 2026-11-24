-- 108_smoke.sql — one-time smoke test of migration 108, run by Matt in the SQL editor AFTER 101, 103, 104,
-- 105, 106 and 108 are applied, as postgres. Everything after the restaurant lookup runs AS service_role
-- (set local role), i.e. with exactly the grants 108 leaves, through the same SQL functions the pos-v1-*
-- edge functions call. NOTHING PERSISTS (BEGIN … ROLLBACK; one pos_order_number_seq value is consumed).
-- Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'. Prints no row data.
--
-- Refusal probes only ever target rows this smoke created (where id = <smoke id>), so even on a database
-- without 108 they touch nothing real — and the final ROLLBACK undoes them anyway. No TRUNCATE probes
-- (a granted TRUNCATE would lock live tables until rollback); 108_verify.sql covers TRUNCATE.
--
-- Each apply runs in its OWN statement and is checked in the next one (a read in the same statement as a
-- volatile call uses the pre-call snapshot — the 106_smoke check 4 / 14 bug).
--
-- Orders are sent with lines [] : the line / modifier DELETEs and ON CONFLICT DO UPDATEs in
-- pos_apply_order_submission (104:328-363) still have their privileges checked at executor start.

begin;

do $$
declare
  n      int := 0;
  v_r    uuid;
  v_dev  uuid;
  v_dev2 uuid;
  v_snap text := encode(sha256(convert_to('smoke-108-snapshot', 'UTF8')), 'hex');
  v_oid  uuid := gen_random_uuid();
  v_pay  uuid := gen_random_uuid();
  v_pay2 uuid := gen_random_uuid();
  v_sid  uuid := gen_random_uuid();
  v_mov  uuid := gen_random_uuid();
  v_ref  uuid := gen_random_uuid();
  v_z1   uuid := gen_random_uuid();
  v_evt  uuid := gen_random_uuid();
  v_stf  uuid;
  v_kdf  jsonb;
  v_salt text := repeat('0', 31) || '1';
  v_hash text := repeat('ab', 32);
  v_ver  int;
  v_bd   jsonb := '{"lines":[],"subtotal_cents":0,"discountable_subtotal_cents":0,"promo_discount_cents":0,"discounted_subtotal_cents":0,"loyalty_discount_face_cents":0,"loyalty_discount_applied_cents":0,"net_subtotal_cents":0,"delivery_fee_cents":0,"tip_cents":0,"recoup_cents":0,"service_fee_cents":0,"taxable_cents":0,"tax_cents":0,"total_cents":2568,"loyalty_earn":{"basis_cents":0,"base_points":0},"rates":{"promo_percent":null,"recoup_rate":"0","tax_rate":"0.08875"}}';
  v_ord  jsonb;
  v_shift jsonb;
  v_resp jsonb := '{"result":"applied","flags":{}}';
  r      jsonb;
  b      boolean;
  t      text;
  q      text;
  v_refused text[];
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  -- 1. 101 devices: insert, touch (TS update, pos-device/store.ts:484), auth_failed event, revoke (update + event)
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZY', 'smoke-108', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZZ', 'smoke-108b', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev2;
  update public.pos_devices set last_seen_at = now() where id = v_dev;
  b := public.pos_record_auth_failed(v_dev, v_r, 'smoke', now(), 1000000);
  if not b then raise exception 'SMOKE FAIL: pos_record_auth_failed'; end if;
  t := public.pos_revoke_device(v_dev2, v_r, 'smoke 108', 'smoke', now());
  if t <> 'revoked' then raise exception 'SMOKE FAIL: pos_revoke_device'; end if;
  n := n + 1;

  -- 2. 103 menu snapshot: insert + the PostgREST ignoreDuplicates upsert (ON CONFLICT DO NOTHING) needs INSERT only
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_snap, v_r, '{}');
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_snap, v_r, '{}') on conflict (hash) do nothing;
  n := n + 1;

  -- 3. 104 order v1 (two captured cash payments): nextval, upsert, line / modifier delete + upsert, payment insert, submission
  v_ord := jsonb_build_object(
      'order_id', v_oid, 'version', 1, 'base_server_version', 0, 'content_hash', 'o1', 'restaurant_id', v_r, 'device_id', v_dev,
      'ticket', jsonb_build_object('prefix', 'ZY', 'business_date', '2026-11-19', 'counter', 1),
      'order_type', 'pickup', 'channel', 'counter', 'status', 'closed', 'customer', jsonb_build_object('name', null, 'phone_e164', null),
      'note', null, 'ready_at', null, 'void_reason', null, 'delivery', null, 'menu_snapshot_hash', v_snap, 'lines', '[]'::jsonb,
      'tip', jsonb_build_object('mode', 'none', 'percent', null, 'amount_cents', null),
      'payments', jsonb_build_array(
        jsonb_build_object('id', v_pay, 'method', 'cash', 'amount_cents', 2068, 'tendered_cents', 2068, 'change_cents', 0,
                           'status', 'captured', 'last4', null, 'external_ref', null, 'void_reason', null),
        jsonb_build_object('id', v_pay2, 'method', 'cash', 'amount_cents', 500, 'tendered_cents', 500, 'change_cents', 0,
                           'status', 'captured', 'last4', null, 'external_ref', null, 'void_reason', null)),
      'provisional_pricing', v_bd, 'pricing_config', '{}'::jsonb, 'device_time', '2026-11-19T17:00:00Z');
  r := public.pos_apply_order_submission(v_ord, v_dev, v_r,
         jsonb_build_object('result', 'applied', 'order_number', 0, 'pricing', v_bd, 'priced_against_hash', v_snap, 'flags', '{}'::jsonb),
         now(), '2026-11-19'::date);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: order v1 as service_role (%)', r->>'outcome'; end if;
  if (select count(*) from public.pos_payments where order_id = v_oid) <> 2 then raise exception 'SMOKE FAIL: order v1 payments'; end if;
  n := n + 1;

  -- 4. order v2: the second payment captured → voided (the only UPDATE on pos_payments, 104:375-379)
  v_ord := jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_ord, '{version}', '2'), '{base_server_version}', '1'), '{content_hash}', '"o2"'),
             '{payments,1,status}', '"voided"'), '{payments,1,void_reason}', '"smoke 108"');
  r := public.pos_apply_order_submission(v_ord, v_dev, v_r,
         jsonb_build_object('result', 'applied', 'order_number', 0, 'pricing', v_bd, 'priced_against_hash', v_snap, 'flags', '{}'::jsonb),
         now(), '2026-11-19'::date);
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: order v2 void as service_role (%)', r->>'outcome'; end if;
  if (select status from public.pos_payments where id = v_pay2) <> 'voided' or (select version from public.pos_orders where order_id = v_oid) <> 2 then
    raise exception 'SMOKE FAIL: order v2 not stored';
  end if;
  n := n + 1;

  -- 5. 106 shift v1 → v2 with a movement → closed v3 → drawer re-verify flags
  v_shift := jsonb_build_object('shift_id', v_sid, 'version', 1, 'content_hash', 's1', 'restaurant_id', v_r, 'device_id', v_dev,
    'business_date', '2026-11-19', 'status', 'open', 'opened_at', '2026-11-19T15:00:00Z', 'opened_by', 'register',
    'starting_cash_cents', 15000, 'closed_at', null, 'closed_by', null, 'close_approved_by', null, 'counted_cash_cents', null,
    'expected_cash_cents', null, 'over_short_cents', null, 'movements', '[]'::jsonb, 'attribution', null, 'device_time', '2026-11-19T15:00:00Z');
  r := public.pos_apply_shift(v_shift, v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: shift v1 (%)', r->>'outcome'; end if;
  v_shift := jsonb_set(jsonb_set(jsonb_set(v_shift, '{version}', '2'), '{content_hash}', '"s2"'), '{movements}',
    jsonb_build_array(jsonb_build_object('id', v_mov, 'kind', 'paid_out', 'amount_cents', 2000, 'reason', 'Driver gas', 'actor', 'register', 'approved_by', null, 'created_at', '2026-11-19T16:00:00Z')));
  r := public.pos_apply_shift(v_shift, v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'applied' or (select count(*) from public.pos_cash_movements where shift_id = v_sid) <> 1 then raise exception 'SMOKE FAIL: shift v2 movement'; end if;
  v_shift := jsonb_set(jsonb_set(jsonb_set(v_shift, '{version}', '3'), '{content_hash}', '"s3"'), '{status}', '"closed"');
  r := public.pos_apply_shift(v_shift, v_dev, v_r, jsonb_build_object('flags', jsonb_build_object('drawer_unverified', true)), now());
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: shift close (%)', r->>'outcome'; end if;
  perform public.pos_set_shift_drawer_flags(v_sid, false, false);
  if (select flags->>'drawer_unverified' from public.pos_shifts where shift_id = v_sid) <> 'false' then raise exception 'SMOKE FAIL: drawer flags'; end if;
  n := n + 1;

  -- 6. refund on the captured payment; 7. Z #1; post_z readable
  r := public.pos_apply_refund(jsonb_build_object('refund_id', v_ref, 'version', 1, 'content_hash', 'r1', 'restaurant_id', v_r, 'device_id', v_dev,
    'order_id', v_oid, 'payment_id', v_pay, 'method', 'cash', 'amount_cents', 300, 'reason', 'Wrong item', 'actor', 'register',
    'approved_by', null, 'business_date', '2026-11-19', 'shift_id', v_sid, 'created_at', '2026-11-19T18:00:00Z', 'device_time', '2026-11-19T18:00:00Z'),
    v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: refund (%)', r->>'outcome'; end if;
  n := n + 1;
  r := public.pos_apply_day_close(jsonb_build_object('day_close_id', v_z1, 'version', 1, 'content_hash', 'z1', 'restaurant_id', v_r, 'device_id', v_dev,
    'business_date', '2026-11-19', 'z_number', 1, 'sequence', 1, 'supplemental', false, 'closed_at', '2026-11-20T03:00:00Z',
    'closed_by', 'register', 'approved_by', null, 'report', '{}'::jsonb,
    'covered', jsonb_build_object('order_ids', '[]'::jsonb, 'voided_order_ids', '[]'::jsonb, 'payment_ids', '[]'::jsonb, 'payment_void_ids', '[]'::jsonb, 'refund_ids', '[]'::jsonb, 'shift_ids', jsonb_build_array(v_sid)),
    'carried_over_order_ids', '[]'::jsonb, 'device_time', '2026-11-20T03:00:00Z'), v_dev, v_r, v_resp, now());
  if r->>'outcome' <> 'applied' then raise exception 'SMOKE FAIL: day close (%)', r->>'outcome'; end if;
  if (select count(*) from public.pos_post_z where device_id = v_dev) < 1 then raise exception 'SMOKE FAIL: post_z read'; end if;
  n := n + 1;

  -- 8. 105 staff: add / set-pin / settings / deactivate / reactivate / source, snapshot + event inserts (TS upserts)
  v_kdf := coalesce((select pin_kdf from public.pos_staff_settings where restaurant_id = v_r), '{"alg": "scrypt", "n": 8192, "r": 7, "p": 1, "dk_len": 32}'::jsonb);
  r := public.pos_staff_add(v_r, 'Smoke108', 'staff', v_salt, v_hash, v_kdf);
  if not coalesce((r->>'ok')::boolean, false) then raise exception 'SMOKE FAIL: staff add (%)', r->>'reason'; end if;
  v_stf := (r->>'staff_id')::uuid;
  r := public.pos_staff_set_pin(v_stf, repeat('0', 31) || '2', repeat('cd', 32), v_kdf);
  if not (r->>'ok')::boolean then raise exception 'SMOKE FAIL: set-pin'; end if;
  r := public.pos_staff_deactivate(v_stf);
  if not (r->>'ok')::boolean then raise exception 'SMOKE FAIL: deactivate (%)', r->>'reason'; end if;
  r := public.pos_staff_reactivate(v_stf);
  if not (r->>'ok')::boolean then raise exception 'SMOKE FAIL: reactivate'; end if;
  r := public.pos_staff_set_settings(v_r, null, null, null);
  if not (r->>'ok')::boolean then raise exception 'SMOKE FAIL: settings'; end if;
  v_ver := (r->>'version')::int;
  if public.pos_staff_snapshot_source(v_r) is null then raise exception 'SMOKE FAIL: snapshot source'; end if;
  insert into public.pos_staff_snapshots (restaurant_id, version, hash, body) values (v_r, v_ver, repeat('e', 64), '{}')
    on conflict (restaurant_id, version) do nothing;
  insert into public.pos_staff_events (event_id, restaurant_id, device_id, type, staff_id, created_at, device_time, content_hash, payload, flags, response)
  values (v_evt, v_r, v_dev, 'sign_in', v_stf::text, now(), now(), 'h', '{}', '{}', '{}') on conflict (event_id) do nothing;
  if not exists (select 1 from public.pos_staff_events where event_id = v_evt) then raise exception 'SMOKE FAIL: staff event insert'; end if;
  n := n + 1;

  -- 9. every forbidden UPDATE / DELETE (and setval) is refused with insufficient_privilege
  v_refused := array[
    -- 103
    format('update public.pos_menu_snapshots set body = %L where hash = %L', '{"x":1}', v_snap),
    format('delete from public.pos_menu_snapshots where hash = %L', v_snap),
    -- 104
    format('delete from public.pos_orders where order_id = %L', v_oid),
    format('delete from public.pos_payments where id = %L', v_pay),
    format('update public.pos_order_submissions set response = %L where order_id = %L', '{}', v_oid),
    format('delete from public.pos_order_submissions where order_id = %L', v_oid),
    'select setval(''public.pos_order_number_seq'', 1)',
    -- 105
    format('delete from public.pos_staff where id = %L', v_stf),
    format('delete from public.pos_staff_settings where restaurant_id = %L and false', v_r),
    format('update public.pos_staff_snapshots set body = %L where restaurant_id = %L and version = %s', '{}', v_r, v_ver),
    format('delete from public.pos_staff_snapshots where restaurant_id = %L and version = %s', v_r, v_ver),
    format('update public.pos_staff_events set flags = %L where event_id = %L', '{}', v_evt),
    format('delete from public.pos_staff_events where event_id = %L', v_evt),
    -- 106
    format('delete from public.pos_shifts where shift_id = %L', v_sid),
    format('update public.pos_cash_movements set amount_cents = 1 where id = %L', v_mov),
    format('delete from public.pos_cash_movements where id = %L', v_mov),
    format('update public.pos_refunds set amount_cents = 1 where refund_id = %L', v_ref),
    format('delete from public.pos_refunds where refund_id = %L', v_ref),
    format('update public.pos_day_closes set report = %L where day_close_id = %L', '{}', v_z1),
    format('delete from public.pos_day_closes where day_close_id = %L', v_z1),
    format('update public.pos_entity_submissions set response = %L where entity_id = %L', '{}', v_sid),
    format('delete from public.pos_entity_submissions where entity_id = %L', v_sid)];
  foreach q in array v_refused loop
    begin
      execute q;
      raise exception 'SMOKE FAIL: allowed as service_role: %', split_part(q, ' where ', 1);
    exception when insufficient_privilege then null;
    end;
  end loop;
  n := n + 1;

  -- 10. the rows the refused statements targeted are all still there
  if (select count(*) from public.pos_payments where id = v_pay) <> 1 or (select count(*) from public.pos_cash_movements where id = v_mov) <> 1
     or (select amount_cents from public.pos_refunds where refund_id = v_ref) <> 300 or (select count(*) from public.pos_staff where id = v_stf) <> 1 then
    raise exception 'SMOKE FAIL: a refused statement changed data';
  end if;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
