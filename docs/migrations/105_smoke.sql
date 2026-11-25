-- 105_smoke.sql — one-time smoke test of migration 105, run by Matt in the SQL editor AFTER 101 and 105
-- are applied, as postgres. NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'.
-- Success → 'SMOKE OK (all 15 checks)'. Prints no row data. The salts / hashes below are placeholders
-- (hex of the right length), not real PINs.

begin;

do $$
declare
  n      int := 0;
  v_r    uuid;
  v_kdf  jsonb := '{"alg": "scrypt", "n": 8192, "r": 7, "p": 1, "dk_len": 32}';
  v_salt text := repeat('0', 31) || '1';
  v_hash text := repeat('ab', 32);
  r      jsonb;
  v_sam  uuid;
  v_m1   uuid;
  v_m2   uuid;
  v_src  jsonb;
  v_dev  uuid;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  if exists (select 1 from public.pos_staff where restaurant_id = v_r) then raise exception 'SMOKE FAIL: Test Pizza already has staff (run before setting up staff)'; end if;

  -- 1. no staff → no snapshot source
  if public.pos_staff_snapshot_source(v_r) is not null then raise exception 'SMOKE FAIL: source without staff'; end if;
  n := n + 1;
  -- 2. first add (a staff, no manager): version 1, sort 1, PINs still off
  r := public.pos_staff_add(v_r, 'Sam', 'staff', v_salt, v_hash, v_kdf);
  v_sam := (r->>'staff_id')::uuid;
  if not (r->>'ok')::boolean or (r->>'version')::int <> 1 or (select sort_order from public.pos_staff where id = v_sam) <> 1
     or (select pins_on from public.pos_staff_settings where restaurant_id = v_r) then
    raise exception 'SMOKE FAIL: first add';
  end if;
  n := n + 1;
  -- 3. hashed with other params than pin_kdf → refused, no version bump
  r := public.pos_staff_add(v_r, 'X', 'staff', v_salt, v_hash, '{"alg": "scrypt", "n": 1024, "r": 8, "p": 1, "dk_len": 32}');
  if r->>'reason' <> 'kdf_changed' or (select version from public.pos_staff_settings where restaurant_id = v_r) <> 1 then raise exception 'SMOKE FAIL: kdf guard'; end if;
  n := n + 1;
  -- 4. a manager → version 2, PINs on
  r := public.pos_staff_add(v_r, 'Maria', 'manager', v_salt, v_hash, v_kdf);
  v_m1 := (r->>'staff_id')::uuid;
  if (r->>'version')::int <> 2 or not (select pins_on from public.pos_staff_settings where restaurant_id = v_r) then raise exception 'SMOKE FAIL: manager add / pins_on'; end if;
  n := n + 1;
  -- 5. deactivating the only manager → refused
  r := public.pos_staff_deactivate(v_m1);
  if r->>'reason' <> 'last_active_manager' or not (select active from public.pos_staff where id = v_m1) then raise exception 'SMOKE FAIL: last manager deactivated'; end if;
  n := n + 1;
  -- 6. a second manager, then the first can go; versions keep increasing
  v_m2 := (public.pos_staff_add(v_r, 'Lee', 'manager', v_salt, v_hash, v_kdf)->>'staff_id')::uuid;
  r := public.pos_staff_deactivate(v_m1);
  if not (r->>'ok')::boolean or (r->>'version')::int <> 4 then raise exception 'SMOKE FAIL: deactivate with another manager'; end if;
  n := n + 1;
  -- 6b. reactivate: bumps once; already active → no bump; unknown → not_found
  r := public.pos_staff_reactivate(v_m1);
  if not (r->>'ok')::boolean or (r->>'version')::int <> 5 or not (select active from public.pos_staff where id = v_m1) then raise exception 'SMOKE FAIL: reactivate'; end if;
  if (public.pos_staff_reactivate(v_m1)->>'version')::int <> 5 then raise exception 'SMOKE FAIL: reactivate of an active staff bumped'; end if;
  if public.pos_staff_reactivate(gen_random_uuid())->>'reason' <> 'not_found' then raise exception 'SMOKE FAIL: reactivate unknown'; end if;
  r := public.pos_staff_deactivate(v_m1);   -- back to the state the next checks expect (version 6)
  n := n + 1;
  -- 7. set-pin bumps; unknown staff → not_found
  r := public.pos_staff_set_pin(v_sam, repeat('0', 31) || '2', repeat('cd', 32), v_kdf);
  if (r->>'version')::int <> 7 or (select pin_salt from public.pos_staff where id = v_sam) <> repeat('0', 31) || '2' then raise exception 'SMOKE FAIL: set-pin'; end if;
  if public.pos_staff_set_pin(gen_random_uuid(), v_salt, v_hash, v_kdf)->>'reason' <> 'not_found' then raise exception 'SMOKE FAIL: set-pin unknown'; end if;
  n := n + 1;
  -- 8. settings: partial update + bump
  r := public.pos_staff_set_settings(v_r, null, 1000, false);
  if (r->>'version')::int <> 8 or (select auto_lock_minutes from public.pos_staff_settings where restaurant_id = v_r) <> 5
     or (select over_short_approval_cents from public.pos_staff_settings where restaurant_id = v_r) <> 1000 then
    raise exception 'SMOKE FAIL: settings';
  end if;
  n := n + 1;
  -- 9. source: version 6, 3 staff ordered by sort_order (inactive included), settings carried
  v_src := public.pos_staff_snapshot_source(v_r);
  if (v_src->>'version')::int <> 8 or jsonb_array_length(v_src->'staff') <> 3 or v_src #>> '{staff,0,name}' <> 'Sam'
     or (v_src #>> '{staff,1,active}')::boolean or (v_src #>> '{settings,z_requires_manager}')::boolean
     or v_src #>> '{staff,0,pin,hash}' <> repeat('cd', 32) then
    raise exception 'SMOKE FAIL: snapshot source';
  end if;
  n := n + 1;
  -- 10. CHECKs: bad salt / role refused
  begin
    insert into public.pos_staff (restaurant_id, name, role, sort_order, pin_salt, pin_hash, kdf_alg, kdf_n, kdf_r, kdf_p, kdf_dk_len)
    values (v_r, 'Bad', 'owner', 9, 'xyz', v_hash, 'scrypt', 8192, 7, 1, 32);
    raise exception 'SMOKE FAIL: bad staff row accepted';
  exception when check_violation then null;
  end;
  n := n + 1;
  -- 11. snapshots: (restaurant, version) unique
  insert into public.pos_staff_snapshots (restaurant_id, version, hash, body) values (v_r, 8, repeat('e', 64), '{}');
  begin
    insert into public.pos_staff_snapshots (restaurant_id, version, hash, body) values (v_r, 8, repeat('f', 64), '{}');
    raise exception 'SMOKE FAIL: duplicate snapshot version';
  exception when unique_violation then null;
  end;
  n := n + 1;
  -- 12. events: event_id unique (idempotency key)
  insert into public.pos_devices (restaurant_id, prefix, label, token_hash, status)
  values (v_r, 'ZX', 'smoke', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'active') returning id into v_dev;
  insert into public.pos_staff_events (event_id, restaurant_id, device_id, type, staff_id, created_at, device_time, content_hash, payload, flags, response)
  values ('00000000-0000-4000-8000-0000000005e1', v_r, v_dev, 'sign_in', v_sam::text, now(), now(), 'h', '{}', '{}', '{}');
  begin
    insert into public.pos_staff_events (event_id, restaurant_id, device_id, type, created_at, device_time, content_hash, payload, flags, response)
    values ('00000000-0000-4000-8000-0000000005e1', v_r, v_dev, 'lock', now(), now(), 'h2', '{}', '{}', '{}');
    raise exception 'SMOKE FAIL: duplicate event id';
  exception when unique_violation then null;
  end;
  n := n + 1;
  -- 13. service_role can't delete staff (deactivate only)
  if has_table_privilege('service_role', 'public.pos_staff', 'DELETE') then raise exception 'SMOKE FAIL: staff deletable'; end if;
  n := n + 1;
  -- 14. API roles can't read PIN hashes
  set local role anon;
  begin
    perform 1 from public.pos_staff limit 1;
    raise exception 'SMOKE FAIL: anon can read pos_staff';
  exception when insufficient_privilege then null;
  end;
  reset role;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
