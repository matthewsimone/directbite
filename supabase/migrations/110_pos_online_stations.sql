-- 110_pos_online_stations.sql — POS online printing per STATION (CP17b part 2; ordr-pos @ 7798d52
-- SYNC-CONTRACT §3c `pos-v1-online-print`, DIRECTBITE-HANDOFF item 11 DDL, src/dev/onlinePrintRules.ts).
--
-- What changes (pos_* tables only — nothing on orders / order_items / order_item_toppings / external_orders /
-- print_logs / restaurants or any live-path table; no FK, trigger, default or sequence on them):
--
--   pos_restaurant_settings   + pos_online_orders_enabled, online_auto_print_enabled, kitchenhub_auto_print_enabled
--                             (boolean, default false — the handoff DDL's flags; no row = every default).
--   pos_online_print_claims   RESHAPED to the contract: one claim per (order_channel, order_id); the claimer
--                             (device_id = the wire's claimed_by_device_id) + claimed_at never change; result =
--                             the order's outcome over its stations (null | printed | printed_unconfirmed |
--                             failed) + printed_at. 109's lease / attempt / finished_at are gone (the contract
--                             has no takeover: one print register; staff press Print).
--   pos_online_print_stations NEW (handoff DDL): one row per order + station — exactly one auto ticket per
--                             station. name / lines / position fixed once written; a printed station stays printed.
--   pos_online_print_log      + order_channel, action_id (unique), variant, station, error, device_time; result is
--                             printed | printed_unconfirmed | failed; 109's attempt column is gone.
--
-- Functions (SECURITY INVOKER, service_role only). 109's pos_claim_online_print(uuid,uuid,uuid) and
-- pos_finish_online_print(…) are DROPPED (never called: no online endpoint was deployed) and replaced by:
--   pos_claim_online_print(restaurant, channel, order, device, stations jsonb, print_status_printed)  = applyClaim
--   pos_record_online_print(restaurant, channel, order, device, action_id, variant, result, station jsonb,
--                           error, device_time)                                                     = applyPrintResult
--   pos_online_print_state(restaurant, order_ids uuid[])  → { claims, stations, log } (the feed's print block)
-- The caller (TS, _shared/pos-online/handlers.ts) checks the order: restaurant, items_written_at, and passes
-- print_status = 'printed' in (the tablet printed it before cut-over → never claimed). orders is never read or
-- written here. Concurrency: one transaction-scoped advisory lock per order (claim + record serialize).
--
-- PRECONDITION: pos_online_print_claims and pos_online_print_log are EMPTY (nothing deployed writes them; the 109
-- smoke rolled back). If not, this migration stops before changing anything.
--
-- Access: LESSON FROM 108 — the new table is `revoke all … from service_role` and then granted exactly:
--   pos_online_print_stations select insert update delete   (delete: ONLY pos_claim_online_print replacing the
--                                                            stations of an UNCLAIMED order — guard trigger refuses
--                                                            deleting a claimed order's stations)
-- 109's grants on the reshaped tables are unchanged (claims select/insert/update; log select/insert) and are
-- re-asserted below.
--
-- NOT APPLIED. Needs 109. Rollback: docs/migrations/110_rollback.sql. Smoke: docs/migrations/110_smoke.sql.
-- Verify: docs/migrations/110_verify.sql.

begin;

do $$
begin
  if exists (select 1 from public.pos_online_print_claims) or exists (select 1 from public.pos_online_print_log) then
    raise exception '110: pos_online_print_claims / pos_online_print_log are not empty — 110 reshapes them; stop and check'
      using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 109 functions this replaces
-- ---------------------------------------------------------------------------------------------

drop function public.pos_claim_online_print(uuid, uuid, uuid);
drop function public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb);
drop trigger trg_pos_online_print_claims_guard on public.pos_online_print_claims;

-- ---------------------------------------------------------------------------------------------
-- pos_restaurant_settings: the contract's flags
-- ---------------------------------------------------------------------------------------------

alter table public.pos_restaurant_settings
  add column pos_online_orders_enabled     boolean not null default false,   -- online orders show on the POS
  add column online_auto_print_enabled     boolean not null default false,   -- Ordr orders auto-print on the print register
  add column kitchenhub_auto_print_enabled boolean not null default false;   -- KitchenHub orders auto-print

-- ---------------------------------------------------------------------------------------------
-- pos_online_print_claims: reshape (empty — checked above)
-- ---------------------------------------------------------------------------------------------

do $$
declare r record;
begin
  -- 109's CHECKs (result claimed|printed|failed, attempt, the finished_at pairing) by whatever name they got
  for r in select conname from pg_constraint
            where conrelid = 'public.pos_online_print_claims'::regclass and contype = 'c' loop
    execute format('alter table public.pos_online_print_claims drop constraint %I', r.conname);
  end loop;
end;
$$;
alter table public.pos_online_print_claims drop constraint pos_online_print_claims_pkey;
alter table public.pos_online_print_claims
  drop column attempt,
  drop column finished_at,
  alter column result drop not null,
  add column order_channel text not null,
  add column printed_at    timestamptz;
alter table public.pos_online_print_claims
  add constraint pos_online_print_claims_pkey primary key (order_channel, order_id),
  add constraint pos_online_print_claims_channel_check check (order_channel in ('ordr', 'kitchenhub')),
  add constraint pos_online_print_claims_result_check check (result is null or result in ('printed', 'printed_unconfirmed', 'failed')),
  add constraint pos_online_print_claims_printed_at_check check (result is distinct from 'printed' or printed_at is not null);
create index pos_online_print_claims_order on public.pos_online_print_claims (order_id);

-- The claim's identity never changes: order, restaurant, claimer, claimed_at. result / printed_at follow the stations.
create or replace function public.pos_online_print_claims_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.order_channel <> old.order_channel or new.order_id <> old.order_id or new.restaurant_id <> old.restaurant_id
     or new.device_id <> old.device_id or new.claimed_at <> old.claimed_at then
    raise exception 'pos_online_print_claims: order, restaurant, claimer and claimed_at are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_print_claims_guard before update on public.pos_online_print_claims
  for each row execute function public.pos_online_print_claims_guard();

-- ---------------------------------------------------------------------------------------------
-- pos_online_print_stations (handoff DDL; restaurant FK as 109, no cascade)
-- ---------------------------------------------------------------------------------------------

create table public.pos_online_print_stations (
  order_channel  text not null check (order_channel in ('ordr', 'kitchenhub')),
  order_id       uuid not null,                                         -- orders.id / external_orders.id; NO FK
  station        text not null check (length(station) between 1 and 200),   -- the routing register's printer id (opaque)
  restaurant_id  uuid not null references public.restaurants(id),
  name           text not null check (length(name) between 1 and 200),      -- "Counter", "Pizza oven"
  lines          int[] not null check (cardinality(lines) <= 1000 and 0 <= all (lines)),  -- the order's item indexes
  position       int  not null check (position between 0 and 199),     -- served in this order (the counter ticket first)
  result         text check (result is null or result in ('printed', 'printed_unconfirmed', 'failed')),
  printed_at     timestamptz,
  check (result is distinct from 'printed' or printed_at is not null),
  primary key (order_channel, order_id, station)
);
create index pos_online_print_stations_order on public.pos_online_print_stations (order_id);

-- name / lines / position / keys are fixed; a printed station stays printed; a CLAIMED order's stations are never
-- deleted (only pos_claim_online_print replaces an unclaimed order's stations, before it inserts the claim).
create or replace function public.pos_online_print_stations_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.pos_online_print_claims c
                where c.order_channel = old.order_channel and c.order_id = old.order_id) then
      raise exception 'pos_online_print_stations: a claimed order''s stations are never deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.order_channel <> old.order_channel or new.order_id <> old.order_id or new.station <> old.station
     or new.restaurant_id <> old.restaurant_id or new.name <> old.name or new.lines <> old.lines or new.position <> old.position then
    raise exception 'pos_online_print_stations: only result / printed_at change' using errcode = '42501';
  end if;
  if old.result = 'printed' and new.result is distinct from 'printed' then
    raise exception 'pos_online_print_stations: a printed station stays printed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_print_stations_guard before update or delete on public.pos_online_print_stations
  for each row execute function public.pos_online_print_stations_guard();

-- ---------------------------------------------------------------------------------------------
-- pos_online_print_log: gains the station (+ the contract's columns); empty — checked above
-- ---------------------------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.pos_online_print_log'::regclass and contype = 'c' loop
    execute format('alter table public.pos_online_print_log drop constraint %I', r.conname);
  end loop;
end;
$$;
alter table public.pos_online_print_log
  drop column attempt,
  add column order_channel text not null,
  add column action_id     uuid not null,
  add column variant       text not null,
  add column station       text,                                        -- STATION ROUTING: the station the ticket was for
  add column error         text,
  add column device_time   timestamptz;
alter table public.pos_online_print_log
  add constraint pos_online_print_log_channel_check check (order_channel in ('ordr', 'kitchenhub')),
  add constraint pos_online_print_log_variant_check check (variant in ('auto', 'manual', 'reprint')),
  add constraint pos_online_print_log_result_check  check (result in ('printed', 'printed_unconfirmed', 'failed')),
  add constraint pos_online_print_log_station_check check (station is null or length(station) between 1 and 200),
  add constraint pos_online_print_log_error_check   check (error is null or length(error) <= 500),
  add constraint pos_online_print_log_detail_check  check (jsonb_typeof(detail) = 'object'),
  add constraint pos_online_print_log_action_id_key unique (action_id);

-- ---------------------------------------------------------------------------------------------
-- claim (= onlinePrintRules.ts applyClaim + the §3c designation / flag checks)
-- ---------------------------------------------------------------------------------------------
-- p_stations: [{ station, name, lines[int] }] (counter first; validated again in TS). Outcomes:
--   device_not_allowed   not an active register of the restaurant
--   not_designated       not the print register (none set, or another register)       → 400 not_designated
--   auto_print_off       the channel's auto-print flag is off                          → 400 auto_print_off
--   restaurant_mismatch  the order's print rows belong to another restaurant
--   ok { applied, claimed }  applied = this call claimed it (one row per station recorded); claimed = this
--                        device holds the claim. Already claimed (by anyone), a result already over the stations,
--                        or the tablet printed it (p_print_status_printed) → applied false.
create or replace function public.pos_claim_online_print(p_restaurant_id uuid, p_order_channel text, p_order_id uuid,
                                                         p_device_id uuid, p_stations jsonb, p_print_status_printed boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  s public.pos_restaurant_settings;
  c public.pos_online_print_claims;
  v_result text;
  e jsonb;
  i int := 0;
begin
  if p_order_channel is null or p_order_channel not in ('ordr', 'kitchenhub') then
    raise exception 'pos_claim_online_print: bad order_channel' using errcode = '22023';
  end if;
  if p_order_id is null or p_stations is null or jsonb_typeof(p_stations) <> 'array' or jsonb_array_length(p_stations) > 200 then
    raise exception 'pos_claim_online_print: stations must be an array' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;
  select * into s from public.pos_restaurant_settings where restaurant_id = p_restaurant_id;
  if not found or s.print_register_device_id is distinct from p_device_id then
    return jsonb_build_object('outcome', 'not_designated');
  end if;
  if (p_order_channel = 'ordr' and not s.online_auto_print_enabled)
     or (p_order_channel = 'kitchenhub' and not s.kitchenhub_auto_print_enabled) then
    return jsonb_build_object('outcome', 'auto_print_off');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pos_online_print:' || p_order_channel || ':' || p_order_id::text, 0));

  select * into c from public.pos_online_print_claims where order_channel = p_order_channel and order_id = p_order_id;
  if found then
    if c.restaurant_id <> p_restaurant_id then
      return jsonb_build_object('outcome', 'restaurant_mismatch');
    end if;
    return jsonb_build_object('outcome', 'ok', 'applied', false, 'claimed', c.device_id = p_device_id);
  end if;
  if exists (select 1 from public.pos_online_print_stations
              where order_channel = p_order_channel and order_id = p_order_id and restaurant_id <> p_restaurant_id) then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;
  -- the order's result over stations recorded before any claim (a reprint / Print with no claim)
  select case when count(*) = 0 then null
              when bool_or(result = 'failed') then 'failed'
              when bool_or(result = 'printed_unconfirmed') then 'printed_unconfirmed'
              when bool_and(coalesce(result = 'printed', false)) then 'printed'
              else null end
    into v_result
    from public.pos_online_print_stations where order_channel = p_order_channel and order_id = p_order_id;
  if v_result is not null or coalesce(p_print_status_printed, false) then
    return jsonb_build_object('outcome', 'ok', 'applied', false, 'claimed', false);
  end if;

  -- applyClaim: p.stations = the claim's stations (unclaimed rows replaced), result null
  delete from public.pos_online_print_stations where order_channel = p_order_channel and order_id = p_order_id;
  insert into public.pos_online_print_claims (order_channel, order_id, restaurant_id, device_id, claimed_at, result, printed_at)
  values (p_order_channel, p_order_id, p_restaurant_id, p_device_id, v_now, null, null);
  for e in select x from jsonb_array_elements(p_stations) t(x) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'station') <> 'string' or jsonb_typeof(e->'name') <> 'string'
       or jsonb_typeof(e->'lines') <> 'array' then
      raise exception 'pos_claim_online_print: station % is malformed', i using errcode = '22023';
    end if;
    insert into public.pos_online_print_stations (order_channel, order_id, station, restaurant_id, name, lines, position, result, printed_at)
    values (p_order_channel, p_order_id, e->>'station', p_restaurant_id, e->>'name',
            coalesce((select array_agg((l.v)::int order by l.ord) from jsonb_array_elements_text(e->'lines') with ordinality l(v, ord)), '{}'),
            i, null, null);
    i := i + 1;
  end loop;
  return jsonb_build_object('outcome', 'ok', 'applied', true, 'claimed', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- result (= onlinePrintRules.ts applyPrintResult, the station path)
-- ---------------------------------------------------------------------------------------------
-- Any active register of the restaurant may report (manual Print / Reprint run on every register).
-- p_station: { station, name, lines } — required (every register at 7798d52 sends one). Outcomes:
--   device_not_allowed | restaurant_mismatch
--   duplicate                     this action_id is already in the log (nothing changes; the caller skips the tablet write)
--   recorded { order_result, claimed_by }   order_result = the order's result over its stations after this result
create or replace function public.pos_record_online_print(p_restaurant_id uuid, p_order_channel text, p_order_id uuid,
                                                          p_device_id uuid, p_action_id uuid, p_variant text, p_result text,
                                                          p_station jsonb, p_error text, p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  c public.pos_online_print_claims;
  st public.pos_online_print_stations;
  v_has_claim boolean;
  v_station text;
  v_order_result text;
begin
  if p_order_channel is null or p_order_channel not in ('ordr', 'kitchenhub') or p_order_id is null or p_action_id is null
     or p_variant is null or p_variant not in ('auto', 'manual', 'reprint')
     or p_result is null or p_result not in ('printed', 'printed_unconfirmed', 'failed')
     or p_station is null or jsonb_typeof(p_station) <> 'object' or jsonb_typeof(p_station->'station') <> 'string'
     or jsonb_typeof(p_station->'name') <> 'string' or jsonb_typeof(p_station->'lines') <> 'array' then
    raise exception 'pos_record_online_print: bad input' using errcode = '22023';
  end if;
  v_station := p_station->>'station';
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pos_online_print:' || p_order_channel || ':' || p_order_id::text, 0));

  if exists (select 1 from public.pos_online_print_log where action_id = p_action_id) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  select * into c from public.pos_online_print_claims where order_channel = p_order_channel and order_id = p_order_id;
  v_has_claim := found;
  if (v_has_claim and c.restaurant_id <> p_restaurant_id)
     or exists (select 1 from public.pos_online_print_stations
                 where order_channel = p_order_channel and order_id = p_order_id and restaurant_id <> p_restaurant_id) then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;

  -- every result appends to the POS print log
  insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, at, detail,
                                           order_channel, action_id, variant, station, error, device_time)
  values (p_order_id, p_restaurant_id, p_device_id, p_result, v_now, '{}'::jsonb,
          p_order_channel, p_action_id, p_variant, v_station, p_error, p_device_time);

  -- manual on an unclaimed order claims it for this device
  if p_variant = 'manual' and not v_has_claim then
    insert into public.pos_online_print_claims (order_channel, order_id, restaurant_id, device_id, claimed_at, result, printed_at)
    values (p_order_channel, p_order_id, p_restaurant_id, p_device_id, v_now, null, null)
    returning * into c;
    v_has_claim := true;
  end if;

  -- a station the order doesn't have yet is added (after the existing ones)
  select * into st from public.pos_online_print_stations
   where order_channel = p_order_channel and order_id = p_order_id and station = v_station;
  if not found then
    insert into public.pos_online_print_stations (order_channel, order_id, station, restaurant_id, name, lines, position, result, printed_at)
    values (p_order_channel, p_order_id, v_station, p_restaurant_id, p_station->>'name',
            coalesce((select array_agg((l.v)::int order by l.ord) from jsonb_array_elements_text(p_station->'lines') with ordinality l(v, ord)), '{}'),
            coalesce((select max(position) + 1 from public.pos_online_print_stations
                       where order_channel = p_order_channel and order_id = p_order_id), 0),
            null, null)
    returning * into st;
  end if;

  -- per station: any printed → printed; else an auto result by the claimer; else a first outcome (not a reprint)
  if p_result = 'printed' then
    update public.pos_online_print_stations set result = 'printed', printed_at = v_now
     where order_channel = p_order_channel and order_id = p_order_id and station = v_station;
  elsif p_variant = 'auto' and v_has_claim and c.device_id = p_device_id and st.result is distinct from 'printed' then
    update public.pos_online_print_stations set result = p_result
     where order_channel = p_order_channel and order_id = p_order_id and station = v_station;
  elsif p_variant <> 'reprint' and st.result is null then
    update public.pos_online_print_stations set result = p_result
     where order_channel = p_order_channel and order_id = p_order_id and station = v_station;
  end if;

  -- orderPrintResult over the stations
  select case when count(*) = 0 then null
              when bool_or(result = 'failed') then 'failed'
              when bool_or(result = 'printed_unconfirmed') then 'printed_unconfirmed'
              when bool_and(coalesce(result = 'printed', false)) then 'printed'
              else null end
    into v_order_result
    from public.pos_online_print_stations where order_channel = p_order_channel and order_id = p_order_id;
  if v_has_claim then
    update public.pos_online_print_claims
       set result = v_order_result,
           printed_at = case when v_order_result = 'printed' then v_now else printed_at end
     where order_channel = p_order_channel and order_id = p_order_id;
  end if;
  return jsonb_build_object('outcome', 'recorded', 'order_result', v_order_result,
                            'claimed_by', case when v_has_claim then c.device_id end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- read: the print block of the feed (restaurant-scoped; one statement)
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_online_print_state(p_restaurant_id uuid, p_order_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'claims', coalesce((select jsonb_agg(jsonb_build_object('order_channel', c.order_channel, 'order_id', c.order_id,
                                                            'device_id', c.device_id, 'claimed_at', c.claimed_at,
                                                            'result', c.result, 'printed_at', c.printed_at)
                                         order by c.order_channel, c.order_id)
                          from public.pos_online_print_claims c
                         where c.restaurant_id = p_restaurant_id and c.order_id = any (p_order_ids)), '[]'::jsonb),
    'stations', coalesce((select jsonb_agg(jsonb_build_object('order_channel', s.order_channel, 'order_id', s.order_id,
                                                              'station', s.station, 'name', s.name, 'lines', to_jsonb(s.lines),
                                                              'position', s.position, 'result', s.result, 'printed_at', s.printed_at)
                                           order by s.order_channel, s.order_id, s.position, s.station)
                            from public.pos_online_print_stations s
                           where s.restaurant_id = p_restaurant_id and s.order_id = any (p_order_ids)), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('order_channel', l.order_channel, 'order_id', l.order_id, 'at', l.at,
                                                         'device_id', l.device_id, 'variant', l.variant, 'result', l.result,
                                                         'error', l.error, 'station', l.station)
                                      order by l.at, l.id)
                       from public.pos_online_print_log l
                      where l.restaurant_id = p_restaurant_id and l.order_id = any (p_order_ids)), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------

alter table public.pos_online_print_stations enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_online_print_stations, public.pos_online_print_claims, public.pos_online_print_log,
                    public.pos_restaurant_settings
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pos_online_print_stations to service_role;  -- delete: guard trigger
grant select, insert, update         on table public.pos_online_print_claims   to service_role;  -- unchanged from 109
grant select, insert                 on table public.pos_online_print_log      to service_role;  -- append-only
grant select, insert, update         on table public.pos_restaurant_settings   to service_role;  -- unchanged from 109

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_claim_online_print(uuid, text, uuid, uuid, jsonb, boolean)',
    'public.pos_record_online_print(uuid, text, uuid, uuid, uuid, text, text, jsonb, text, timestamptz)',
    'public.pos_online_print_state(uuid, uuid[])'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.pos_online_print_claims_guard()   from public, anon, authenticated;
revoke all on function public.pos_online_print_stations_guard() from public, anon, authenticated;

comment on table public.pos_online_print_claims is 'POS auto-print claim of an online order (one per order_channel + order_id): the print register that claimed it; result / printed_at = the order''s outcome over its stations. order_id has no FK by design.';
comment on table public.pos_online_print_stations is 'STATION ROUTING: one row per online order + station (exactly one auto ticket per station). order_id has no FK by design.';
comment on table public.pos_online_print_log is 'Append-only log of every POS print result (auto / manual / reprint) per station; action_id unique.';

commit;
