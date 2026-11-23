-- 102_smoke.sql — one-time smoke test of migration 102 (restaurants tablet guard). Run by Matt in the
-- Supabase SQL editor AFTER 102 is applied, as postgres.
--
-- NOTHING PERSISTS: everything runs inside BEGIN … ROLLBACK. A failed check raises
-- 'SMOKE FAIL: <what>'. Success prints 'SMOKE OK (all 14 checks)'.
--
-- It simulates API callers the way PostgREST does: SET LOCAL ROLE authenticated + the JWT claims in
-- request.jwt.claims (read by auth.jwt() / is_admin()).
--   tablet = Test Pizza's tablet_email (must NOT be in admin_users)
--   admin  = an email from admin_users
-- No row data is printed.

begin;

do $$
declare
  n        int := 0;
  v_r      uuid;
  v_tablet text;
  v_admin  text;
  v_cnt    int;
  v_msg    text;
begin
  -- ---- setup (as postgres) ------------------------------------------------------------------
  select id, tablet_email into v_r, v_tablet from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  if v_tablet is null then raise exception 'SMOKE FAIL: Test Pizza has no tablet_email'; end if;
  if exists (select 1 from public.admin_users where email = v_tablet) then
    raise exception 'SMOKE FAIL: Test Pizza''s tablet_email is an admin — pick a non-admin tablet to test';
  end if;
  n := n + 1;
  select email into v_admin from public.admin_users limit 1;
  if v_admin is null then raise exception 'SMOKE FAIL: no admin_users row'; end if;
  n := n + 1;
  if not exists (select 1 from pg_trigger where tgname = 'trg_restaurants_tablet_guard' and not tgisinternal) then
    raise exception 'SMOKE FAIL: trigger trg_restaurants_tablet_guard missing';
  end if;
  n := n + 1;

  -- ---- as the TABLET -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('email', v_tablet, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  set local role authenticated;

  -- allowed: a column the tablet writes in Settings
  update public.restaurants set printer_ip = '192.0.2.123' where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: tablet could not update printer_ip (rows=%)', v_cnt; end if;
  n := n + 1;

  -- allowed: tax_rate (tablet-owned)
  update public.restaurants set tax_rate = tax_rate where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: tablet could not write tax_rate'; end if;
  n := n + 1;

  -- allowed: a protected column written with its UNCHANGED value (update(...).select() payloads)
  update public.restaurants set stripe_account_id = stripe_account_id, slug = slug where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: unchanged protected values were refused'; end if;
  n := n + 1;

  -- refused: each protected change raises 'column % is admin-only' (42501)
  declare
    v_cases text[][] := array[
      ['stripe_account_id', 'update public.restaurants set stripe_account_id = ''acct_smoke'' where id = $1'],
      ['uber_billing_mode', 'update public.restaurants set uber_billing_mode = case when uber_billing_mode = ''platform'' then ''self'' else ''platform'' end where id = $1'],
      ['slug',              'update public.restaurants set slug = slug || ''-smoke'' where id = $1'],
      ['tablet_email',      'update public.restaurants set tablet_email = ''smoke@example.com'' where id = $1'],
      ['recoup_rate',       'update public.restaurants set recoup_rate = case when recoup_rate = 0.05 then 0.06 else 0.05 end where id = $1'],
      ['is_open',           'update public.restaurants set is_open = not is_open where id = $1'],
      ['latitude',          'update public.restaurants set latitude = coalesce(latitude, 0) + 0.01 where id = $1']
    ];
    v_i int;
  begin
    for v_i in 1 .. array_length(v_cases, 1) loop
      begin
        execute v_cases[v_i][2] using v_r;
        get diagnostics v_cnt = row_count;
        if v_cnt = 0 then
          raise exception 'SMOKE FAIL: % case matched no row (precondition)', v_cases[v_i][1];
        end if;
        raise exception 'SMOKE FAIL: tablet changed protected column %', v_cases[v_i][1];
      exception when insufficient_privilege then
        get stacked diagnostics v_msg = message_text;
        if v_msg <> format('column %s is admin-only', v_cases[v_i][1]) then
          raise exception 'SMOKE FAIL: unexpected message for %: %', v_cases[v_i][1], v_msg;
        end if;
      end;
    end loop;
  end;
  n := n + 1; -- (7 protected columns refused, one check)

  -- ---- as an ADMIN (same role, admin email) -------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  update public.restaurants set stripe_account_id = 'acct_smoke_admin' where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: admin could not change stripe_account_id'; end if;
  n := n + 1;
  update public.restaurants set is_open = not is_open where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: admin could not toggle is_open'; end if;
  n := n + 1;

  -- ---- as service_role (edge functions) ------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  update public.restaurants set uber_credentials_verified_at = now(), dsp_orders_enabled = dsp_orders_enabled where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: service_role could not update a protected column'; end if;
  n := n + 1;

  -- ---- as postgres ---------------------------------------------------------------------------
  reset role;
  update public.restaurants set slug = slug || '-pg' where id = v_r;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: postgres could not update a protected column'; end if;
  n := n + 1;

  -- ---- anon has no update path at all (RLS), and the guard would refuse anyway ----------------
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  begin
    update public.restaurants set stripe_account_id = 'acct_anon' where id = v_r;
    get diagnostics v_cnt = row_count;
    if v_cnt <> 0 then raise exception 'SMOKE FAIL: anon updated a restaurant'; end if;
  exception when insufficient_privilege then
    null; -- refused by grants / guard: fine
  end;
  n := n + 1;
  reset role;

  -- ---- the function is not callable directly by API roles -------------------------------------
  if has_function_privilege('authenticated', 'public.restaurants_tablet_guard()', 'EXECUTE')
     or has_function_privilege('anon', 'public.restaurants_tablet_guard()', 'EXECUTE') then
    raise exception 'SMOKE FAIL: API roles can EXECUTE restaurants_tablet_guard()';
  end if;
  n := n + 1;

  -- ---- guard is SECURITY INVOKER with a pinned search_path ------------------------------------
  if not exists (select 1 from pg_proc p where p.oid = 'public.restaurants_tablet_guard()'::regprocedure
                 and not p.prosecdef and p.proconfig @> array['search_path=public']) then
    raise exception 'SMOKE FAIL: guard is not invoker / search_path not pinned';
  end if;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
