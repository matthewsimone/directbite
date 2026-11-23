-- 103_smoke.sql — one-time smoke test of migration 103, run by Matt in the SQL editor AFTER 103 is
-- applied, as postgres. NOTHING PERSISTS (BEGIN … ROLLBACK). Failure → 'SMOKE FAIL: <what>'.
-- Success → 'SMOKE OK (all 9 checks)'. Prints no row data.

begin;

do $$
declare
  n     int := 0;
  v_r   uuid;
  v_h   text := encode(sha256(convert_to('smoke-snapshot-103', 'UTF8')), 'hex');
  v_cnt int;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  n := n + 1;

  -- address columns exist, nullable, writable by postgres
  update public.restaurants set address_street = '1 Smoke St', address_city = 'Smoke', address_state = 'NJ', address_zip = '07030' where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: address columns not writable'; end if;
  update public.restaurants set address_street = null, address_city = null, address_state = null, address_zip = null where id = v_r;
  n := n + 1;

  -- insert … on conflict do nothing (the function's write) is idempotent
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_h, v_r, '{"smoke":true}') on conflict (hash) do nothing;
  insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (v_h, v_r, '{"smoke":"again"}') on conflict (hash) do nothing;
  select count(*) into v_cnt from public.pos_menu_snapshots where hash = v_h;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: duplicate hash stored'; end if;
  n := n + 1;
  if (select body->>'smoke' from public.pos_menu_snapshots where hash = v_h) <> 'true' then raise exception 'SMOKE FAIL: first body was overwritten'; end if;
  n := n + 1;
  if (select first_served_at from public.pos_menu_snapshots where hash = v_h) is null then raise exception 'SMOKE FAIL: first_served_at default'; end if;
  n := n + 1;

  -- the hash CHECK refuses a non-sha256 key
  begin
    insert into public.pos_menu_snapshots (hash, restaurant_id, body) values ('not-a-hash', v_r, '{}');
    raise exception 'SMOKE FAIL: a non-sha256 hash was accepted';
  exception when check_violation then null;
  end;
  n := n + 1;

  -- the FK refuses an unknown restaurant
  begin
    insert into public.pos_menu_snapshots (hash, restaurant_id, body) values (encode(sha256(convert_to('smoke-fk', 'UTF8')), 'hex'), gen_random_uuid(), '{}');
    raise exception 'SMOKE FAIL: unknown restaurant accepted';
  exception when foreign_key_violation then null;
  end;
  n := n + 1;

  -- API roles can't read it
  set local role anon;
  begin
    perform 1 from public.pos_menu_snapshots limit 1;
    raise exception 'SMOKE FAIL: anon can read pos_menu_snapshots';
  exception when insufficient_privilege then null;
  end;
  reset role;
  n := n + 1;
  set local role authenticated;
  begin
    perform 1 from public.pos_menu_snapshots limit 1;
    raise exception 'SMOKE FAIL: authenticated can read pos_menu_snapshots';
  exception when insufficient_privilege then null;
  end;
  reset role;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
