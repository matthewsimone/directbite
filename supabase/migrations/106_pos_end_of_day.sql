-- 106_pos_end_of_day.sql — Ordr POS end of day (DIRECTBITE-HANDOFF item 7 incl. FINAL CP3;
-- ordr-pos END-OF-DAY.md §7; SYNC-CONTRACT §3a).
--
--   pos_shifts             one row per shift = its latest version (versions apply in order; a CLOSED
--                          shift is immutable except its server flags — re-verification); payload as sent
--   pos_cash_movements     paid-ins / paid-outs, INSERT-ONLY by id
--   pos_refunds            refunds after Close: immutable (v1), linked to the order + payment
--   pos_day_closes         Z / supplemental Z: (device, business_date, sequence) unique,
--                          supplemental = (sequence > 1), covered id lists, carried-over ids, report as sent
--   pos_entity_submissions idempotency (entity_type, entity_id, version) → content_hash + ORIGINAL response
--   view pos_post_z        the CURRENT post-Z rows (orders / refunds / closed shifts): a later supplemental
--                          Z that covers a row clears it here (stored response flags are as answered)
--
-- Each apply is ONE call (pos_apply_shift / pos_apply_refund / pos_apply_day_close): lock, idempotency,
-- the entity rules again, writes, the idempotency row — one transaction (as 104). Callers:
-- _shared/pos-eod/store.ts PgEodStore; MemoryEodStore mirrors them for tests.
--
-- Access: RLS on, no policies, revoked from anon / authenticated → service role only (as 101 / 104 / 105).
--
-- NOT APPLIED. Needs 101 (pos_devices) + 104 (pos_orders, pos_payments; pos_orders.sales_day).
-- Rollback: docs/migrations/106_rollback.sql. Smoke: 106_smoke.sql. Verify: 106_verify.sql.

begin;

create table public.pos_shifts (
  shift_id             uuid primary key,
  restaurant_id        uuid not null references public.restaurants(id),
  device_id            uuid not null references public.pos_devices(id),
  version              int not null check (version >= 1),
  business_date        date not null,
  status               text not null check (status in ('open', 'closed')),
  opened_at            timestamptz not null,
  opened_by            text not null,
  starting_cash_cents  bigint not null check (starting_cash_cents >= 0),
  closed_at            timestamptz,
  closed_by            text,
  close_approved_by    text,
  counted_cash_cents   bigint,
  expected_cash_cents  bigint,
  over_short_cents     bigint,
  attribution          jsonb,                         -- closing version: the cash payment / void / refund ids + amounts
  device_time          timestamptz not null,
  payload              jsonb not null,                -- latest version as sent (re-verification reads it)
  flags                jsonb not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index pos_shifts_restaurant_day on public.pos_shifts (restaurant_id, business_date);
create index pos_shifts_unverified on public.pos_shifts (restaurant_id) where status = 'closed' and (flags->>'drawer_unverified') = 'true';

create table public.pos_cash_movements (
  id            uuid primary key,
  shift_id      uuid not null references public.pos_shifts(shift_id),
  restaurant_id uuid not null references public.restaurants(id),
  kind          text not null check (kind in ('paid_in', 'paid_out')),
  amount_cents  bigint not null check (amount_cents > 0),
  reason        text not null check (char_length(reason) <= 200),
  actor         text not null,
  approved_by   text,
  created_at    timestamptz not null,
  inserted_at   timestamptz not null default now()
);
create index pos_cash_movements_shift on public.pos_cash_movements (shift_id);

create table public.pos_refunds (
  refund_id     uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  device_id     uuid not null references public.pos_devices(id),
  order_id      uuid not null references public.pos_orders(order_id),
  payment_id    uuid not null references public.pos_payments(id),
  method        text not null check (method in ('cash', 'external_card')),
  amount_cents  bigint not null check (amount_cents > 0),
  reason        text not null check (char_length(reason) <= 200),
  actor         text not null,
  approved_by   text,
  business_date date not null,
  shift_id      uuid,                                 -- no FK: the shift may arrive later
  created_at    timestamptz not null,
  device_time   timestamptz not null,
  flags         jsonb not null,
  received_at   timestamptz not null default now()
);
create index pos_refunds_payment on public.pos_refunds (payment_id);
create index pos_refunds_restaurant_day on public.pos_refunds (restaurant_id, business_date);

create table public.pos_day_closes (
  day_close_id            uuid primary key,
  restaurant_id           uuid not null references public.restaurants(id),
  device_id               uuid not null references public.pos_devices(id),
  business_date           date not null,
  z_number                int not null check (z_number >= 1),
  sequence                int not null check (sequence >= 1),
  supplemental            boolean not null,
  closed_at               timestamptz not null,
  closed_by               text not null,
  approved_by             text,
  report                  jsonb not null,             -- DayReport totals, cents, as sent
  covered                 jsonb not null,             -- { order_ids, voided_order_ids, payment_ids, payment_void_ids, refund_ids, shift_ids }
  carried_over_order_ids  jsonb not null,
  device_time             timestamptz not null,
  flags                   jsonb not null,
  received_at             timestamptz not null default now(),
  unique (device_id, business_date, sequence),
  constraint pos_day_closes_supplemental check (supplemental = (sequence > 1))
);
create index pos_day_closes_restaurant_day on public.pos_day_closes (restaurant_id, business_date);

create table public.pos_entity_submissions (
  entity_type   text not null check (entity_type in ('shift', 'refund', 'day_close')),
  entity_id     uuid not null,
  version       int not null,
  content_hash  text not null,
  device_id     uuid not null references public.pos_devices(id),
  payload       jsonb not null,
  response      jsonb not null,                       -- the ORIGINAL response (duplicate)
  received_at   timestamptz not null default now(),
  primary key (entity_type, entity_id, version)
);

-- ---------------------------------------------------------------------------------------------
-- A closed shift is immutable; only its server flags (re-verification) may change.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_shifts_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status = 'closed' and (to_jsonb(new) - 'flags' - 'updated_at') is distinct from (to_jsonb(old) - 'flags' - 'updated_at') then
    raise exception 'pos_shifts: a closed shift is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_shifts_guard before update on public.pos_shifts for each row execute function public.pos_shifts_guard();

-- ---------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------

-- §3a idempotency: null = key unseen; else { outcome: duplicate, response } | { outcome: idempotency_key_reuse }.
create or replace function public.pos_entity_idem(p_type text, p_id uuid, p_version int, p_hash text)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select case when s.content_hash = p_hash then jsonb_build_object('outcome', 'duplicate', 'response', s.response)
              else jsonb_build_object('outcome', 'idempotency_key_reuse') end
    from public.pos_entity_submissions s
   where s.entity_type = p_type and s.entity_id = p_id and s.version = p_version;
$$;

create or replace function public.pos_entity_store(p_type text, p_id uuid, p_version int, p_payload jsonb, p_device_id uuid, p_response jsonb, p_received_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.pos_entity_submissions (entity_type, entity_id, version, content_hash, device_id, payload, response, received_at)
  values (p_type, p_id, p_version, p_payload->>'content_hash', p_device_id, p_payload, p_response, p_received_at);
  return jsonb_build_object('outcome', 'applied', 'response', p_response);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_apply_shift (fakeServer applyShift :619-649)
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_apply_shift(p_payload jsonb, p_device_id uuid, p_restaurant_id uuid, p_response jsonb, p_received_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id      uuid := (p_payload->>'shift_id')::uuid;
  v_version int  := (p_payload->>'version')::int;
  v_cur     public.pos_shifts%rowtype;
  v_exists  boolean;
  v_r       jsonb;
  v_bad     text;
begin
  perform pg_advisory_xact_lock(hashtextextended('pos_shift:' || v_id::text, 0));
  v_r := public.pos_entity_idem('shift', v_id, v_version, p_payload->>'content_hash');
  if v_r is not null then return v_r; end if;
  select * into v_cur from public.pos_shifts where shift_id = v_id for update;
  v_exists := found;
  if v_exists and v_cur.restaurant_id <> p_restaurant_id then return jsonb_build_object('outcome', 'restaurant_mismatch'); end if;
  if v_exists and v_version <= v_cur.version then
    return jsonb_build_object('outcome', 'stale_ignored', 'server_version', v_cur.version, 'flags', v_cur.flags);
  end if;
  if v_exists and v_cur.status = 'closed' then return jsonb_build_object('outcome', 'shift_closed'); end if;
  -- movements insert-only: a known id must be this shift's, same amount + kind
  select m.id::text into v_bad
    from jsonb_array_elements(p_payload->'movements') x
    join public.pos_cash_movements m on m.id = (x->>'id')::uuid
   where m.shift_id <> v_id or m.amount_cents <> (x->>'amount_cents')::bigint or m.kind <> x->>'kind'
   limit 1;
  if v_bad is not null then
    return jsonb_build_object('outcome', 'invalid_payload', 'message', 'movement ' || v_bad || ' changed', 'field', 'movements');
  end if;

  insert into public.pos_shifts as s (
    shift_id, restaurant_id, device_id, version, business_date, status, opened_at, opened_by, starting_cash_cents,
    closed_at, closed_by, close_approved_by, counted_cash_cents, expected_cash_cents, over_short_cents, attribution,
    device_time, payload, flags, created_at, updated_at)
  values (
    v_id, p_restaurant_id, p_device_id, v_version, (p_payload->>'business_date')::date, p_payload->>'status',
    (p_payload->>'opened_at')::timestamptz, p_payload->>'opened_by', (p_payload->>'starting_cash_cents')::bigint,
    (p_payload->>'closed_at')::timestamptz, p_payload->>'closed_by', p_payload->>'close_approved_by',
    (p_payload->>'counted_cash_cents')::bigint, (p_payload->>'expected_cash_cents')::bigint, (p_payload->>'over_short_cents')::bigint,
    nullif(p_payload->'attribution', 'null'::jsonb), (p_payload->>'device_time')::timestamptz, p_payload, p_response->'flags',
    p_received_at, p_received_at)
  on conflict (shift_id) do update set
    device_id = excluded.device_id, version = excluded.version, business_date = excluded.business_date, status = excluded.status,
    opened_at = excluded.opened_at, opened_by = excluded.opened_by, starting_cash_cents = excluded.starting_cash_cents,
    closed_at = excluded.closed_at, closed_by = excluded.closed_by, close_approved_by = excluded.close_approved_by,
    counted_cash_cents = excluded.counted_cash_cents, expected_cash_cents = excluded.expected_cash_cents,
    over_short_cents = excluded.over_short_cents, attribution = excluded.attribution, device_time = excluded.device_time,
    payload = excluded.payload, flags = excluded.flags, updated_at = excluded.updated_at;

  insert into public.pos_cash_movements (id, shift_id, restaurant_id, kind, amount_cents, reason, actor, approved_by, created_at, inserted_at)
  select (x->>'id')::uuid, v_id, p_restaurant_id, x->>'kind', (x->>'amount_cents')::bigint, x->>'reason', x->>'actor',
         x->>'approved_by', (x->>'created_at')::timestamptz, p_received_at
    from jsonb_array_elements(p_payload->'movements') x
  on conflict (id) do nothing;

  return public.pos_entity_store('shift', v_id, v_version, p_payload, p_device_id, p_response, p_received_at);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_apply_refund (fakeServer applyRefund :685-704)
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_apply_refund(p_payload jsonb, p_device_id uuid, p_restaurant_id uuid, p_response jsonb, p_received_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id  uuid := (p_payload->>'refund_id')::uuid;
  v_pay public.pos_payments%rowtype;
  v_r   jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('pos_refund:' || v_id::text, 0));
  v_r := public.pos_entity_idem('refund', v_id, 1, p_payload->>'content_hash');
  if v_r is not null then return v_r; end if;
  if exists (select 1 from public.pos_refunds where refund_id = v_id) then return jsonb_build_object('outcome', 'idempotency_key_reuse'); end if;
  select * into v_pay from public.pos_payments
   where id = (p_payload->>'payment_id')::uuid and order_id = (p_payload->>'order_id')::uuid and restaurant_id = p_restaurant_id;
  if not found then return jsonb_build_object('outcome', 'unknown_payment'); end if;      -- retryable (race guard)
  if v_pay.method <> p_payload->>'method' then
    return jsonb_build_object('outcome', 'invalid_payload', 'message', 'refund method must equal the payment method', 'field', 'method');
  end if;
  if (p_payload->>'amount_cents')::bigint <= 0 then
    return jsonb_build_object('outcome', 'invalid_payload', 'message', 'amount must be > 0', 'field', 'amount_cents');
  end if;
  insert into public.pos_refunds (refund_id, restaurant_id, device_id, order_id, payment_id, method, amount_cents, reason, actor,
                                  approved_by, business_date, shift_id, created_at, device_time, flags, received_at)
  values (v_id, p_restaurant_id, p_device_id, v_pay.order_id, v_pay.id, p_payload->>'method', (p_payload->>'amount_cents')::bigint,
          p_payload->>'reason', p_payload->>'actor', p_payload->>'approved_by', (p_payload->>'business_date')::date,
          (p_payload->>'shift_id')::uuid, (p_payload->>'created_at')::timestamptz, (p_payload->>'device_time')::timestamptz,
          p_response->'flags', p_received_at);
  return public.pos_entity_store('refund', v_id, 1, p_payload, p_device_id, p_response, p_received_at);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_apply_day_close (fakeServer applyDayClose :706-721)
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_apply_day_close(p_payload jsonb, p_device_id uuid, p_restaurant_id uuid, p_response jsonb, p_received_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id   uuid := (p_payload->>'day_close_id')::uuid;
  v_day  date := (p_payload->>'business_date')::date;
  v_seq  int  := (p_payload->>'sequence')::int;
  v_r    jsonb;
begin
  -- one register + business day at a time (sequence uniqueness)
  perform pg_advisory_xact_lock(hashtextextended('pos_z:' || p_device_id::text || ':' || v_day::text, 0));
  v_r := public.pos_entity_idem('day_close', v_id, 1, p_payload->>'content_hash');
  if v_r is not null then return v_r; end if;
  if exists (select 1 from public.pos_day_closes where day_close_id = v_id) then return jsonb_build_object('outcome', 'idempotency_key_reuse'); end if;
  if exists (select 1 from public.pos_day_closes where device_id = p_device_id and business_date = v_day and sequence = v_seq) then
    return jsonb_build_object('outcome', 'day_close_sequence_taken');
  end if;
  if (p_payload->>'supplemental')::boolean is distinct from (v_seq > 1) then
    return jsonb_build_object('outcome', 'invalid_payload', 'message', 'supplemental must equal sequence > 1', 'field', 'supplemental');
  end if;
  insert into public.pos_day_closes (day_close_id, restaurant_id, device_id, business_date, z_number, sequence, supplemental,
                                     closed_at, closed_by, approved_by, report, covered, carried_over_order_ids, device_time, flags, received_at)
  values (v_id, p_restaurant_id, p_device_id, v_day, (p_payload->>'z_number')::int, v_seq, (p_payload->>'supplemental')::boolean,
          (p_payload->>'closed_at')::timestamptz, p_payload->>'closed_by', p_payload->>'approved_by', p_payload->'report',
          p_payload->'covered', p_payload->'carried_over_order_ids', (p_payload->>'device_time')::timestamptz,
          p_response->'flags', p_received_at);
  return public.pos_entity_store('day_close', v_id, 1, p_payload, p_device_id, p_response, p_received_at);
end;
$$;

-- Re-verification of a closed shift's drawer (only the two drawer flags change).
create or replace function public.pos_set_shift_drawer_flags(p_shift_id uuid, p_drawer_mismatch boolean, p_drawer_unverified boolean)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.pos_shifts
     set flags = flags || jsonb_build_object('drawer_mismatch', p_drawer_mismatch, 'drawer_unverified', p_drawer_unverified),
         updated_at = now()
   where shift_id = p_shift_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- The current post-Z rows (fakeServer postZ :753-759): dated a day that already has a Z from the
-- register, and no Z of that day covers them. Orders by their sales day + writer register.
-- ---------------------------------------------------------------------------------------------
create view public.pos_post_z with (security_invoker = true) as
  select 'order'::text as entity_type, o.order_id as entity_id, o.restaurant_id, o.writer_device_id as device_id, o.sales_day as business_date
    from public.pos_orders o
   where o.sales_day is not null
     and exists (select 1 from public.pos_day_closes z where z.device_id = o.writer_device_id and z.business_date = o.sales_day)
     and not exists (select 1 from public.pos_day_closes z where z.device_id = o.writer_device_id and z.business_date = o.sales_day
                       and ((z.covered->'order_ids') ? o.order_id::text or (z.covered->'voided_order_ids') ? o.order_id::text))
  union all
  select 'refund', r.refund_id, r.restaurant_id, r.device_id, r.business_date
    from public.pos_refunds r
   where exists (select 1 from public.pos_day_closes z where z.device_id = r.device_id and z.business_date = r.business_date)
     and not exists (select 1 from public.pos_day_closes z where z.device_id = r.device_id and z.business_date = r.business_date
                       and (z.covered->'refund_ids') ? r.refund_id::text)
  union all
  select 'shift', s.shift_id, s.restaurant_id, s.device_id, s.business_date
    from public.pos_shifts s
   where s.status = 'closed'
     and exists (select 1 from public.pos_day_closes z where z.device_id = s.device_id and z.business_date = s.business_date)
     and not exists (select 1 from public.pos_day_closes z where z.device_id = s.device_id and z.business_date = s.business_date
                       and (z.covered->'shift_ids') ? s.shift_id::text);

-- ---------------------------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------------------------
alter table public.pos_shifts             enable row level security;
alter table public.pos_cash_movements     enable row level security;
alter table public.pos_refunds            enable row level security;
alter table public.pos_day_closes         enable row level security;
alter table public.pos_entity_submissions enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_shifts, public.pos_cash_movements, public.pos_refunds, public.pos_day_closes,
                    public.pos_entity_submissions, public.pos_post_z
  from public, anon, authenticated;

grant select, insert, update on table public.pos_shifts             to service_role;  -- closed = immutable (trigger) except flags
grant select, insert         on table public.pos_cash_movements     to service_role;  -- insert-only
grant select, insert         on table public.pos_refunds            to service_role;  -- immutable
grant select, insert         on table public.pos_day_closes         to service_role;  -- immutable
grant select, insert         on table public.pos_entity_submissions to service_role;  -- immutable
grant select                 on table public.pos_post_z             to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_entity_idem(text, uuid, int, text)',
    'public.pos_entity_store(text, uuid, int, jsonb, uuid, jsonb, timestamptz)',
    'public.pos_apply_shift(jsonb, uuid, uuid, jsonb, timestamptz)',
    'public.pos_apply_refund(jsonb, uuid, uuid, jsonb, timestamptz)',
    'public.pos_apply_day_close(jsonb, uuid, uuid, jsonb, timestamptz)',
    'public.pos_set_shift_drawer_flags(uuid, boolean, boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.pos_shifts_guard() from public, anon, authenticated;

comment on table public.pos_shifts is 'POS shifts (END-OF-DAY §7), latest version; closed = immutable except server flags.';
comment on table public.pos_refunds is 'POS refunds after Close (immutable v1), linked to the order + payment.';
comment on table public.pos_day_closes is 'POS Z / supplemental Z per register + business day; report stored as sent.';
comment on view public.pos_post_z is 'Current post-Z orders / refunds / closed shifts (a later covering Z clears them).';

commit;
