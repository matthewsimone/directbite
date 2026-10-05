-- 090_external_orders.sql
-- Ordr consolidated DSP orders (DoorDash / Uber Eats / Grubhub via KitchenHub).
-- Additive only: four new tables. Does not touch orders, order_items, stripe-webhook, or reporting.
-- Applied live in the SQL Editor 2026-10-05 before this file was committed. Idempotent.
-- Provider-derived fields have NO check constraints on purpose: an unexpected enum value
-- must never cause an order to be rejected (fail-open on ingest; normalize in code).

create table if not exists public.kitchenhub_stores (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null unique references public.restaurants(id),
  kh_store_id     text not null unique,
  kh_location_id  text,
  enabled         boolean not null default false,
  created_at      timestamptz not null default now()
);

create table if not exists public.kitchenhub_tokens (
  id                 smallint primary key default 1 check (id = 1),
  access_token       text,
  access_expires_at  timestamptz,
  updated_at         timestamptz not null default now()
);

create table if not exists public.external_order_events (
  id            bigserial primary key,
  received_at   timestamptz not null default now(),
  kh_order_id   bigint,
  kh_store_id   text,
  event_type    text,
  event_status  text,
  payload       jsonb not null,
  processed     boolean not null default false,
  error         text
);
create index if not exists idx_ext_events_order on public.external_order_events (kh_order_id);

create table if not exists public.external_orders (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id),
  kh_order_id         bigint not null unique,
  kh_store_id         text not null,
  provider_id         text not null,
  provider_name       text,
  external_id         text,
  order_number        text,
  daily_number        integer,
  order_type          text,
  status              text not null default 'new',
  kh_status_raw       text,
  asap                boolean,
  scheduled_for       timestamptz,
  pickup_at           timestamptz,
  placed_at           timestamptz,
  customer_name       text,
  customer_phone      text,
  customer_phone_code text,
  notes               text,
  delivery_type       text,
  delivery            jsonb,
  items               jsonb not null default '[]'::jsonb,
  charges             jsonb,
  total               numeric(10,2),
  payment_method      text,
  prep_time_minutes   integer,
  acknowledged_at     timestamptz,
  accepted_at         timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        text,
  print_status        text not null default 'pending',
  print_attempts      integer not null default 0,
  printed_at          timestamptz,
  last_print_error    text,
  raw                 jsonb not null,
  last_event_at       timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_ext_orders_rest_created on public.external_orders (restaurant_id, created_at desc);
create index if not exists idx_ext_orders_unacked_new on public.external_orders (restaurant_id)
  where status = 'new' and acknowledged_at is null;

alter table public.kitchenhub_stores      enable row level security;
alter table public.kitchenhub_tokens      enable row level security;
alter table public.external_order_events  enable row level security;
alter table public.external_orders        enable row level security;

revoke all on public.kitchenhub_stores, public.kitchenhub_tokens, public.external_order_events
  from anon, authenticated;
revoke all on sequence public.external_order_events_id_seq from anon, authenticated;

revoke all on public.external_orders from anon;
revoke insert, update, delete, truncate, trigger, references on public.external_orders from authenticated;
grant select on public.external_orders to authenticated;
grant update (acknowledged_at, print_status, print_attempts, printed_at, last_print_error)
  on public.external_orders to authenticated;

drop policy if exists "tablet_read_own_external_orders" on public.external_orders;
create policy "tablet_read_own_external_orders"
  on public.external_orders for select
  using (restaurant_id in (
    select id from public.restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

drop policy if exists "tablet_update_own_external_orders" on public.external_orders;
create policy "tablet_update_own_external_orders"
  on public.external_orders for update
  using (restaurant_id in (
    select id from public.restaurants where tablet_email = auth.jwt() ->> 'email'
  ))
  with check (restaurant_id in (
    select id from public.restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'external_orders'
  ) then
    alter publication supabase_realtime add table public.external_orders;
  end if;
end $$;
