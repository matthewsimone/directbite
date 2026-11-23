-- 104_pos_orders.sql — POS orders (ordr-pos SYNC-CONTRACT §3; DIRECTBITE-HANDOFF items 2, 3, 6).
--
-- Decision (Matt, CP10): POS orders live in NEW pos_* tables, never in the web's orders table.
--
--   pos_orders               one row per order = its LATEST applied version (header, server pricing of
--                            record, flags, the request's provisional pricing / config for reporting)
--   pos_order_lines          lines of the latest version (upsert by id; lines dropped from the
--                            aggregate are deleted — the device voids rather than drops)
--   pos_order_line_modifiers modifiers of those lines (same rule)
--   pos_payments             INSERT-ONLY by id: method / amounts / last4 / external_ref immutable;
--                            status captured → voided only (trigger pos_payments_guard)
--   pos_order_submissions    idempotency (§3.1): (order_id, version) → content_hash + the ORIGINAL
--                            response + the request as received (audit of every version)
--
-- Callers: supabase/functions/_shared/pos-sync/orderStore.ts (PgOrderStore). The whole submission is
-- ONE call to pos_apply_order_submission (supabase-js has no transactions): per-order advisory lock,
-- identity re-check, §3.1 idempotency + versions, payment rules, aggregate upsert, idempotency row.
--
-- Access: RLS on, no policies, revoked from anon / authenticated → service role only (as 101 / 103).
-- Order numbers: sequence pos_order_number_seq, starting at 5000001 (disjoint from the web's
-- order_number_seq, which starts at 1000001 — see CP10 open questions).
-- Actor / approver fields (item 8) are stored as columns now; their flags come with item 8.
-- Card data: the function refuses card-number-like text before anything reaches these tables.
--
-- NOT APPLIED. Needs 101 (pos_devices) and 103 (pos_menu_snapshots).
-- Rollback: docs/migrations/104_rollback.sql. Smoke: 104_smoke.sql. Verify: 104_verify.sql.

begin;

create sequence public.pos_order_number_seq start with 5000001;

create table public.pos_orders (
  order_id              uuid primary key,
  restaurant_id         uuid not null references public.restaurants(id),
  version               int not null check (version >= 1),
  writer_device_id      uuid not null references public.pos_devices(id),   -- §3.1 writer = the principal
  order_number          bigint not null unique,
  ticket_prefix         text not null,                                     -- fixed at creation (§1a)
  ticket_business_date  date not null,
  ticket_counter        int not null,
  order_type            text not null check (order_type in ('pickup', 'delivery', 'dine_in')),
  channel               text not null check (channel in ('counter', 'phone', 'dine_in')),
  status                text not null check (status in ('open', 'closed', 'voided')),
  customer_name         text,
  customer_phone_e164   text,
  note                  text check (note is null or char_length(note) <= 500),
  ready_at              timestamptz,
  void_reason           text,
  created_by            text,                                              -- staff id or 'register' (item 8)
  closed_by             text,
  voided_by             text,
  void_approved_by      text,
  table_label           text,
  table_guest_count     int,
  delivery              jsonb,                                             -- stored as sent (item 5 later)
  tip                   jsonb not null,
  menu_snapshot_hash    text not null,                                     -- as pinned by the device (may be unknown)
  priced_against_hash   text not null references public.pos_menu_snapshots(hash),
  device_time           timestamptz not null,
  pricing               jsonb not null,                                    -- server breakdown = total of record
  total_cents           bigint not null,                                   -- = pricing.total_cents (reports)
  provisional_pricing   jsonb not null,                                    -- the device's, for comparison
  pricing_config        jsonb not null,                                    -- the device's claim, reporting only
  flags                 jsonb not null,                                    -- mismatch / stale_price / unknown_snapshot / availability_flag / delivery
  sales_day             date,                                              -- item 7: business day of the version that first closed / voided it (sticky)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index pos_orders_restaurant_created on public.pos_orders (restaurant_id, created_at desc);
create index pos_orders_restaurant_day on public.pos_orders (restaurant_id, ticket_business_date);

create table public.pos_order_lines (
  id                    uuid primary key,
  order_id              uuid not null references public.pos_orders(order_id),
  position              int not null,
  menu_item_id          text not null,                                     -- as sent (snapshot id; no FK: menus change)
  item_size_id          text,
  item_name             text not null,
  size_name             text,
  quantity              int not null,
  base_price_cents      bigint not null,                                   -- the device's; the server prices from the snapshot
  discount_exempt       boolean not null,
  status                text not null check (status in ('active', 'voided')),
  void_reason           text,
  voided_by             text,
  void_approved_by      text,
  seat                  int,
  course                int,
  check_no              int,
  fired_seq             int,
  special_instructions  text
);
create index pos_order_lines_order on public.pos_order_lines (order_id);

create table public.pos_order_line_modifiers (
  id                uuid primary key,
  line_id           uuid not null references public.pos_order_lines(id) on delete cascade,
  order_id          uuid not null references public.pos_orders(order_id),
  position          int not null,
  kind              text not null check (kind in ('pizza', 'addon')),
  topping_id        text not null,
  name              text not null,
  placement         text check (placement is null or placement in ('whole', 'left', 'right')),
  price_cents       bigint not null,
  price_half_cents  bigint,
  size_prices       jsonb,                                                 -- [{size_key, price_cents, half_cents}] | null (CP9b)
  charge_cents      bigint not null
);
create index pos_order_line_modifiers_order on public.pos_order_line_modifiers (order_id);
create index pos_order_line_modifiers_line on public.pos_order_line_modifiers (line_id);

create table public.pos_payments (
  id                uuid primary key,
  order_id          uuid not null references public.pos_orders(order_id),
  restaurant_id     uuid not null references public.restaurants(id),
  method            text not null check (method in ('cash', 'external_card')),
  amount_cents      bigint not null check (amount_cents >= 0),
  tendered_cents    bigint not null check (tendered_cents >= 0),
  change_cents      bigint not null check (change_cents >= 0),
  status            text not null check (status in ('captured', 'voided')),
  check_no          int,
  last4             text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  external_ref      text check (external_ref is null or char_length(external_ref) <= 40),
  taken_by          text,
  voided_by         text,
  void_approved_by  text,
  void_reason       text,
  inserted_at       timestamptz not null default now(),
  voided_at         timestamptz,
  constraint pos_payments_cash_no_card check (method <> 'cash' or (last4 is null and external_ref is null)),
  constraint pos_payments_card_no_change check (method <> 'external_card' or (tendered_cents = amount_cents and change_cents = 0))
);
create index pos_payments_order on public.pos_payments (order_id);
create index pos_payments_restaurant_inserted on public.pos_payments (restaurant_id, inserted_at desc);

create table public.pos_order_submissions (
  order_id      uuid not null references public.pos_orders(order_id),
  version       int not null,
  content_hash  text not null,
  device_id     uuid not null references public.pos_devices(id),
  payload       jsonb not null,                                            -- the request as received
  response      jsonb not null,                                            -- the ORIGINAL response (§3.1 duplicate)
  received_at   timestamptz not null default now(),
  primary key (order_id, version)
);

-- ---------------------------------------------------------------------------------------------
-- Payments are insert-only: an UPDATE may only void a captured payment (and record who / why / when).
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_payments_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.id is distinct from old.id or new.order_id is distinct from old.order_id
     or new.restaurant_id is distinct from old.restaurant_id or new.method is distinct from old.method
     or new.amount_cents is distinct from old.amount_cents or new.tendered_cents is distinct from old.tendered_cents
     or new.change_cents is distinct from old.change_cents or new.last4 is distinct from old.last4
     or new.external_ref is distinct from old.external_ref or new.taken_by is distinct from old.taken_by
     or new.check_no is distinct from old.check_no or new.inserted_at is distinct from old.inserted_at then
    raise exception 'pos_payments are insert-only (only captured → voided may change)' using errcode = '42501';
  end if;
  if not (old.status = 'captured' and new.status = 'voided') then
    raise exception 'pos_payments: only captured → voided' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_pos_payments_guard
  before update on public.pos_payments
  for each row execute function public.pos_payments_guard();

-- ---------------------------------------------------------------------------------------------
-- The whole submission, atomically (mirrors MemoryOrderStore.apply step by step).
-- p_payload  : the validated request (TS: identity, hash, redemption, card, shape checks done)
-- p_writer   : the principal's device id (never the body)
-- p_response : the applied response with order_number = 0 (filled in here)
-- Returns { outcome: applied | duplicate | idempotency_key_reuse | stale_ignored | version_conflict |
--           restaurant_mismatch | prefix_mismatch | invalid_payload, … }. Every non-applied outcome
-- returns BEFORE any write, so nothing is committed for it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.pos_apply_order_submission(
  p_payload       jsonb,
  p_writer        uuid,
  p_restaurant_id uuid,
  p_response      jsonb,
  p_received_at   timestamptz,
  p_sales_day     date default null          -- item 7: kept once set (the first closing / voiding version's day)
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order_id uuid := (p_payload->>'order_id')::uuid;
  v_version  int  := (p_payload->>'version')::int;
  v_base     int  := (p_payload->>'base_server_version')::int;
  v_hash     text := p_payload->>'content_hash';
  v_cur      public.pos_orders%rowtype;
  v_exists   boolean;
  v_prior    public.pos_order_submissions%rowtype;
  v_pay      jsonb;
  v_old      public.pos_payments%rowtype;
  v_number   bigint;
  v_resp     jsonb;
  v_bad      text;
begin
  perform pg_advisory_xact_lock(hashtextextended('pos_order:' || v_order_id::text, 0));

  select * into v_cur from public.pos_orders where order_id = v_order_id for update;
  v_exists := found;

  -- identity re-check (§1a; the handler checked before, this closes the race)
  if v_exists and v_cur.restaurant_id <> p_restaurant_id then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;
  if v_exists and v_cur.ticket_prefix is distinct from (p_payload #>> '{ticket,prefix}') then
    return jsonb_build_object('outcome', 'prefix_mismatch', 'expected', v_cur.ticket_prefix);
  end if;

  -- §3.1 idempotency key
  select * into v_prior from public.pos_order_submissions where order_id = v_order_id and version = v_version;
  if found then
    if v_prior.content_hash = v_hash then
      return jsonb_build_object('outcome', 'duplicate', 'response', v_prior.response);
    end if;
    return jsonb_build_object('outcome', 'idempotency_key_reuse');
  end if;

  -- §3.1 versions
  if v_exists then
    if v_version <= v_cur.version then
      if v_cur.writer_device_id = p_writer then
        return jsonb_build_object('outcome', 'stale_ignored', 'head', jsonb_build_object(
          'order_id', v_cur.order_id, 'restaurant_id', v_cur.restaurant_id, 'ticket_prefix', v_cur.ticket_prefix,
          'version', v_cur.version, 'writer_device_id', v_cur.writer_device_id, 'order_number', v_cur.order_number,
          'pricing', v_cur.pricing, 'provisional_pricing', v_cur.provisional_pricing,
          'priced_against_hash', v_cur.priced_against_hash, 'flags', v_cur.flags, 'sales_day', v_cur.sales_day));
      end if;
      return jsonb_build_object('outcome', 'version_conflict', 'server_version', v_cur.version, 'server_writer_device_id', v_cur.writer_device_id);
    end if;
    if v_cur.writer_device_id <> p_writer and v_base <> v_cur.version then
      return jsonb_build_object('outcome', 'version_conflict', 'server_version', v_cur.version, 'server_writer_device_id', v_cur.writer_device_id);
    end if;
  elsif v_base <> 0 then
    return jsonb_build_object('outcome', 'version_conflict', 'server_version', null, 'server_writer_device_id', null);
  end if;

  -- child ids must not belong to another order
  select l.id::text into v_bad
    from jsonb_array_elements(p_payload->'lines') x
    join public.pos_order_lines l on l.id = (x->>'id')::uuid
   where l.order_id <> v_order_id
   limit 1;
  if v_bad is not null then
    return jsonb_build_object('outcome', 'invalid_payload', 'message', 'line ' || v_bad || ' belongs to another order', 'field', 'lines');
  end if;
  select m.id::text into v_bad
    from jsonb_array_elements(p_payload->'lines') x
    cross join jsonb_array_elements(x->'modifiers') y
    join public.pos_order_line_modifiers m on m.id = (y->>'id')::uuid
   where m.order_id <> v_order_id
   limit 1;
  if v_bad is not null then
    return jsonb_build_object('outcome', 'invalid_payload', 'message', 'modifier ' || v_bad || ' belongs to another order', 'field', 'lines');
  end if;

  -- payments: validate ALL before writing anything
  for v_pay in select value from jsonb_array_elements(p_payload->'payments') loop
    select * into v_old from public.pos_payments where id = (v_pay->>'id')::uuid;
    if found then
      if v_old.order_id <> v_order_id
         or v_old.amount_cents <> (v_pay->>'amount_cents')::bigint
         or v_old.method <> (v_pay->>'method')
         or v_old.last4 is distinct from (v_pay->>'last4')
         or v_old.external_ref is distinct from (v_pay->>'external_ref') then
        return jsonb_build_object('outcome', 'invalid_payload', 'message', 'payment ' || (v_pay->>'id') || ' amount/order/method changed', 'field', 'payments');
      end if;
      if v_old.status <> (v_pay->>'status') and not (v_old.status = 'captured' and v_pay->>'status' = 'voided') then
        return jsonb_build_object('outcome', 'invalid_payload', 'message', 'payment ' || (v_pay->>'id') || ' cannot be un-voided', 'field', 'payments');
      end if;
    end if;
  end loop;

  -- ---- writes ----
  v_number := case when v_exists then v_cur.order_number else nextval('public.pos_order_number_seq') end;
  v_resp := jsonb_set(p_response, '{order_number}', to_jsonb(v_number));

  insert into public.pos_orders as o (
    order_id, restaurant_id, version, writer_device_id, order_number,
    ticket_prefix, ticket_business_date, ticket_counter, order_type, channel, status,
    customer_name, customer_phone_e164, note, ready_at, void_reason,
    created_by, closed_by, voided_by, void_approved_by, table_label, table_guest_count,
    delivery, tip, menu_snapshot_hash, priced_against_hash, device_time,
    pricing, total_cents, provisional_pricing, pricing_config, flags, sales_day, created_at, updated_at
  ) values (
    v_order_id, p_restaurant_id, v_version, p_writer, v_number,
    p_payload #>> '{ticket,prefix}', (p_payload #>> '{ticket,business_date}')::date, (p_payload #>> '{ticket,counter}')::int,
    p_payload->>'order_type', p_payload->>'channel', p_payload->>'status',
    p_payload #>> '{customer,name}', p_payload #>> '{customer,phone_e164}', p_payload->>'note',
    (p_payload->>'ready_at')::timestamptz, p_payload->>'void_reason',
    p_payload->>'created_by', p_payload->>'closed_by', p_payload->>'voided_by', p_payload->>'void_approved_by',
    p_payload #>> '{table,label}', (p_payload #>> '{table,guest_count}')::int,
    nullif(p_payload->'delivery', 'null'::jsonb), p_payload->'tip', p_payload->>'menu_snapshot_hash',
    p_response->>'priced_against_hash', (p_payload->>'device_time')::timestamptz,
    p_response->'pricing', (p_response #>> '{pricing,total_cents}')::bigint, p_payload->'provisional_pricing',
    p_payload->'pricing_config', p_response->'flags', p_sales_day, p_received_at, p_received_at
  )
  on conflict (order_id) do update set
    version = excluded.version, writer_device_id = excluded.writer_device_id,
    order_type = excluded.order_type, channel = excluded.channel, status = excluded.status,
    customer_name = excluded.customer_name, customer_phone_e164 = excluded.customer_phone_e164,
    note = excluded.note, ready_at = excluded.ready_at, void_reason = excluded.void_reason,
    created_by = excluded.created_by, closed_by = excluded.closed_by, voided_by = excluded.voided_by,
    void_approved_by = excluded.void_approved_by, table_label = excluded.table_label,
    table_guest_count = excluded.table_guest_count, delivery = excluded.delivery, tip = excluded.tip,
    menu_snapshot_hash = excluded.menu_snapshot_hash, priced_against_hash = excluded.priced_against_hash,
    device_time = excluded.device_time, pricing = excluded.pricing, total_cents = excluded.total_cents,
    provisional_pricing = excluded.provisional_pricing, pricing_config = excluded.pricing_config,
    flags = excluded.flags, sales_day = coalesce(o.sales_day, excluded.sales_day), updated_at = excluded.updated_at;
    -- never changed after creation: restaurant_id, order_number, ticket_*, created_at

  -- the aggregate's lines / modifiers = exactly this version's
  delete from public.pos_order_line_modifiers m
   where m.order_id = v_order_id
     and m.id not in (select (y->>'id')::uuid from jsonb_array_elements(p_payload->'lines') x cross join jsonb_array_elements(x->'modifiers') y);
  delete from public.pos_order_lines l
   where l.order_id = v_order_id
     and l.id not in (select (x->>'id')::uuid from jsonb_array_elements(p_payload->'lines') x);

  insert into public.pos_order_lines (
    id, order_id, position, menu_item_id, item_size_id, item_name, size_name, quantity, base_price_cents,
    discount_exempt, status, void_reason, voided_by, void_approved_by, seat, course, check_no, fired_seq,
    special_instructions)
  select (x->>'id')::uuid, v_order_id, (x->>'position')::int, x->>'menu_item_id', x->>'item_size_id', x->>'item_name',
         x->>'size_name', (x->>'quantity')::int, (x->>'base_price_cents')::bigint, (x->>'discount_exempt')::boolean,
         x->>'status', x->>'void_reason', x->>'voided_by', x->>'void_approved_by', (x->>'seat')::int, (x->>'course')::int,
         (x->>'check_no')::int, (x->>'fired_seq')::int, x->>'special_instructions'
    from jsonb_array_elements(p_payload->'lines') x
  on conflict (id) do update set
    position = excluded.position, menu_item_id = excluded.menu_item_id, item_size_id = excluded.item_size_id,
    item_name = excluded.item_name, size_name = excluded.size_name, quantity = excluded.quantity,
    base_price_cents = excluded.base_price_cents, discount_exempt = excluded.discount_exempt, status = excluded.status,
    void_reason = excluded.void_reason, voided_by = excluded.voided_by, void_approved_by = excluded.void_approved_by,
    seat = excluded.seat, course = excluded.course, check_no = excluded.check_no, fired_seq = excluded.fired_seq,
    special_instructions = excluded.special_instructions;

  insert into public.pos_order_line_modifiers (
    id, line_id, order_id, position, kind, topping_id, name, placement, price_cents, price_half_cents, size_prices, charge_cents)
  select (y->>'id')::uuid, (x->>'id')::uuid, v_order_id, (y->>'position')::int, y->>'kind', y->>'topping_id', y->>'name',
         y->>'placement', (y->>'price_cents')::bigint, (y->>'price_half_cents')::bigint, nullif(y->'size_prices', 'null'::jsonb),
         (y->>'charge_cents')::bigint
    from jsonb_array_elements(p_payload->'lines') x
    cross join jsonb_array_elements(x->'modifiers') y
  on conflict (id) do update set
    line_id = excluded.line_id, position = excluded.position, kind = excluded.kind, topping_id = excluded.topping_id,
    name = excluded.name, placement = excluded.placement, price_cents = excluded.price_cents,
    price_half_cents = excluded.price_half_cents, size_prices = excluded.size_prices, charge_cents = excluded.charge_cents;

  -- payments: insert new ids; captured → voided on known ids (the guard trigger enforces the rest)
  insert into public.pos_payments (
    id, order_id, restaurant_id, method, amount_cents, tendered_cents, change_cents, status, check_no, last4,
    external_ref, taken_by, voided_by, void_approved_by, void_reason, inserted_at, voided_at)
  select (z->>'id')::uuid, v_order_id, p_restaurant_id, z->>'method', (z->>'amount_cents')::bigint,
         (z->>'tendered_cents')::bigint, (z->>'change_cents')::bigint, z->>'status', (z->>'check_no')::int, z->>'last4',
         z->>'external_ref', z->>'taken_by', z->>'voided_by', z->>'void_approved_by', z->>'void_reason', p_received_at,
         case when z->>'status' = 'voided' then p_received_at end
    from jsonb_array_elements(p_payload->'payments') z
  on conflict (id) do nothing;

  update public.pos_payments p
     set status = 'voided', voided_by = z->>'voided_by', void_approved_by = z->>'void_approved_by',
         void_reason = z->>'void_reason', voided_at = p_received_at
    from jsonb_array_elements(p_payload->'payments') z
   where p.id = (z->>'id')::uuid and p.status = 'captured' and z->>'status' = 'voided';

  insert into public.pos_order_submissions (order_id, version, content_hash, device_id, payload, response, received_at)
  values (v_order_id, v_version, v_hash, p_writer, p_payload, v_resp, p_received_at);

  return jsonb_build_object('outcome', 'applied', 'response', v_resp);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------------------------
alter table public.pos_orders               enable row level security;
alter table public.pos_order_lines          enable row level security;
alter table public.pos_order_line_modifiers enable row level security;
alter table public.pos_payments             enable row level security;
alter table public.pos_order_submissions    enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_orders, public.pos_order_lines, public.pos_order_line_modifiers,
                    public.pos_payments, public.pos_order_submissions
  from public, anon, authenticated;
revoke all on sequence public.pos_order_number_seq from public, anon, authenticated;

grant select, insert, update         on table public.pos_orders               to service_role;
grant select, insert, update, delete on table public.pos_order_lines          to service_role;  -- aggregate upsert
grant select, insert, update, delete on table public.pos_order_line_modifiers to service_role;
grant select, insert, update         on table public.pos_payments             to service_role;  -- update = void only (trigger)
grant select, insert                 on table public.pos_order_submissions    to service_role;  -- immutable
grant usage, select                  on sequence public.pos_order_number_seq  to service_role;

revoke all on function public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz, date) from public, anon, authenticated;
grant execute on function public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz, date) to service_role;
revoke all on function public.pos_payments_guard() from public, anon, authenticated;

comment on table public.pos_orders is 'POS orders (SYNC-CONTRACT §3), latest applied version per order. Service role only. Never the web orders table.';
comment on table public.pos_payments is 'POS payments: insert-only; captured → voided only (trg_pos_payments_guard). cash | external_card (last4 / external_ref, never card data).';
comment on table public.pos_order_submissions is 'Idempotency (SYNC §3.1): (order_id, version) → content_hash + original response + request as received. Immutable.';
comment on function public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz, date) is
  'pos-v1-submit-order apply: lock, identity re-check, §3.1, payment rules, aggregate upsert, idempotency row — one transaction.';

commit;
