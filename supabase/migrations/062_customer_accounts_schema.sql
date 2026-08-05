-- 062_customer_accounts_schema.sql
-- Additive only. No existing column altered or dropped.
-- Nothing reads or writes these tables until the edge function ships.

begin;

-- ---------------------------------------------------------------
-- 1. Phone normalizer. NULL on anything unparseable — never guess.
-- ---------------------------------------------------------------
create or replace function normalize_phone_e164(raw text)
returns text
language sql
immutable
as $$
  select case
    when raw is null then null
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) = 11
         and left(regexp_replace(raw, '[^0-9]', '', 'g'), 1) = '1'
      then '+1' || right(regexp_replace(raw, '[^0-9]', '', 'g'), 10)
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) = 10
      then '+1' || regexp_replace(raw, '[^0-9]', '', 'g')
    else null
  end
$$;

-- ---------------------------------------------------------------
-- 2. Identity. One row per phone, platform-wide.
-- ---------------------------------------------------------------
create table if not exists customer_identities (
  id                uuid primary key default gen_random_uuid(),
  phone_e164        text not null unique,
  phone_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint customer_identities_phone_format
    check (phone_e164 ~ '^\+1[0-9]{10}$')
);

create index if not exists idx_customer_identities_phone
  on customer_identities (phone_e164);

-- ---------------------------------------------------------------
-- 3. Sessions. We own these. Hash at rest, never plaintext.
-- ---------------------------------------------------------------
create table if not exists customer_sessions (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customer_identities(id) on delete cascade,
  token_hash   text not null unique,
  origin       text,
  surface      text not null default 'web',
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '365 days'),
  revoked_at   timestamptz
);

create index if not exists idx_customer_sessions_token
  on customer_sessions (token_hash);
create index if not exists idx_customer_sessions_customer
  on customer_sessions (customer_id);

-- ---------------------------------------------------------------
-- 4. Per-restaurant profile. Points, tier, contact, consent state.
--    This is what the customer perceives as "their account".
-- ---------------------------------------------------------------
create table if not exists restaurant_customers (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references restaurants(id) on delete cascade,
  customer_id        uuid not null references customer_identities(id) on delete cascade,
  display_name       text,
  email              text,
  points_balance     integer not null default 0,
  lifetime_points    integer not null default 0,
  tier               text not null default 'standard',
  stripe_customer_id text,
  marketing_opt_in   boolean not null default false,
  first_order_at     timestamptz,
  last_order_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (restaurant_id, customer_id),
  constraint restaurant_customers_points_nonneg check (points_balance >= 0),
  constraint restaurant_customers_tier_valid
    check (tier in ('standard', 'gold', 'platinum'))
);

create index if not exists idx_restaurant_customers_restaurant
  on restaurant_customers (restaurant_id);
create index if not exists idx_restaurant_customers_customer
  on restaurant_customers (customer_id);

-- ---------------------------------------------------------------
-- 5. Consent proof. Twilio's 72-hour evidence requirement.
-- ---------------------------------------------------------------
create table if not exists customer_consents (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references customer_identities(id) on delete set null,
  restaurant_id uuid references restaurants(id) on delete set null,
  phone_e164    text not null,
  kind          text not null,
  text_shown    text not null,
  origin        text,
  ip_address    text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  constraint customer_consents_kind_valid
    check (kind in ('otp_verification', 'marketing_sms', 'marketing_email'))
);

create index if not exists idx_customer_consents_phone
  on customer_consents (phone_e164, created_at desc);

-- ---------------------------------------------------------------
-- 6. Additive columns on orders. Nothing existing touched.
-- ---------------------------------------------------------------
alter table orders add column if not exists phone_e164 text;
alter table orders add column if not exists customer_id uuid
  references customer_identities(id) on delete set null;

create index if not exists idx_orders_phone_e164
  on orders (phone_e164) where phone_e164 is not null;
create index if not exists idx_orders_customer_id
  on orders (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------
-- 7. Backfill
-- ---------------------------------------------------------------
update orders
set phone_e164 = normalize_phone_e164(customer_phone)
where phone_e164 is null;

-- ---------------------------------------------------------------
-- 8. Lock down. Service role only, matching the 047 pattern.
-- ---------------------------------------------------------------
alter table customer_identities   enable row level security;
alter table customer_sessions     enable row level security;
alter table restaurant_customers  enable row level security;
alter table customer_consents     enable row level security;

revoke all on customer_identities  from anon, authenticated;
revoke all on customer_sessions    from anon, authenticated;
revoke all on restaurant_customers from anon, authenticated;
revoke all on customer_consents    from anon, authenticated;

grant all on customer_identities   to service_role;
grant all on customer_sessions     to service_role;
grant all on restaurant_customers  to service_role;
grant all on customer_consents     to service_role;

do $$
declare
  v_total   bigint;
  v_filled  bigint;
  v_null    bigint;
  v_distinct bigint;
begin
  select count(*), count(phone_e164), count(*) - count(phone_e164),
         count(distinct phone_e164)
    into v_total, v_filled, v_null, v_distinct
    from orders;
  raise notice 'orders total: %', v_total;
  raise notice 'phone_e164 filled: %', v_filled;
  raise notice 'phone_e164 null (unparseable): %', v_null;
  raise notice 'distinct customers: %', v_distinct;
end $$;

commit;
