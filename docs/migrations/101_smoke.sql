-- 101_smoke.sql — one-time smoke test of migration 101 (pos device auth), run by Matt in the
-- Supabase SQL editor AFTER 101 is applied, as postgres.
--
-- NOTHING PERSISTS: everything runs inside BEGIN … ROLLBACK. A failed check raises
-- 'SMOKE FAIL: <what>' (the transaction aborts; run ROLLBACK if the editor leaves it open).
-- Success prints one notice: 'SMOKE OK (all 48 checks)'.
--
-- Uses Test Pizza (slug 'test') and fake sha256-shaped hex values. No real token or code is
-- involved, and nothing here prints a hash (or anything longer than an 8-char prefix).
-- Lookup ids Z9Z1…Z9Z6 must not be live in pos_device_enrollments (true on a fresh 101).
-- Every one of the 7 functions is exercised: pos_next_prefix, pos_create_enrollment,
-- pos_consume_enrollment, pos_replay_enrollment, pos_record_enrollment_failure,
-- pos_record_auth_failed, pos_revoke_device.

begin;

do $$
declare
  n        int := 0;                         -- checks passed
  t0       timestamptz := now();
  t_far    timestamptz := now() + interval '10 days';   -- an empty auth_failed window
  v_admin  uuid := gen_random_uuid();
  v_r      uuid;
  v_p0     text;
  v_p      text;
  r        jsonb;
  v_txt    text;
  v_bool   boolean;
  v_e1     uuid;
  v_e2     uuid;
  v_e3     uuid;
  v_e5     uuid;
  v_dev    uuid;
  v_n1     uuid := gen_random_uuid();
  v_cnt    int;
  v_row    record;
  -- fake sha256-shaped values (64 hex chars); never printed
  h_s1 text := encode(sha256(convert_to('smoke-secret-1', 'UTF8')), 'hex');
  h_s2 text := encode(sha256(convert_to('smoke-secret-2', 'UTF8')), 'hex');
  h_t1 text := encode(sha256(convert_to('smoke-token-1', 'UTF8')), 'hex');
  h_t2 text := encode(sha256(convert_to('smoke-token-2', 'UTF8')), 'hex');
  h_t3 text := encode(sha256(convert_to('smoke-token-3', 'UTF8')), 'hex');
  h_t4 text := encode(sha256(convert_to('smoke-token-4', 'UTF8')), 'hex');
  h_t5 text := encode(sha256(convert_to('smoke-token-5', 'UTF8')), 'hex');
begin
  -- ---- setup ------------------------------------------------------------------------------
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;
  n := n + 1;

  -- ---- pos_next_prefix ----------------------------------------------------------------------
  v_p0 := public.pos_next_prefix(v_r);
  if v_p0 is null or v_p0 !~ '^[A-Z]{1,2}$' then raise exception 'SMOKE FAIL: pos_next_prefix returned no valid prefix'; end if;
  n := n + 1;

  -- ---- pos_create_enrollment: new device → the next free prefix ---------------------------
  r := public.pos_create_enrollment(v_r, 'Smoke A', null, 'Z9Z1', h_s1, t0 + interval '30 minutes', v_admin, t0);
  if coalesce((r->>'ok')::boolean, false) is not true then raise exception 'SMOKE FAIL: create new-device enrollment: %', r->>'reason'; end if;
  n := n + 1;
  if r->>'prefix' <> v_p0 or r->>'label' <> 'Smoke A' then raise exception 'SMOKE FAIL: new-device enrollment prefix/label'; end if;
  n := n + 1;
  v_e1 := (r->>'enrollment_id')::uuid;

  -- an unused new-device enrollment reserves its prefix
  v_p := public.pos_next_prefix(v_r);
  if v_p = v_p0 then raise exception 'SMOKE FAIL: pos_next_prefix did not skip a reserved prefix'; end if;
  n := n + 1;

  -- lookup_taken (duplicate LIVE lookup id)
  r := public.pos_create_enrollment(v_r, null, null, 'Z9Z1', h_s2, t0 + interval '30 minutes', v_admin, t0);
  if r->>'reason' is distinct from 'lookup_taken' then raise exception 'SMOKE FAIL: duplicate live lookup not refused'; end if;
  n := n + 1;

  -- unknown_device (re-enroll for a device that does not exist)
  r := public.pos_create_enrollment(v_r, null, gen_random_uuid(), 'Z9Z2', h_s2, t0 + interval '30 minutes', v_admin, t0);
  if r->>'reason' is distinct from 'unknown_device' then raise exception 'SMOKE FAIL: re-enroll for an unknown device not refused'; end if;
  n := n + 1;

  -- ---- pos_consume_enrollment -------------------------------------------------------------
  -- device_mismatch (new-device code + existing_device_id) → counted
  r := public.pos_consume_enrollment(v_e1, gen_random_uuid(), h_t1, gen_random_uuid(), 'Smoke HW', '9.9.9', '192.0.2.10', t0);
  if r->>'reason' is distinct from 'device_mismatch' then raise exception 'SMOKE FAIL: new-device code with existing_device_id not refused'; end if;
  n := n + 1;
  select failed_attempts into v_cnt from public.pos_device_enrollments where id = v_e1;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: device_mismatch not counted (failed_attempts=%)', v_cnt; end if;
  n := n + 1;

  -- success: new device
  r := public.pos_consume_enrollment(v_e1, v_n1, h_t1, null, 'Smoke HW', '9.9.9', '192.0.2.10', t0 + interval '1 second');
  if coalesce((r->>'ok')::boolean, false) is not true or (r->>'reenrolled')::boolean then raise exception 'SMOKE FAIL: consume (new device): %', r->>'reason'; end if;
  n := n + 1;
  if r->'device'->>'prefix' <> v_p0 then raise exception 'SMOKE FAIL: new device prefix'; end if;
  n := n + 1;
  if (r->'device') ? 'token_hash' or (r->'device') ? 'pending_token_hash' then raise exception 'SMOKE FAIL: consume returned a hash column'; end if;
  n := n + 1;
  v_dev := (r->'device'->>'id')::uuid;
  select * into v_row from public.pos_devices where id = v_dev;
  if v_row.token_hash <> h_t1 or v_row.status <> 'active' or v_row.restaurant_id <> v_r
     or v_row.hardware_model <> 'Smoke HW' or v_row.last_app_version <> '9.9.9' then
    raise exception 'SMOKE FAIL: pos_devices row after consume';
  end if;
  n := n + 1;
  select * into v_row from public.pos_device_enrollments where id = v_e1;
  if v_row.used_at is null or v_row.used_nonce <> v_n1 or v_row.used_device_id <> v_dev then raise exception 'SMOKE FAIL: enrollment not marked used'; end if;
  n := n + 1;
  if not exists (select 1 from public.pos_auth_attempts where ip = '192.0.2.10' and success) then raise exception 'SMOKE FAIL: no success attempt row'; end if;
  n := n + 1;
  if not exists (select 1 from public.pos_device_events where device_id = v_dev and type = 'enrolled' and actor = 'device') then raise exception 'SMOKE FAIL: no enrolled event'; end if;
  n := n + 1;

  -- not_usable on reuse → NOT counted against the code
  r := public.pos_consume_enrollment(v_e1, gen_random_uuid(), h_t3, null, null, null, '192.0.2.10', t0 + interval '2 seconds');
  if r->>'reason' is distinct from 'not_usable' then raise exception 'SMOKE FAIL: reuse of a used code not refused'; end if;
  n := n + 1;
  select failed_attempts into v_cnt from public.pos_device_enrollments where id = v_e1;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: reuse was counted against the code'; end if;
  n := n + 1;

  -- ---- pos_replay_enrollment --------------------------------------------------------------
  r := public.pos_replay_enrollment(v_e1, v_n1, h_t2, 600000, t0 + interval '5 minutes');
  if coalesce((r->>'ok')::boolean, false) is not true then raise exception 'SMOKE FAIL: replay with the same nonce inside the window refused'; end if;
  n := n + 1;
  if (select token_hash from public.pos_devices where id = v_dev) <> h_t2 then raise exception 'SMOKE FAIL: replay did not issue the fresh token'; end if;
  n := n + 1;
  r := public.pos_replay_enrollment(v_e1, gen_random_uuid(), h_t3, 600000, t0 + interval '6 minutes');
  if coalesce((r->>'ok')::boolean, false) then raise exception 'SMOKE FAIL: replay with a wrong nonce accepted'; end if;
  n := n + 1;
  r := public.pos_replay_enrollment(v_e1, v_n1, h_t3, 600000, t0 + interval '11 minutes');
  if coalesce((r->>'ok')::boolean, false) then raise exception 'SMOKE FAIL: replay after 10 minutes accepted'; end if;
  n := n + 1;
  if (select token_hash from public.pos_devices where id = v_dev) <> h_t2 then raise exception 'SMOKE FAIL: refused replay changed the token'; end if;
  n := n + 1;

  -- ---- expired → counted ----------------------------------------------------------------------
  r := public.pos_create_enrollment(v_r, null, null, 'Z9Z3', h_s2, t0 + interval '30 minutes', v_admin, t0);
  v_e2 := (r->>'enrollment_id')::uuid;
  if v_e2 is null then raise exception 'SMOKE FAIL: create enrollment Z9Z3'; end if;
  n := n + 1;
  r := public.pos_consume_enrollment(v_e2, gen_random_uuid(), h_t4, null, null, null, '192.0.2.11', t0 + interval '31 minutes');
  if r->>'reason' is distinct from 'expired' then raise exception 'SMOKE FAIL: expired code not refused'; end if;
  n := n + 1;
  select failed_attempts into v_cnt from public.pos_device_enrollments where id = v_e2;
  if v_cnt <> 1 then raise exception 'SMOKE FAIL: expired attempt not counted'; end if;
  n := n + 1;

  -- ---- pos_record_enrollment_failure ×5 → locked ----------------------------------------------
  r := public.pos_create_enrollment(v_r, null, null, 'Z9Z4', h_s2, t0 + interval '30 minutes', v_admin, t0);
  v_e3 := (r->>'enrollment_id')::uuid;
  if v_e3 is null then raise exception 'SMOKE FAIL: create enrollment Z9Z4'; end if;
  n := n + 1;
  for i in 1..4 loop
    r := public.pos_record_enrollment_failure('192.0.2.20', v_e3, t0 + make_interval(secs => i), 5);
  end loop;
  select * into v_row from public.pos_device_enrollments where id = v_e3;
  if v_row.locked_at is not null or v_row.failed_attempts <> 4 or (r->>'locked')::boolean then raise exception 'SMOKE FAIL: locked before 5 failures'; end if;
  n := n + 1;
  r := public.pos_record_enrollment_failure('192.0.2.20', v_e3, t0 + interval '5 seconds', 5);
  if coalesce((r->>'locked')::boolean, false) is not true then raise exception 'SMOKE FAIL: 5th failure did not report locked'; end if;
  n := n + 1;
  select * into v_row from public.pos_device_enrollments where id = v_e3;
  if v_row.locked_at is null or v_row.failed_attempts <> 5 then raise exception 'SMOKE FAIL: enrollment not locked at 5'; end if;
  n := n + 1;
  if not exists (select 1 from public.pos_device_events where type = 'enrollment_locked' and detail->>'lookup_id' = 'Z9Z4') then raise exception 'SMOKE FAIL: no enrollment_locked event'; end if;
  n := n + 1;
  select count(*) into v_cnt from public.pos_auth_attempts where ip = '192.0.2.20' and not success;
  if v_cnt <> 5 then raise exception 'SMOKE FAIL: failed attempt rows for the IP (%)', v_cnt; end if;
  n := n + 1;
  -- a 6th failure on a locked code is recorded for the IP but not counted
  r := public.pos_record_enrollment_failure('192.0.2.20', v_e3, t0 + interval '6 seconds', 5);
  if (select failed_attempts from public.pos_device_enrollments where id = v_e3) <> 5 then raise exception 'SMOKE FAIL: a locked code kept counting'; end if;
  n := n + 1;
  -- a failure with no enrollment: an attempt row only
  r := public.pos_record_enrollment_failure('192.0.2.21', null, t0, 5);
  if (select count(*) from public.pos_auth_attempts where ip = '192.0.2.21' and not success) <> 1 then raise exception 'SMOKE FAIL: uncounted failure wrote no attempt row'; end if;
  n := n + 1;
  -- a locked lookup id is no longer live: the same lookup can be issued again
  r := public.pos_create_enrollment(v_r, null, null, 'Z9Z4', h_s2, t0 + interval '30 minutes', v_admin, t0);
  if coalesce((r->>'ok')::boolean, false) is not true then raise exception 'SMOKE FAIL: a locked lookup id still blocks reuse'; end if;
  n := n + 1;

  -- ---- pos_record_auth_failed: cap 10 / minute ---------------------------------------------
  for i in 1..10 loop
    v_bool := public.pos_record_auth_failed(null, null, 'device_unregistered', t_far, 10);
    if not v_bool then raise exception 'SMOKE FAIL: auth_failed % of 10 refused', i; end if;
  end loop;
  n := n + 1;
  v_bool := public.pos_record_auth_failed(v_dev, v_r, 'device_unregistered', t_far, 10);
  if v_bool then raise exception 'SMOKE FAIL: 11th auth_failed in a minute was written'; end if;
  n := n + 1;

  -- ---- pos_revoke_device ------------------------------------------------------------------------
  v_txt := public.pos_revoke_device(v_dev, v_r, '   ', v_admin::text, t0);
  if v_txt <> 'reason_required' then raise exception 'SMOKE FAIL: revoke without a reason accepted'; end if;
  n := n + 1;
  v_txt := public.pos_revoke_device(v_dev, gen_random_uuid(), 'smoke', v_admin::text, t0);
  if v_txt <> 'unknown_device' then raise exception 'SMOKE FAIL: revoke scoped to another restaurant accepted'; end if;
  n := n + 1;
  v_txt := public.pos_revoke_device(v_dev, v_r, 'smoke', v_admin::text, t0);
  if v_txt <> 'revoked' then raise exception 'SMOKE FAIL: revoke'; end if;
  n := n + 1;
  select * into v_row from public.pos_devices where id = v_dev;
  if v_row.status <> 'revoked' or v_row.revoked_at is null or v_row.revoked_reason <> 'smoke' then raise exception 'SMOKE FAIL: device not revoked'; end if;
  n := n + 1;
  if not exists (select 1 from public.pos_device_events where device_id = v_dev and type = 'revoked' and actor = v_admin::text) then raise exception 'SMOKE FAIL: no revoked event with the admin actor'; end if;
  n := n + 1;

  -- ---- re-enroll: bound to the device, reactivates it --------------------------------------
  r := public.pos_create_enrollment(v_r, null, v_dev, 'Z9Z5', h_s2, t0 + interval '30 minutes', v_admin, t0);
  if coalesce((r->>'ok')::boolean, false) is not true or r->>'prefix' <> v_p0 then raise exception 'SMOKE FAIL: re-enroll code (bound, same prefix)'; end if;
  n := n + 1;
  v_e5 := (r->>'enrollment_id')::uuid;
  r := public.pos_consume_enrollment(v_e5, gen_random_uuid(), h_t5, null, null, null, '192.0.2.12', t0 + interval '1 second');
  if r->>'reason' is distinct from 'device_mismatch' then raise exception 'SMOKE FAIL: re-enroll code without existing_device_id accepted'; end if;
  n := n + 1;
  r := public.pos_consume_enrollment(v_e5, gen_random_uuid(), h_t5, v_dev, 'Smoke HW 2', null, '192.0.2.12', t0 + interval '2 seconds');
  if coalesce((r->>'ok')::boolean, false) is not true or not (r->>'reenrolled')::boolean or (r->'device'->>'id')::uuid <> v_dev then raise exception 'SMOKE FAIL: re-enroll consume: %', r->>'reason'; end if;
  n := n + 1;
  select * into v_row from public.pos_devices where id = v_dev;
  if v_row.status <> 'active' or v_row.revoked_at is not null or v_row.revoked_reason is not null
     or v_row.token_hash <> h_t5 or v_row.hardware_model <> 'Smoke HW 2' or v_row.last_app_version <> '9.9.9' then
    raise exception 'SMOKE FAIL: re-enroll did not reactivate the device';
  end if;
  n := n + 1;
  if not exists (select 1 from public.pos_device_events where device_id = v_dev and type = 'reenrolled') then raise exception 'SMOKE FAIL: no reenrolled event'; end if;
  n := n + 1;

  -- ---- pos_next_prefix never returns a taken prefix ------------------------------------------
  v_p := public.pos_next_prefix(v_r);
  if v_p in (select prefix from public.pos_devices where restaurant_id = v_r
             union select prefix from public.pos_device_enrollments where restaurant_id = v_r and target_device_id is null) then
    raise exception 'SMOKE FAIL: pos_next_prefix returned a taken prefix';
  end if;
  n := n + 1;

  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
