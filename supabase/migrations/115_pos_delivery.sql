set lock_timeout = '3s';
-- 115_pos_delivery.sql — POS delivery quotes + provider (Uber Direct) dispatch for COUNTER / PHONE orders (CP23;
-- ordr-pos @ 4f729e4 DELIVERY.md §2, §6.3, §7; SYNC-CONTRACT §2 pos-v1-quote-delivery).
--
-- pos_* ONLY. POS orders stay in pos_orders. NOTHING is written to orders, order_items, uber_quotes or any live-path
-- table; no column / trigger / default / FK on them. Provider-neutral (Matt): `provider` = 'uber_direct' now;
-- OrderOut / DoorDash / Grubhub drivers later.
--
--   pos_restaurant_settings   + pos_delivery_dispatch_enabled (boolean, default FALSE): provider dispatch on / off
--                             per restaurant (platform-billing recovery is undecided). Quotes work when off.
--   pos_delivery_quotes       the in-house quote (DELIVERY.md §2): server geocode, haversine from the restaurant,
--                             tier fee from the pinned snapshot; 24 h. submit-order reads it by id (fee_source quoted).
--   pos_delivery_provider_quotes  a provider quote (Uber's delivery_quotes) for one delivery quote: the provider fee
--                             split by the restaurant's EXISTING passthrough (customer / restaurant), billing mode,
--                             environment, expiry. submit-order reads it by id (fee_source uber).
--   pos_deliveries            ONE row per provider booking attempt of a POS order + the per-delivery LEDGER from day
--                             one (provider_fee_cents, customer_fee_cents, restaurant_absorbs_cents, driver_tip_cents,
--                             cancellation_fee_cents, billing_mode, provider_environment). State booking → booked →
--                             delivered | canceled, or failed. At most ONE active (booking / booked / delivered) per
--                             order (unique index): never double-booked. Guard: never deleted; ids / money set once.
--   pos_delivery_actions      idempotency for dispatch / cancel by the device's action_id (same semantics as
--                             pos_online_actions 111/113/114): pending → completed once; errors stored; a pending row
--                             that provably did nothing may be released (deleted) — nothing else.
--
-- Functions (SECURITY INVOKER, service_role only): pos_delivery_action_begin / _finish / _release.
-- The quote / delivery rows are written by the TS handlers through PostgREST under the guards below.
--
-- Access (the 108 pattern): every new table `revoke all … from service_role`, then exactly:
--   pos_delivery_quotes, pos_delivery_provider_quotes  select insert           (immutable)
--   pos_deliveries                                      select insert update    (no delete; guard)
--   pos_delivery_actions                                select insert update delete (delete: pending only; guard)
-- pos_restaurant_settings grants unchanged (select insert update), re-asserted.
--
-- NOT APPLIED. Needs 104 (pos_orders) + 109–114. Rollback: docs/migrations/115_rollback.sql.
-- Smoke: docs/migrations/115_smoke.sql. Verify: docs/migrations/115_verify.sql.

begin;

do $$
begin
  if to_regclass('public.pos_orders') is null or to_regclass('public.pos_restaurant_settings') is null
     or to_regprocedure('public.pos_online_action_release(uuid, uuid)') is null then
    raise exception '115: needs 104 (pos_orders) and 109–114' using errcode = '55000';
  end if;
end;
$$;

alter table public.pos_restaurant_settings
  add column pos_delivery_dispatch_enabled boolean not null default false;  -- provider dispatch (quotes work when off)

-- ---------------------------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------------------------

create table public.pos_delivery_quotes (
  id                 text primary key check (id ~ '^dq_[0-9a-f]{32}$'),
  restaurant_id      uuid not null references public.restaurants(id),
  device_id          uuid not null references public.pos_devices(id),
  address            jsonb not null check (jsonb_typeof(address) = 'object'),   -- as sent
  normalized_address text not null check (length(normalized_address) between 1 and 500),
  lat                numeric(9, 6) not null check (lat between -90 and 90),
  lng                numeric(9, 6) not null check (lng between -180 and 180),
  distance_miles     numeric(8, 2) not null check (distance_miles >= 0),
  in_radius          boolean not null,
  tier               smallint check (tier in (1, 2)),
  fee_cents          int check (fee_cents >= 0),
  needs_confirmation boolean not null,
  menu_snapshot_hash text not null check (length(menu_snapshot_hash) between 1 and 200),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  check (in_radius = (fee_cents is not null)),
  check ((tier is null) = (fee_cents is null)),
  check (expires_at > created_at)
);
create index pos_delivery_quotes_restaurant on public.pos_delivery_quotes (restaurant_id, created_at);

create table public.pos_delivery_provider_quotes (
  id                       text primary key check (id ~ '^pq_[0-9a-f]{32}$'),
  provider                 text not null check (provider in ('uber_direct')),
  provider_quote_id        text not null check (length(provider_quote_id) between 1 and 200),
  restaurant_id            uuid not null references public.restaurants(id),
  device_id                uuid not null references public.pos_devices(id),
  delivery_quote_id        text not null references public.pos_delivery_quotes(id),
  provider_fee_cents       int not null check (provider_fee_cents >= 0),
  customer_fee_cents       int not null check (customer_fee_cents >= 0),
  restaurant_absorbs_cents int not null check (restaurant_absorbs_cents >= 0),
  passthrough_mode         text not null check (length(passthrough_mode) between 1 and 40),
  passthrough_value        numeric not null,
  billing_mode             text not null check (billing_mode in ('self', 'platform')),
  provider_environment     text not null check (provider_environment in ('sandbox', 'production')),
  pickup_ready_dt          timestamptz,
  dropoff_eta              timestamptz,
  expires_at               timestamptz not null,
  created_at               timestamptz not null default now(),
  check (customer_fee_cents + restaurant_absorbs_cents = provider_fee_cents),
  unique (provider, provider_quote_id)
);
create index pos_delivery_provider_quotes_restaurant on public.pos_delivery_provider_quotes (restaurant_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- deliveries (+ the ledger)
-- ---------------------------------------------------------------------------------------------

create table public.pos_deliveries (
  id                       uuid primary key default gen_random_uuid(),
  pos_order_id             uuid not null references public.pos_orders(order_id),
  restaurant_id            uuid not null references public.restaurants(id),
  provider                 text not null check (provider in ('uber_direct')),
  state                    text not null check (state in ('booking', 'booked', 'delivered', 'canceled', 'failed')),
  action_id                uuid not null unique,                      -- the dispatch action that made it
  provider_quote_ref       text references public.pos_delivery_provider_quotes(id),
  provider_quote_id        text check (length(provider_quote_id) between 1 and 200),
  provider_delivery_id     text check (length(provider_delivery_id) between 1 and 200),
  tracking_url             text check (length(tracking_url) <= 2000),
  provider_status          text check (length(provider_status) <= 60),
  status_updated_at        timestamptz,
  dispatched_at            timestamptz,
  pickup_ready_dt          timestamptz,
  courier                  jsonb check (courier is null or jsonb_typeof(courier) = 'object'),
  pickup_eta               timestamptz,
  dropoff_eta              timestamptz,
  -- the ledger (Matt: from day one — platform-billing recovery is decided later)
  provider_fee_cents       int check (provider_fee_cents >= 0),
  customer_fee_cents       int not null check (customer_fee_cents >= 0),
  restaurant_absorbs_cents int check (restaurant_absorbs_cents >= 0),
  driver_tip_cents         int not null default 0 check (driver_tip_cents >= 0),
  cancellation_fee_cents   int check (cancellation_fee_cents >= 0),
  billing_mode             text not null check (billing_mode in ('self', 'platform')),
  provider_environment     text not null check (provider_environment in ('sandbox', 'production')),
  failure_code             text check (failure_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  failure_message          text check (length(failure_message) <= 500),
  last_polled_at           timestamptz,
  delivered_at             timestamptz,
  canceled_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider, provider_delivery_id),
  check (state <> 'booked' or provider_delivery_id is not null),
  check ((state = 'failed') = (failure_code is not null))
);
-- never double-booked: one live booking per POS order
create unique index pos_deliveries_one_active on public.pos_deliveries (pos_order_id) where state in ('booking', 'booked', 'delivered');
create index pos_deliveries_restaurant on public.pos_deliveries (restaurant_id, created_at);

create or replace function public.pos_deliveries_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pos_deliveries: never deleted (the ledger)' using errcode = '42501';
  end if;
  if new.id <> old.id or new.pos_order_id <> old.pos_order_id or new.restaurant_id <> old.restaurant_id
     or new.provider <> old.provider or new.action_id <> old.action_id or new.created_at <> old.created_at
     or new.customer_fee_cents <> old.customer_fee_cents or new.driver_tip_cents <> old.driver_tip_cents
     or new.billing_mode <> old.billing_mode or new.provider_environment <> old.provider_environment then
    raise exception 'pos_deliveries: identity / ledger columns are immutable' using errcode = '42501';
  end if;
  -- set once
  if (old.provider_delivery_id is not null and new.provider_delivery_id is distinct from old.provider_delivery_id)
     or (old.provider_fee_cents is not null and new.provider_fee_cents is distinct from old.provider_fee_cents)
     or (old.restaurant_absorbs_cents is not null and new.restaurant_absorbs_cents is distinct from old.restaurant_absorbs_cents)
     or (old.cancellation_fee_cents is not null and new.cancellation_fee_cents is distinct from old.cancellation_fee_cents)
     or (old.provider_quote_id is not null and new.provider_quote_id is distinct from old.provider_quote_id) then
    raise exception 'pos_deliveries: a provider id / ledger amount is set once' using errcode = '42501';
  end if;
  -- state machine
  if new.state is distinct from old.state and not (
       (old.state = 'booking' and new.state in ('booked', 'failed'))
    or (old.state = 'booked' and new.state in ('delivered', 'canceled'))) then
    raise exception 'pos_deliveries: % → % is not allowed', old.state, new.state using errcode = '42501';
  end if;
  if old.state in ('failed', 'canceled') and new.state = old.state
     and (to_jsonb(new) - 'updated_at' - 'last_polled_at') is distinct from (to_jsonb(old) - 'updated_at' - 'last_polled_at') then
    raise exception 'pos_deliveries: a % delivery is final', old.state using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger trg_pos_deliveries_guard before update or delete on public.pos_deliveries
  for each row execute function public.pos_deliveries_guard();

-- ---------------------------------------------------------------------------------------------
-- actions (idempotency for dispatch / cancel)
-- ---------------------------------------------------------------------------------------------

create table public.pos_delivery_actions (
  action_id         uuid primary key,
  restaurant_id     uuid not null references public.restaurants(id),
  device_id         uuid not null references public.pos_devices(id),
  pos_order_id      uuid not null,                                   -- as sent (checked by the handler)
  action            text not null check (action in ('dispatch', 'cancel')),
  request           jsonb not null check (jsonb_typeof(request) = 'object'),
  request_hash      text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  outcome           text check (outcome in ('applied', 'noop', 'error')),
  error_status      int check (error_status between 400 and 599),
  error_code        text check (error_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  error_message     text check (length(error_message) <= 500),
  actor_staff_id    text check (actor_staff_id is null or actor_staff_id = 'register'
                                or actor_staff_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  approver_staff_id uuid,
  device_time       timestamptz,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  check ((outcome is null) = (completed_at is null)),
  check ((outcome is not distinct from 'error') = (error_status is not null) and (error_status is null) = (error_code is null))
);
create index pos_delivery_actions_order on public.pos_delivery_actions (pos_order_id, created_at);

create or replace function public.pos_delivery_actions_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.outcome is not null then
      raise exception 'pos_delivery_actions: only a pending action may be released' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.outcome is not null
     or (to_jsonb(new) - 'outcome' - 'completed_at' - 'error_status' - 'error_code' - 'error_message')
        is distinct from (to_jsonb(old) - 'outcome' - 'completed_at' - 'error_status' - 'error_code' - 'error_message') then
    raise exception 'pos_delivery_actions: only a pending action may be completed, once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_delivery_actions_guard before update or delete on public.pos_delivery_actions
  for each row execute function public.pos_delivery_actions_guard();

-- begin → started | pending {since} | duplicate {stored, error_*} | action_id_reused.
create or replace function public.pos_delivery_action_begin(
  p_action_id uuid, p_restaurant_id uuid, p_device_id uuid, p_order_id uuid, p_action text, p_request jsonb,
  p_actor text, p_approver uuid, p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a      public.pos_delivery_actions;
  v_hash text;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_delivery_action_begin: request must be an object' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  insert into public.pos_delivery_actions (action_id, restaurant_id, device_id, pos_order_id, action, request, request_hash,
                                           actor_staff_id, approver_staff_id, device_time)
  values (p_action_id, p_restaurant_id, p_device_id, p_order_id, p_action, p_request, v_hash, p_actor, p_approver, p_device_time)
  on conflict (action_id) do nothing
  returning * into a;
  if found then
    return jsonb_build_object('outcome', 'started');
  end if;
  select * into a from public.pos_delivery_actions where action_id = p_action_id;
  if a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id or a.pos_order_id <> p_order_id
     or a.action <> p_action or a.request_hash <> v_hash then
    return jsonb_build_object('outcome', 'action_id_reused');
  end if;
  if a.outcome is null then
    return jsonb_build_object('outcome', 'pending', 'since', a.created_at);
  end if;
  return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome, 'error_status', a.error_status,
                            'error_code', a.error_code, 'error_message', a.error_message);
end;
$$;

-- finish → completed | not_found | device_mismatch | already_completed {stored}.
create or replace function public.pos_delivery_action_finish(
  p_action_id uuid, p_device_id uuid, p_outcome text, p_error_status int, p_error_code text, p_error_message text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_delivery_actions;
begin
  if p_outcome is null or p_outcome not in ('applied', 'noop', 'error')
     or (p_outcome = 'error') <> (p_error_status is not null and p_error_code is not null) then
    raise exception 'pos_delivery_action_finish: outcome applied | noop | error (+ status and code)' using errcode = '22023';
  end if;
  select * into a from public.pos_delivery_actions where action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if a.device_id <> p_device_id then
    return jsonb_build_object('outcome', 'device_mismatch');
  end if;
  if a.outcome is not null then
    return jsonb_build_object('outcome', 'already_completed', 'stored', a.outcome);
  end if;
  update public.pos_delivery_actions
     set outcome = p_outcome, completed_at = now(),
         error_status = case when p_outcome = 'error' then p_error_status end,
         error_code = case when p_outcome = 'error' then p_error_code end,
         error_message = case when p_outcome = 'error' then left(p_error_message, 500) end
   where action_id = p_action_id;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

-- release → released | not_found | device_mismatch | not_pending (a provider rate_limited answer: nothing happened).
create or replace function public.pos_delivery_action_release(p_action_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_delivery_actions;
begin
  select * into a from public.pos_delivery_actions where action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if a.device_id <> p_device_id then
    return jsonb_build_object('outcome', 'device_mismatch');
  end if;
  if a.outcome is not null then
    return jsonb_build_object('outcome', 'not_pending');
  end if;
  delete from public.pos_delivery_actions where action_id = p_action_id;
  return jsonb_build_object('outcome', 'released');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- access (108 pattern)
-- ---------------------------------------------------------------------------------------------

alter table public.pos_delivery_quotes          enable row level security;
alter table public.pos_delivery_provider_quotes enable row level security;
alter table public.pos_deliveries               enable row level security;
alter table public.pos_delivery_actions         enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_delivery_quotes, public.pos_delivery_provider_quotes, public.pos_deliveries,
                    public.pos_delivery_actions, public.pos_restaurant_settings
  from public, anon, authenticated, service_role;
grant select, insert                 on table public.pos_delivery_quotes          to service_role;  -- immutable
grant select, insert                 on table public.pos_delivery_provider_quotes to service_role;  -- immutable
grant select, insert, update         on table public.pos_deliveries               to service_role;  -- no delete (guard)
grant select, insert, update, delete on table public.pos_delivery_actions         to service_role;  -- delete: pending only (guard)
grant select, insert, update         on table public.pos_restaurant_settings      to service_role;  -- unchanged (109)

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_delivery_action_begin(uuid, uuid, uuid, uuid, text, jsonb, text, uuid, timestamptz)',
    'public.pos_delivery_action_finish(uuid, uuid, text, int, text, text)',
    'public.pos_delivery_action_release(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.pos_deliveries_guard()       from public, anon, authenticated;
revoke all on function public.pos_delivery_actions_guard() from public, anon, authenticated;

comment on table public.pos_delivery_quotes is 'POS in-house delivery quotes (server geocode + haversine + pinned-snapshot tier fee), 24 h. submit-order reads by id.';
comment on table public.pos_delivery_provider_quotes is 'POS provider delivery quotes (Uber Direct now), split by the restaurant''s passthrough. submit-order reads by id (fee_source uber).';
comment on table public.pos_deliveries is 'POS provider deliveries (one live booking per POS order) + the per-delivery ledger. Never deleted.';
comment on table public.pos_delivery_actions is 'POS delivery dispatch / cancel idempotency by device action_id. Pending → completed once; errors stored.';

commit;
