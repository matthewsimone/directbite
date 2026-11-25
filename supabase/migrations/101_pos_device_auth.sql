-- 101_pos_device_auth.sql — Ordr POS device registration & authentication (pos-v1).
--
-- Spec: ordr-pos docs/DEVICE-AUTH.md §2 (tables), §3 (secrets), §4.1 (register), §4.2 (middleware),
-- §5 (rate limits), §6 (admin). Reference behaviour: ordr-pos test/support/fakeDeviceAuth.ts.
-- Callers: supabase/functions/_shared/pos-device/store.ts (PgDeviceStore).
--
-- Access: RLS ENABLED with NO policies on every table, all grants revoked from anon /
-- authenticated → service role only. Registers never get a Supabase session (DEVICE-AUTH §0).
-- Functions: SECURITY INVOKER (service_role bypasses RLS), search_path pinned, EXECUTE for
-- service_role only. Each one is a single atomic critical section (supabase-js has no transactions).
--
-- Secrets: only sha256 hex of device tokens and of enrollment-code secrets is stored. Never the
-- token, never the code.
--
-- NOT APPLIED. Rollback: docs/migrations/101_rollback.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- Tables (DEVICE-AUTH §2)
-- ---------------------------------------------------------------------------------------------

create table public.pos_devices (
  id                       uuid primary key default gen_random_uuid(),
  restaurant_id            uuid not null references public.restaurants(id),
  prefix                   text not null check (prefix ~ '^[A-Z]{1,2}$'),
  label                    text not null,                 -- "Front counter"
  token_hash               text not null unique,          -- sha256 hex of the current token
  token_issued_at          timestamptz not null default now(),
  pending_token_hash       text unique,                   -- §7.3 rotation (build later; column now)
  pending_token_issued_at  timestamptz,
  status                   text not null check (status in ('active', 'revoked')),
  hardware_model           text,
  last_app_version         text,
  created_at               timestamptz not null default now(),
  last_seen_at             timestamptz,
  revoked_at               timestamptz,
  revoked_reason           text,
  unique (restaurant_id, prefix)                          -- prefixes never reused, even after revoke
);

create table public.pos_device_enrollments (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id),
  lookup_id        text not null check (lookup_id ~ '^[0-9A-HJKMNP-TV-Z]{4}$'),  -- public 4-char half
  secret_hash      text not null,                         -- sha256 hex of the 6-char secret half
  target_device_id uuid references public.pos_devices(id),-- null = new device; set = re-enroll that device only
  prefix           text check (prefix is null or prefix ~ '^[A-Z]{1,2}$'),        -- new device: assigned at creation
  label            text,
  expires_at       timestamptz not null,                  -- created_at + 30 min
  failed_attempts  int not null default 0,
  locked_at        timestamptz,                           -- set at 5 failed attempts
  used_at          timestamptz,
  used_nonce       uuid,                                  -- registration_nonce that consumed it
  used_device_id   uuid references public.pos_devices(id),
  created_by       uuid not null,                         -- admin auth uid
  created_at       timestamptz not null default now()
);

-- lookup_id unique among enrollments that are still usable:
create unique index pos_enrollments_live_lookup
  on public.pos_device_enrollments (lookup_id) where used_at is null and locked_at is null;
-- replay path: newest used enrollment for a lookup id
create index pos_enrollments_used_lookup
  on public.pos_device_enrollments (lookup_id, used_at desc) where used_at is not null;
-- prefix allocation
create index pos_enrollments_restaurant on public.pos_device_enrollments (restaurant_id);

create table public.pos_auth_attempts (                   -- registration rate limiting
  ip         inet not null,
  at         timestamptz not null default now(),
  success    boolean not null
);                                                        -- pruned daily (> 24 h), cron below
create index pos_auth_attempts_ip_failed on public.pos_auth_attempts (ip, at) where not success;
create index pos_auth_attempts_at on public.pos_auth_attempts (at);

create table public.pos_device_events (                   -- append-only audit
  id            bigint generated always as identity primary key,
  device_id     uuid references public.pos_devices(id),
  restaurant_id uuid,
  type          text not null check (type in
                  ('enrolled', 'reenrolled', 'revoked', 'rotation_offered', 'rotated',
                   'auth_failed', 'enrollment_failed', 'enrollment_locked')),
  actor         text not null,                            -- admin uid | 'device' | 'system'
  detail        jsonb,
  at            timestamptz not null default now()
);
create index pos_device_events_type_at on public.pos_device_events (type, at);
create index pos_device_events_device_at on public.pos_device_events (device_id, at);

-- ---------------------------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------------------------

alter table public.pos_devices            enable row level security;
alter table public.pos_device_enrollments enable row level security;
alter table public.pos_auth_attempts      enable row level security;
alter table public.pos_device_events      enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_devices, public.pos_device_enrollments,
                    public.pos_auth_attempts, public.pos_device_events
  from public, anon, authenticated;
revoke all on sequence public.pos_device_events_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.pos_devices, public.pos_device_enrollments,
                                              public.pos_auth_attempts, public.pos_device_events
  to service_role;
grant usage, select on sequence public.pos_device_events_id_seq to service_role;

-- ---------------------------------------------------------------------------------------------
-- pos_next_prefix: next unused of A…Z, then AA…ZZ. Taken = every device prefix of the restaurant
-- (active or revoked) + every NEW-device enrollment prefix (used, unused, expired or locked) —
-- prefixes are never reused (fakeDeviceAuth.ts nextPrefix). Call only under the restaurant's
-- advisory lock (pos_create_enrollment).
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_next_prefix(p_restaurant_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_letters constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_taken   text[];
  v_cand    text;
begin
  select coalesce(array_agg(t.p), '{}') into v_taken
  from (
    select d.prefix as p from public.pos_devices d where d.restaurant_id = p_restaurant_id
    union
    select e.prefix from public.pos_device_enrollments e
    where e.restaurant_id = p_restaurant_id and e.target_device_id is null and e.prefix is not null
  ) t;

  for i in 1..26 loop
    v_cand := substr(v_letters, i, 1);
    if not (v_cand = any (v_taken)) then return v_cand; end if;
  end loop;
  for i in 1..26 loop
    for j in 1..26 loop
      v_cand := substr(v_letters, i, 1) || substr(v_letters, j, 1);
      if not (v_cand = any (v_taken)) then return v_cand; end if;
    end loop;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_create_enrollment (admin §6): Add register (new device, prefix allocated now) or Re-enroll
-- (bound to that device record, keeps its prefix). Serialized per restaurant by an advisory lock
-- so two concurrent creates can't take the same prefix.
-- Returns {ok:true, enrollment_id, prefix, label} | {ok:false, reason: unknown_restaurant |
-- unknown_device | no_prefixes | lookup_taken}. lookup_taken → the caller retries with a new code.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_create_enrollment(
  p_restaurant_id    uuid,
  p_label            text,
  p_target_device_id uuid,
  p_lookup_id        text,
  p_secret_hash      text,
  p_expires_at       timestamptz,
  p_created_by       uuid,
  p_at               timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prefix text;
  v_label  text;
  v_dev    public.pos_devices%rowtype;
  v_id     uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('pos_device_prefix:' || p_restaurant_id::text, 0));

  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_restaurant');
  end if;

  if p_target_device_id is not null then
    select * into v_dev from public.pos_devices d
    where d.id = p_target_device_id and d.restaurant_id = p_restaurant_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'unknown_device');
    end if;
    v_prefix := v_dev.prefix;
    v_label  := coalesce(nullif(btrim(p_label), ''), v_dev.label);
  else
    v_prefix := public.pos_next_prefix(p_restaurant_id);
    if v_prefix is null then
      return jsonb_build_object('ok', false, 'reason', 'no_prefixes');
    end if;
    v_label := coalesce(nullif(btrim(p_label), ''), 'Register ' || v_prefix);
  end if;

  begin
    insert into public.pos_device_enrollments
      (restaurant_id, lookup_id, secret_hash, target_device_id, prefix, label, expires_at, created_by, created_at)
    values
      (p_restaurant_id, p_lookup_id, p_secret_hash, p_target_device_id, v_prefix, v_label, p_expires_at, p_created_by, p_at)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'lookup_taken');
  end;

  return jsonb_build_object('ok', true, 'enrollment_id', v_id, 'prefix', v_prefix, 'label', v_label);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_record_enrollment_failure (§4.1 step 4, §5): one failed attempt row for the IP, an
-- enrollment_failed event, and — when the enrollment is known AND still usable — failed_attempts+1,
-- locking it at p_max_fails (event enrollment_locked). p_enrollment_id null = not counted against
-- any code (unknown / malformed / used / locked).
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_record_enrollment_failure(
  p_ip            inet,
  p_enrollment_id uuid,
  p_at            timestamptz,
  p_max_fails     int default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_e      public.pos_device_enrollments%rowtype;
  v_locked boolean := false;
begin
  insert into public.pos_auth_attempts (ip, at, success) values (p_ip, p_at, false);

  if p_enrollment_id is not null then
    select * into v_e from public.pos_device_enrollments e where e.id = p_enrollment_id for update;
  end if;

  insert into public.pos_device_events (device_id, restaurant_id, type, actor, detail, at)
  values (v_e.target_device_id, v_e.restaurant_id, 'enrollment_failed', 'device',
          jsonb_build_object('lookup_id', v_e.lookup_id), p_at);

  if v_e.id is not null and v_e.used_at is null and v_e.locked_at is null then
    update public.pos_device_enrollments e
       set failed_attempts = e.failed_attempts + 1,
           locked_at = case when e.failed_attempts + 1 >= p_max_fails then p_at else null end
     where e.id = v_e.id
    returning e.locked_at is not null into v_locked;

    if v_locked then
      insert into public.pos_device_events (device_id, restaurant_id, type, actor, detail, at)
      values (v_e.target_device_id, v_e.restaurant_id, 'enrollment_locked', 'system',
              jsonb_build_object('lookup_id', v_e.lookup_id), p_at);
    end if;
  end if;

  return jsonb_build_object('locked', v_locked);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_consume_enrollment (§4.1 step 3, one transaction): lock the enrollment row, re-check it is
-- usable, then
--   new-device code: p_existing_device_id must be null → insert pos_devices, event 'enrolled';
--   re-enroll code:  p_existing_device_id must equal target_device_id → new token, clear pending,
--                    status active (reactivates a revoked device), event 'reenrolled';
-- mark the enrollment used and write a success attempt row. Failures do their own bookkeeping
-- (pos_record_enrollment_failure): expired / device_mismatch are counted against the code;
-- not_usable (used / locked / gone, i.e. lost a race) is not.
-- Returns {ok:true, reenrolled, device:{…no hashes…}} | {ok:false, reason}.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_consume_enrollment(
  p_enrollment_id      uuid,
  p_nonce              uuid,
  p_token_hash         text,
  p_existing_device_id uuid,
  p_hardware_model     text,
  p_app_version        text,
  p_ip                 inet,
  p_at                 timestamptz,
  p_max_fails          int default 5
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_e          public.pos_device_enrollments%rowtype;
  v_d          public.pos_devices%rowtype;
  v_reenrolled boolean := false;
begin
  select * into v_e from public.pos_device_enrollments e where e.id = p_enrollment_id for update;

  if not found or v_e.used_at is not null or v_e.locked_at is not null or v_e.prefix is null then
    perform public.pos_record_enrollment_failure(p_ip, null, p_at, p_max_fails);
    return jsonb_build_object('ok', false, 'reason', 'not_usable');
  end if;

  if p_at >= v_e.expires_at then
    perform public.pos_record_enrollment_failure(p_ip, v_e.id, p_at, p_max_fails);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  if v_e.target_device_id is null then
    if p_existing_device_id is not null then
      perform public.pos_record_enrollment_failure(p_ip, v_e.id, p_at, p_max_fails);
      return jsonb_build_object('ok', false, 'reason', 'device_mismatch');
    end if;

    insert into public.pos_devices
      (restaurant_id, prefix, label, token_hash, token_issued_at, status,
       hardware_model, last_app_version, created_at)
    values
      (v_e.restaurant_id, v_e.prefix, coalesce(v_e.label, 'Register ' || v_e.prefix), p_token_hash, p_at, 'active',
       p_hardware_model, p_app_version, p_at)
    returning * into v_d;

    insert into public.pos_device_events (device_id, restaurant_id, type, actor, detail, at)
    values (v_d.id, v_d.restaurant_id, 'enrolled', 'device', jsonb_build_object('lookup_id', v_e.lookup_id), p_at);
  else
    if p_existing_device_id is distinct from v_e.target_device_id then
      perform public.pos_record_enrollment_failure(p_ip, v_e.id, p_at, p_max_fails);
      return jsonb_build_object('ok', false, 'reason', 'device_mismatch');
    end if;

    update public.pos_devices d
       set token_hash              = p_token_hash,
           token_issued_at         = p_at,
           pending_token_hash      = null,
           pending_token_issued_at = null,
           status                  = 'active',
           revoked_at              = null,
           revoked_reason          = null,
           hardware_model          = coalesce(p_hardware_model, d.hardware_model),
           last_app_version        = coalesce(p_app_version, d.last_app_version)
     where d.id = v_e.target_device_id
    returning * into v_d;

    if not found then
      perform public.pos_record_enrollment_failure(p_ip, null, p_at, p_max_fails);
      return jsonb_build_object('ok', false, 'reason', 'not_usable');
    end if;
    v_reenrolled := true;

    insert into public.pos_device_events (device_id, restaurant_id, type, actor, detail, at)
    values (v_d.id, v_d.restaurant_id, 'reenrolled', 'device', jsonb_build_object('lookup_id', v_e.lookup_id), p_at);
  end if;

  update public.pos_device_enrollments e
     set used_at = p_at, used_nonce = p_nonce, used_device_id = v_d.id
   where e.id = v_e.id;

  insert into public.pos_auth_attempts (ip, at, success) values (p_ip, p_at, true);

  return jsonb_build_object(
    'ok', true,
    'reenrolled', v_reenrolled,
    'device', to_jsonb(v_d) - 'token_hash' - 'pending_token_hash'
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_replay_enrollment (§4.1 step 2): the enrollment was used by THIS nonce less than p_window_ms
-- ago (the secret was checked by the caller) → a FRESH token for used_device_id (overwrite
-- token_hash; nothing to promote — the device never received the first one). Not an attempt.
-- Returns {ok:true, device:{…}} | {ok:false}.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_replay_enrollment(
  p_enrollment_id uuid,
  p_nonce         uuid,
  p_token_hash    text,
  p_window_ms     bigint,
  p_at            timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_e public.pos_device_enrollments%rowtype;
  v_d public.pos_devices%rowtype;
begin
  select * into v_e from public.pos_device_enrollments e where e.id = p_enrollment_id for update;
  if not found
     or v_e.used_at is null
     or v_e.used_device_id is null
     or v_e.used_nonce is distinct from p_nonce
     or p_at - v_e.used_at >= p_window_ms * interval '1 millisecond' then
    return jsonb_build_object('ok', false);
  end if;

  update public.pos_devices d
     set token_hash = p_token_hash, token_issued_at = p_at
   where d.id = v_e.used_device_id
  returning * into v_d;
  if not found then
    return jsonb_build_object('ok', false);
  end if;

  return jsonb_build_object('ok', true, 'device', to_jsonb(v_d) - 'token_hash' - 'pending_token_hash');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_record_auth_failed (§4.2): an auth_failed event, unless p_cap were already written in the
-- last minute (visibility without a log flood). Returns whether it wrote one.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_record_auth_failed(
  p_device_id     uuid,
  p_restaurant_id uuid,
  p_code          text,
  p_at            timestamptz,
  p_cap           int default 10
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (select count(*) from public.pos_device_events ev
      where ev.type = 'auth_failed' and ev.at > p_at - interval '1 minute') >= p_cap then
    return false;
  end if;
  insert into public.pos_device_events (device_id, restaurant_id, type, actor, detail, at)
  values (p_device_id, p_restaurant_id, 'auth_failed', 'system', jsonb_build_object('code', p_code), p_at);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_revoke_device (§6): status revoked + reason + event 'revoked' (actor = admin uid).
-- p_restaurant_id, when given, must own the device. Returns 'revoked' | 'unknown_device' |
-- 'reason_required'.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_revoke_device(
  p_device_id     uuid,
  p_restaurant_id uuid,
  p_reason        text,
  p_actor         text,
  p_at            timestamptz
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_d public.pos_devices%rowtype;
begin
  if btrim(coalesce(p_reason, '')) = '' then
    return 'reason_required';
  end if;
  update public.pos_devices d
     set status = 'revoked', revoked_at = p_at, revoked_reason = p_reason
   where d.id = p_device_id and (p_restaurant_id is null or d.restaurant_id = p_restaurant_id)
  returning * into v_d;
  if not found then
    return 'unknown_device';
  end if;
  insert into public.pos_device_events (device_id, restaurant_id, type, actor, detail, at)
  values (v_d.id, v_d.restaurant_id, 'revoked', p_actor, jsonb_build_object('reason', p_reason), p_at);
  return 'revoked';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Function privileges: service_role only.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.pos_next_prefix(uuid) from public, anon, authenticated;
revoke all on function public.pos_create_enrollment(uuid, text, uuid, text, text, timestamptz, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.pos_record_enrollment_failure(inet, uuid, timestamptz, int) from public, anon, authenticated;
revoke all on function public.pos_consume_enrollment(uuid, uuid, text, uuid, text, text, inet, timestamptz, int) from public, anon, authenticated;
revoke all on function public.pos_replay_enrollment(uuid, uuid, text, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.pos_record_auth_failed(uuid, uuid, text, timestamptz, int) from public, anon, authenticated;
revoke all on function public.pos_revoke_device(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;

grant execute on function public.pos_next_prefix(uuid) to service_role;
grant execute on function public.pos_create_enrollment(uuid, text, uuid, text, text, timestamptz, uuid, timestamptz) to service_role;
grant execute on function public.pos_record_enrollment_failure(inet, uuid, timestamptz, int) to service_role;
grant execute on function public.pos_consume_enrollment(uuid, uuid, text, uuid, text, text, inet, timestamptz, int) to service_role;
grant execute on function public.pos_replay_enrollment(uuid, uuid, text, bigint, timestamptz) to service_role;
grant execute on function public.pos_record_auth_failed(uuid, uuid, text, timestamptz, int) to service_role;
grant execute on function public.pos_revoke_device(uuid, uuid, text, text, timestamptz) to service_role;

comment on table public.pos_devices is
  'Ordr POS registers (DEVICE-AUTH §2). Service-role only. token_hash = sha256 hex of the device token.';
comment on table public.pos_device_enrollments is
  'One-time register enrollment codes (DEVICE-AUTH §2/§3). Service-role only. secret_hash = sha256 hex of the 6-char secret.';
comment on table public.pos_auth_attempts is
  'pos-v1-register-device attempts per IP (DEVICE-AUTH §5). Service-role only. Pruned after 24 h by cron pos-auth-attempts-prune.';
comment on table public.pos_device_events is
  'Append-only device audit (DEVICE-AUTH §2). Service-role only.';

commit;

-- Prune registration attempts older than 24 h (the longest rate-limit window), nightly.
-- Idempotent: cron.schedule with an existing name updates the job. pg_cron is enabled (see 093, 100).
select cron.schedule(
  'pos-auth-attempts-prune',
  '29 4 * * *',
  $$ delete from public.pos_auth_attempts where at < now() - interval '24 hours' $$
);
