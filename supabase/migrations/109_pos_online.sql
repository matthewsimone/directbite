-- 109_pos_online.sql — POS online orders, server side (CP17a v2 / CP17b part 1; DIRECTBITE-HANDOFF item 11).
--
--   pos_restaurant_settings   one row per restaurant: which register auto-prints online orders
--                             (print_register_device_id; NULL = no POS auto-print). Who / when last changed.
--   pos_online_print_claims   one row per online order the POS auto-prints: exactly one register prints it.
--                             result claimed | printed | failed, attempt, 60 s lease (pos_claim_online_print).
--   pos_online_print_log      APPEND-ONLY history of every claim / finish (order, device, result, at, detail).
--   pos_online_actions        one row per device action (action_id generated on the device): idempotency
--                             (same id + same request → the stored result), audit, email-once lookups.
--
-- ZERO CHANGES TO ONLINE ORDERING: no column / trigger / default / sequence / FK on orders, order_items,
-- print_logs, adjustment_requests or any table the live ordering / printing path writes. order_id columns
-- here have NO foreign key (an FK would put RI triggers on orders). restaurant_id → restaurants and
-- device_id → pos_devices, as in 101 / 103–106 (restaurants already carries those RI triggers; they only
-- fire when restaurants.id itself changes or a restaurant is deleted).
--
-- Functions (SECURITY INVOKER, service_role only):
--   pos_set_print_register(restaurant, device|null, updated_by)          → upsert pos_restaurant_settings
--   pos_claim_online_print(restaurant, order, device)                     → CAS claim, 60 s lease
--   pos_finish_online_print(restaurant, order, device, attempt, result, detail) → printed | failed
--   pos_online_action_begin(action_id, restaurant, device, staff, order, action, request)
--   pos_online_action_complete(action_id, device, result, http_status)
-- The caller checks that the order belongs to the restaurant (orders is read in TS, never written here).
-- _shared/pos-online/store.ts: PgOnlineStore calls these; MemoryOnlineStore mirrors them for tests.
--
-- Access: RLS on, no policies; nothing for anon / authenticated / public. LESSON FROM 108: Supabase's default
-- privileges give service_role ALL on every new table, so each table is `revoke all … from service_role`
-- first and then granted exactly:
--   pos_restaurant_settings   select insert update        (no delete: clear = set the device to NULL)
--   pos_online_print_claims   select insert update        (no delete; a printed claim is immutable, trigger)
--   pos_online_print_log      select insert               (append-only)
--   pos_online_actions        select insert update        (no delete; a completed action is immutable, trigger)
--
-- NOT APPLIED. Needs 101 (pos_devices) + 105 (pos_staff). Rollback: docs/migrations/109_rollback.sql.
-- Smoke: docs/migrations/109_smoke.sql. Verify: docs/migrations/109_verify.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------

create table public.pos_restaurant_settings (
  restaurant_id            uuid primary key references public.restaurants(id),
  print_register_device_id uuid references public.pos_devices(id),   -- NULL = no register auto-prints
  updated_at               timestamptz not null default now(),
  updated_by               text not null check (length(updated_by) between 1 and 200)
);

create table public.pos_online_print_claims (
  order_id      uuid primary key,                                     -- orders.id; NO FK (zero changes to orders)
  restaurant_id uuid not null references public.restaurants(id),
  device_id     uuid not null references public.pos_devices(id),      -- the register holding / that finished it
  result        text not null check (result in ('claimed', 'printed', 'failed')),
  attempt       int  not null check (attempt between 1 and 100),
  claimed_at    timestamptz not null,
  finished_at   timestamptz,
  check ((result = 'claimed') = (finished_at is null))
);
create index pos_online_print_claims_restaurant on public.pos_online_print_claims (restaurant_id, claimed_at desc);

create table public.pos_online_print_log (
  id            uuid primary key default gen_random_uuid(),             -- no sequence
  order_id      uuid not null,                                          -- NO FK
  restaurant_id uuid not null references public.restaurants(id),
  device_id     uuid not null references public.pos_devices(id),
  result        text not null check (result in ('claimed', 'printed', 'failed')),
  attempt       int  not null check (attempt between 1 and 100),
  at            timestamptz not null default now(),
  detail        jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);
create index pos_online_print_log_order on public.pos_online_print_log (order_id, at);

create table public.pos_online_actions (
  action_id     uuid primary key,                                       -- generated on the device
  restaurant_id uuid not null references public.restaurants(id),
  device_id     uuid not null references public.pos_devices(id),
  staff_id      uuid references public.pos_staff(id),
  order_id      uuid not null,                                          -- NO FK
  action        text not null check (action ~ '^[a-z][a-z0-9_]{0,39}$'),
  request       jsonb not null check (jsonb_typeof(request) = 'object'),
  result        jsonb check (result is null or jsonb_typeof(result) = 'object'),
  http_status   int check (http_status between 100 and 599),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  check ((result is null) = (http_status is null) and (result is null) = (completed_at is null))
);
create index pos_online_actions_order on public.pos_online_actions (restaurant_id, order_id, action);

-- ---------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------

-- The print register must be an ACTIVE register of the same restaurant (an FK can't say "same restaurant").
create or replace function public.pos_restaurant_settings_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.print_register_device_id is not null and not exists (
       select 1 from public.pos_devices d
        where d.id = new.print_register_device_id and d.restaurant_id = new.restaurant_id and d.status = 'active') then
    raise exception 'pos_restaurant_settings: print register must be an active register of this restaurant' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger trg_pos_restaurant_settings_guard before insert or update on public.pos_restaurant_settings
  for each row execute function public.pos_restaurant_settings_guard();

-- A printed claim never changes; order_id / restaurant_id never change.
create or replace function public.pos_online_print_claims_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.result = 'printed' or new.order_id <> old.order_id or new.restaurant_id <> old.restaurant_id then
    raise exception 'pos_online_print_claims: a printed claim (and order / restaurant) is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_print_claims_guard before update on public.pos_online_print_claims
  for each row execute function public.pos_online_print_claims_guard();

-- The only allowed update completes a pending action: result / http_status / completed_at, once.
create or replace function public.pos_online_actions_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.result is not null
     or (to_jsonb(new) - 'result' - 'http_status' - 'completed_at') is distinct from (to_jsonb(old) - 'result' - 'http_status' - 'completed_at') then
    raise exception 'pos_online_actions: only a pending action may be completed, once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_actions_guard before update on public.pos_online_actions
  for each row execute function public.pos_online_actions_guard();

-- ---------------------------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------------------------

-- p_device_id NULL turns POS auto-print off. Guard trigger checks the device.
create or replace function public.pos_set_print_register(p_restaurant_id uuid, p_device_id uuid, p_updated_by text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare s public.pos_restaurant_settings;
begin
  insert into public.pos_restaurant_settings (restaurant_id, print_register_device_id, updated_at, updated_by)
  values (p_restaurant_id, p_device_id, now(), p_updated_by)
  on conflict (restaurant_id) do update
     set print_register_device_id = excluded.print_register_device_id,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
  returning * into s;
  return jsonb_build_object('restaurant_id', s.restaurant_id, 'print_register_device_id', s.print_register_device_id,
                            'updated_at', s.updated_at, 'updated_by', s.updated_by);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- print claim: only one register prints an order
-- ---------------------------------------------------------------------------------------------
-- Outcomes ({ outcome, ... }):
--   device_not_allowed   device is not an active register of the restaurant
--   not_print_register   auto-print is off (no register set) or another register is the print register
--   claimed              print now: { attempt, lease_expires_at, takeover }
--                        (first claim; the same device again within its lease → same attempt; an expired
--                        lease or a failed attempt < 3 → attempt + 1)
--   held                 another register holds an unexpired lease: { device_id, lease_expires_at }
--   already_printed      { device_id, attempt }
--   attempts_exhausted   failed 3 times: { attempt } (staff prints by hand)
--   restaurant_mismatch  the order's claim belongs to another restaurant
-- Lease 60 s; at most 3 auto attempts (the tablet's own cap, useOrderPolling.js print_attempts < 3).
create or replace function public.pos_claim_online_print(p_restaurant_id uuid, p_order_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  c_lease constant interval := interval '60 seconds';
  c_max_attempts constant int := 3;
  v_now timestamptz := now();
  v_register uuid;
  c public.pos_online_print_claims;
  v_takeover boolean;
begin
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;
  select s.print_register_device_id into v_register from public.pos_restaurant_settings s where s.restaurant_id = p_restaurant_id;
  if v_register is null or v_register <> p_device_id then
    return jsonb_build_object('outcome', 'not_print_register', 'print_register_device_id', v_register);
  end if;

  insert into public.pos_online_print_claims (order_id, restaurant_id, device_id, result, attempt, claimed_at)
  values (p_order_id, p_restaurant_id, p_device_id, 'claimed', 1, v_now)
  on conflict (order_id) do nothing
  returning * into c;
  if found then
    insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
    values (p_order_id, p_restaurant_id, p_device_id, 'claimed', 1, v_now, '{}'::jsonb);
    return jsonb_build_object('outcome', 'claimed', 'attempt', 1, 'lease_expires_at', v_now + c_lease, 'takeover', false);
  end if;

  select * into c from public.pos_online_print_claims where order_id = p_order_id for update;
  if c.restaurant_id <> p_restaurant_id then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;
  if c.result = 'printed' then
    return jsonb_build_object('outcome', 'already_printed', 'device_id', c.device_id, 'attempt', c.attempt);
  end if;
  if c.result = 'claimed' and c.claimed_at + c_lease > v_now then
    if c.device_id = p_device_id then
      return jsonb_build_object('outcome', 'claimed', 'attempt', c.attempt, 'lease_expires_at', c.claimed_at + c_lease, 'takeover', false);
    end if;
    return jsonb_build_object('outcome', 'held', 'device_id', c.device_id, 'lease_expires_at', c.claimed_at + c_lease);
  end if;
  if c.attempt >= c_max_attempts then
    return jsonb_build_object('outcome', 'attempts_exhausted', 'attempt', c.attempt);
  end if;

  -- expired lease (takeover) or a failed attempt: next attempt
  v_takeover := c.result = 'claimed';
  update public.pos_online_print_claims
     set device_id = p_device_id, result = 'claimed', attempt = c.attempt + 1, claimed_at = v_now, finished_at = null
   where order_id = p_order_id;
  insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
  values (p_order_id, p_restaurant_id, p_device_id, 'claimed', c.attempt + 1, v_now,
          jsonb_build_object('takeover', v_takeover, 'previous_device_id', c.device_id, 'previous_result', c.result));
  return jsonb_build_object('outcome', 'claimed', 'attempt', c.attempt + 1, 'lease_expires_at', v_now + c_lease, 'takeover', v_takeover);
end;
$$;

-- Outcomes: recorded | duplicate (same device + attempt already finished with this result) |
--           lease_lost (another attempt / device holds it now; the result is still logged) |
--           not_claimed | restaurant_mismatch.
-- A late finish of the CURRENT attempt is recorded even after the lease ran out (nobody took over).
create or replace function public.pos_finish_online_print(p_restaurant_id uuid, p_order_id uuid, p_device_id uuid,
                                                          p_attempt int, p_result text, p_detail jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  c public.pos_online_print_claims;
begin
  if p_result is null or p_result not in ('printed', 'failed') then
    raise exception 'pos_finish_online_print: result must be printed or failed' using errcode = '22023';
  end if;
  if jsonb_typeof(v_detail) <> 'object' then
    raise exception 'pos_finish_online_print: detail must be an object' using errcode = '22023';
  end if;
  select * into c from public.pos_online_print_claims where order_id = p_order_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_claimed');
  end if;
  if c.restaurant_id <> p_restaurant_id then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;
  if c.device_id = p_device_id and c.attempt = p_attempt and c.result = p_result then
    return jsonb_build_object('outcome', 'duplicate', 'result', c.result, 'attempt', c.attempt);
  end if;
  if c.device_id = p_device_id and c.attempt = p_attempt and c.result = 'claimed' then
    update public.pos_online_print_claims set result = p_result, finished_at = v_now where order_id = p_order_id;
    insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
    values (p_order_id, p_restaurant_id, p_device_id, p_result, p_attempt, v_now, v_detail);
    return jsonb_build_object('outcome', 'recorded', 'result', p_result, 'attempt', p_attempt);
  end if;
  insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
  values (p_order_id, p_restaurant_id, p_device_id, p_result, greatest(1, least(coalesce(p_attempt, 1), 100)), v_now,
          v_detail || jsonb_build_object('lease_lost', true));
  return jsonb_build_object('outcome', 'lease_lost', 'device_id', c.device_id, 'attempt', c.attempt, 'result', c.result);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- actions: idempotency + audit
-- ---------------------------------------------------------------------------------------------
-- begin → started (new row, pending) | pending (same request, not completed yet) |
--         duplicate { result, http_status } (same request, completed) | action_id_reused (anything differs).
create or replace function public.pos_online_action_begin(p_action_id uuid, p_restaurant_id uuid, p_device_id uuid,
                                                          p_staff_id uuid, p_order_id uuid, p_action text, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  insert into public.pos_online_actions (action_id, restaurant_id, device_id, staff_id, order_id, action, request)
  values (p_action_id, p_restaurant_id, p_device_id, p_staff_id, p_order_id, p_action, p_request)
  on conflict (action_id) do nothing
  returning * into a;
  if found then
    return jsonb_build_object('outcome', 'started');
  end if;
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id or a.staff_id is distinct from p_staff_id
     or a.order_id <> p_order_id or a.action <> p_action or a.request <> p_request then
    return jsonb_build_object('outcome', 'action_id_reused');
  end if;
  if a.result is null then
    return jsonb_build_object('outcome', 'pending');
  end if;
  return jsonb_build_object('outcome', 'duplicate', 'result', a.result, 'http_status', a.http_status);
end;
$$;

-- complete → completed | not_found | already_completed (the stored result stands) | device_mismatch.
create or replace function public.pos_online_action_complete(p_action_id uuid, p_device_id uuid, p_result jsonb, p_http_status int)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  select * into a from public.pos_online_actions where action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if a.device_id <> p_device_id then
    return jsonb_build_object('outcome', 'device_mismatch');
  end if;
  if a.result is not null then
    return jsonb_build_object('outcome', 'already_completed', 'result', a.result, 'http_status', a.http_status);
  end if;
  update public.pos_online_actions set result = p_result, http_status = p_http_status, completed_at = now()
   where action_id = p_action_id;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------

alter table public.pos_restaurant_settings enable row level security;
alter table public.pos_online_print_claims enable row level security;
alter table public.pos_online_print_log    enable row level security;
alter table public.pos_online_actions      enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_restaurant_settings, public.pos_online_print_claims, public.pos_online_print_log,
                    public.pos_online_actions
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.pos_restaurant_settings to service_role;  -- no delete
grant select, insert, update on table public.pos_online_print_claims to service_role;  -- printed = immutable (trigger)
grant select, insert         on table public.pos_online_print_log    to service_role;  -- append-only
grant select, insert, update on table public.pos_online_actions      to service_role;  -- completed = immutable (trigger)

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_set_print_register(uuid, uuid, text)',
    'public.pos_claim_online_print(uuid, uuid, uuid)',
    'public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb)',
    'public.pos_online_action_begin(uuid, uuid, uuid, uuid, uuid, text, jsonb)',
    'public.pos_online_action_complete(uuid, uuid, jsonb, int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.pos_restaurant_settings_guard() from public, anon, authenticated;
revoke all on function public.pos_online_print_claims_guard() from public, anon, authenticated;
revoke all on function public.pos_online_actions_guard()      from public, anon, authenticated;

comment on table public.pos_restaurant_settings is 'POS per-restaurant settings: the register that auto-prints online orders (NULL = none).';
comment on table public.pos_online_print_claims is 'Exactly-once POS auto-print of an online order: one claim per order, 60 s lease, max 3 attempts. order_id has no FK by design.';
comment on table public.pos_online_print_log is 'Append-only history of POS online-print claims and results.';
comment on table public.pos_online_actions is 'POS online-order actions by device action_id: idempotency, audit, email-once. order_id has no FK by design.';

commit;
