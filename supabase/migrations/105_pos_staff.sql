-- 105_pos_staff.sql — Ordr POS staff PINs + roles, server side (DIRECTBITE-HANDOFF item 8;
-- ordr-pos STAFF.md §4, §7; SYNC-CONTRACT §3b).
--
--   pos_staff            staff of a restaurant: role, active, sort order, PIN = scrypt(PIN, salt) hex +
--                        the kdf params it was made with. NEVER deleted (deactivate only) — ids stay
--                        resolvable for history and for the unknown_actor flag.
--   pos_staff_settings   per restaurant: auto_lock_minutes, over_short_approval_cents,
--                        z_requires_manager, pin_kdf, + version (strictly increasing; EVERY change bumps
--                        it) and pins_on (set once a change leaves ≥ 1 active manager; never cleared).
--   pos_staff_snapshots  every published staff snapshot (restaurant_id, version) → hash + body, published_at.
--                        The first published_at = the register_actor_after_staff boundary; the history =
--                        the settings in effect at a row's time (approval_missing).
--   pos_staff_events     append-only staff audit (pos-v1-submit-staff-events), idempotent by event_id.
--
-- Changes go through ONE plpgsql call each (per-restaurant advisory lock, version bump, refusals):
--   pos_staff_add, pos_staff_set_pin, pos_staff_deactivate, pos_staff_reactivate, pos_staff_set_settings
-- (called by scripts/pos-staff.ts via _shared/pos-staff/store.ts PgStaffStore; MemoryStaffStore mirrors
-- them for tests). pos_staff_snapshot_source reads one version's rows in one statement.
--
-- Access: RLS on, no policies, revoked from anon / authenticated → service role only (as 101 / 104).
-- PIN hashes leave the server only through pos-v1-staff-snapshot.
--
-- NOT APPLIED. Needs 101 (pos_devices). Rollback: docs/migrations/105_rollback.sql.
-- Smoke: 105_smoke.sql. Verify: 105_verify.sql.

begin;

create table public.pos_staff (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  name          text not null check (char_length(name) between 1 and 60),
  role          text not null check (role in ('manager', 'staff', 'driver')),   -- driver reserved (STAFF.md S1)
  active        boolean not null default true,
  sort_order    int not null,
  pin_salt      text not null check (pin_salt ~ '^[0-9a-f]{32}$'),                -- 16 bytes hex
  pin_hash      text not null check (pin_hash ~ '^([0-9a-f]{2}){16,64}$'),         -- scrypt output hex
  kdf_alg       text not null check (kdf_alg = 'scrypt'),
  kdf_n         int not null check (kdf_n >= 1024),
  kdf_r         int not null check (kdf_r between 1 and 32),
  kdf_p         int not null check (kdf_p between 1 and 4),
  kdf_dk_len    int not null check (kdf_dk_len between 16 and 64),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index pos_staff_restaurant on public.pos_staff (restaurant_id, sort_order);

create table public.pos_staff_settings (
  restaurant_id              uuid primary key references public.restaurants(id),
  auto_lock_minutes          int not null default 5 check (auto_lock_minutes between 0 and 240),   -- 0 = never
  over_short_approval_cents  int not null default 500 check (over_short_approval_cents >= 0),
  z_requires_manager         boolean not null default true,
  pin_kdf                    jsonb not null default '{"alg": "scrypt", "n": 8192, "r": 7, "p": 1, "dk_len": 32}'::jsonb,
  version                    int not null default 0 check (version >= 0),
  pins_on                    boolean not null default false,
  updated_at                 timestamptz not null default now()
);

create table public.pos_staff_snapshots (
  restaurant_id  uuid not null references public.restaurants(id),
  version        int not null check (version >= 1),
  hash           text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  body           jsonb not null,                       -- the snapshot without server_time
  published_at   timestamptz not null default now(),
  primary key (restaurant_id, version)
);
create index pos_staff_snapshots_published on public.pos_staff_snapshots (restaurant_id, published_at);

create table public.pos_staff_events (
  event_id      uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  device_id     uuid not null references public.pos_devices(id),
  type          text not null check (type in ('sign_in', 'lock', 'pin_failed', 'staff_locked', 'staff_unlocked',
                                              'approval_granted', 'approval_denied', 'drawer_kick')),
  staff_id      text,                                  -- staff id / 'register' / null, as sent
  by_staff_id   text,
  purpose       text,                                  -- approval purpose / drawer_kick reason
  target_id     text,
  created_at    timestamptz not null,
  device_time   timestamptz not null,
  content_hash  text not null,
  payload       jsonb not null,                        -- as received (no PINs / hashes: none on the wire)
  flags         jsonb not null,
  response      jsonb not null,                        -- the ORIGINAL response (duplicate)
  received_at   timestamptz not null default now()
);
create index pos_staff_events_restaurant on public.pos_staff_events (restaurant_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------

-- Lock the restaurant's staff state and make sure its settings row exists; returns the row.
create or replace function public.pos_staff_lock(p_restaurant_id uuid)
returns public.pos_staff_settings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v public.pos_staff_settings%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('pos_staff:' || p_restaurant_id::text, 0));
  insert into public.pos_staff_settings (restaurant_id) values (p_restaurant_id) on conflict (restaurant_id) do nothing;
  select * into v from public.pos_staff_settings where restaurant_id = p_restaurant_id for update;
  return v;
end;
$$;

-- Bump the version; PINs go on (for good) once an active manager exists.
create or replace function public.pos_staff_bump(p_restaurant_id uuid)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version int;
begin
  update public.pos_staff_settings s
     set version = s.version + 1,
         pins_on = s.pins_on or exists (select 1 from public.pos_staff x where x.restaurant_id = p_restaurant_id and x.role = 'manager' and x.active),
         updated_at = now()
   where s.restaurant_id = p_restaurant_id
  returning s.version into v_version;
  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- changes (scripts/pos-staff.ts) — each returns { ok, staff_id, version } | { ok: false, reason }
-- ---------------------------------------------------------------------------------------------

create or replace function public.pos_staff_add(
  p_restaurant_id uuid, p_name text, p_role text, p_pin_salt text, p_pin_hash text, p_kdf jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_st public.pos_staff_settings%rowtype;
  v_id uuid;
begin
  v_st := public.pos_staff_lock(p_restaurant_id);
  if v_st.pin_kdf <> p_kdf then
    return jsonb_build_object('ok', false, 'reason', 'kdf_changed');   -- hashed with params that are no longer pin_kdf
  end if;
  insert into public.pos_staff (restaurant_id, name, role, sort_order, pin_salt, pin_hash, kdf_alg, kdf_n, kdf_r, kdf_p, kdf_dk_len)
  values (p_restaurant_id, btrim(p_name), p_role,
          coalesce((select max(sort_order) from public.pos_staff where restaurant_id = p_restaurant_id), 0) + 1,
          p_pin_salt, p_pin_hash, p_kdf->>'alg', (p_kdf->>'n')::int, (p_kdf->>'r')::int, (p_kdf->>'p')::int, (p_kdf->>'dk_len')::int)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'staff_id', v_id, 'version', public.pos_staff_bump(p_restaurant_id));
end;
$$;

create or replace function public.pos_staff_set_pin(p_staff_id uuid, p_pin_salt text, p_pin_hash text, p_kdf jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rid uuid;
  v_st  public.pos_staff_settings%rowtype;
begin
  select restaurant_id into v_rid from public.pos_staff where id = p_staff_id;
  if v_rid is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_st := public.pos_staff_lock(v_rid);
  if v_st.pin_kdf <> p_kdf then return jsonb_build_object('ok', false, 'reason', 'kdf_changed'); end if;
  update public.pos_staff
     set pin_salt = p_pin_salt, pin_hash = p_pin_hash, kdf_alg = p_kdf->>'alg', kdf_n = (p_kdf->>'n')::int,
         kdf_r = (p_kdf->>'r')::int, kdf_p = (p_kdf->>'p')::int, kdf_dk_len = (p_kdf->>'dk_len')::int, updated_at = now()
   where id = p_staff_id;
  return jsonb_build_object('ok', true, 'staff_id', p_staff_id, 'version', public.pos_staff_bump(v_rid));
end;
$$;

create or replace function public.pos_staff_deactivate(p_staff_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rid uuid;
  v_st  public.pos_staff_settings%rowtype;
begin
  select restaurant_id into v_rid from public.pos_staff where id = p_staff_id;
  if v_rid is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_st := public.pos_staff_lock(v_rid);
  -- once PINs are on, a restaurant must keep an active manager (the POS refuses such a list too)
  if v_st.pins_on and not exists (
       select 1 from public.pos_staff x
        where x.restaurant_id = v_rid and x.id <> p_staff_id and x.role = 'manager' and x.active) then
    return jsonb_build_object('ok', false, 'reason', 'last_active_manager');
  end if;
  update public.pos_staff set active = false, updated_at = now() where id = p_staff_id;
  return jsonb_build_object('ok', true, 'staff_id', p_staff_id, 'version', public.pos_staff_bump(v_rid));
end;
$$;

create or replace function public.pos_staff_reactivate(p_staff_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rid uuid;
  v_st  public.pos_staff_settings%rowtype;
begin
  select restaurant_id into v_rid from public.pos_staff where id = p_staff_id;
  if v_rid is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_st := public.pos_staff_lock(v_rid);
  if (select active from public.pos_staff where id = p_staff_id) then
    return jsonb_build_object('ok', true, 'staff_id', p_staff_id, 'version', v_st.version);   -- already active: no change, no bump
  end if;
  update public.pos_staff set active = true, updated_at = now() where id = p_staff_id;
  return jsonb_build_object('ok', true, 'staff_id', p_staff_id, 'version', public.pos_staff_bump(v_rid));
end;
$$;

create or replace function public.pos_staff_set_settings(
  p_restaurant_id uuid, p_auto_lock_minutes int, p_over_short_approval_cents int, p_z_requires_manager boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.pos_staff_lock(p_restaurant_id);
  update public.pos_staff_settings
     set auto_lock_minutes         = coalesce(p_auto_lock_minutes, auto_lock_minutes),
         over_short_approval_cents = coalesce(p_over_short_approval_cents, over_short_approval_cents),
         z_requires_manager        = coalesce(p_z_requires_manager, z_requires_manager)
   where restaurant_id = p_restaurant_id;
  return jsonb_build_object('ok', true, 'staff_id', '', 'version', public.pos_staff_bump(p_restaurant_id));
end;
$$;

-- One version's rows in ONE statement (consistent), for the snapshot builder; null = no staff configured.
create or replace function public.pos_staff_snapshot_source(p_restaurant_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select case when s.restaurant_id is null or not exists (select 1 from public.pos_staff x where x.restaurant_id = p_restaurant_id) then null
  else jsonb_build_object(
    'version', s.version,
    'settings', jsonb_build_object(
      'auto_lock_minutes', s.auto_lock_minutes,
      'over_short_approval_cents', s.over_short_approval_cents,
      'z_requires_manager', s.z_requires_manager,
      'pin_kdf', s.pin_kdf),
    'staff', (select jsonb_agg(jsonb_build_object(
                'id', x.id, 'name', x.name, 'role', x.role, 'active', x.active, 'sort_order', x.sort_order,
                'pin', jsonb_build_object('salt', x.pin_salt, 'hash', x.pin_hash),
                'kdf', jsonb_build_object('alg', x.kdf_alg, 'n', x.kdf_n, 'r', x.kdf_r, 'p', x.kdf_p, 'dk_len', x.kdf_dk_len))
                order by x.sort_order, x.id)
              from public.pos_staff x where x.restaurant_id = p_restaurant_id))
  end
  from (select p_restaurant_id as rid) q
  left join public.pos_staff_settings s on s.restaurant_id = q.rid;
$$;

-- ---------------------------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------------------------
alter table public.pos_staff           enable row level security;
alter table public.pos_staff_settings  enable row level security;
alter table public.pos_staff_snapshots enable row level security;
alter table public.pos_staff_events    enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_staff, public.pos_staff_settings, public.pos_staff_snapshots, public.pos_staff_events
  from public, anon, authenticated;

grant select, insert, update on table public.pos_staff           to service_role;  -- never delete (deactivate)
grant select, insert, update on table public.pos_staff_settings  to service_role;
grant select, insert         on table public.pos_staff_snapshots to service_role;  -- immutable
grant select, insert         on table public.pos_staff_events    to service_role;  -- append-only

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_staff_lock(uuid)', 'public.pos_staff_bump(uuid)',
    'public.pos_staff_add(uuid, text, text, text, text, jsonb)', 'public.pos_staff_set_pin(uuid, text, text, jsonb)',
    'public.pos_staff_deactivate(uuid)', 'public.pos_staff_reactivate(uuid)', 'public.pos_staff_set_settings(uuid, int, int, boolean)',
    'public.pos_staff_snapshot_source(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

comment on table public.pos_staff is 'POS staff (item 8). Never deleted — deactivate. pin_hash = scrypt(PIN, pin_salt) hex with the kdf_* params. Service role only.';
comment on table public.pos_staff_settings is 'POS staff settings + snapshot version (every change bumps it) + pins_on (never cleared).';
comment on table public.pos_staff_snapshots is 'Every published staff snapshot (SYNC §3b). First published_at = register_actor_after_staff boundary.';
comment on table public.pos_staff_events is 'Append-only staff audit (pos-v1-submit-staff-events), idempotent by event_id.';

commit;
