-- 063_loyalty_foundation.sql
-- Additive. Ledger-first: balances are a cache, the ledger is truth.
-- Every trigger is exception-safe — loyalty can NEVER fail an order write.

begin;

-- ---------------------------------------------------------------
-- 1. Restaurant-level config. Opt-in: nobody gets loyalty by surprise.
-- ---------------------------------------------------------------
alter table restaurants add column if not exists loyalty_enabled boolean not null default false;
alter table restaurants add column if not exists loyalty_points_per_dollar numeric(6,2) not null default 1.00;
alter table restaurants add column if not exists loyalty_earn_basis text not null default 'subtotal';

alter table restaurants drop constraint if exists restaurants_loyalty_earn_basis_valid;
alter table restaurants add constraint restaurants_loyalty_earn_basis_valid
  check (loyalty_earn_basis in ('subtotal', 'subtotal_less_discount', 'total'));

-- ---------------------------------------------------------------
-- 2. Per-restaurant tiers. Renameable, recolorable, own multipliers.
-- ---------------------------------------------------------------
create table if not exists restaurant_loyalty_tiers (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id) on delete cascade,
  tier_level       smallint not null,
  name             text not null,
  color            text,
  multiplier       numeric(5,3) not null default 1.000,
  threshold_points integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (restaurant_id, tier_level),
  constraint rlt_tier_level_valid  check (tier_level between 1 and 5),
  constraint rlt_multiplier_valid  check (multiplier >= 1.000 and multiplier <= 10.000),
  constraint rlt_threshold_valid   check (threshold_points >= 0)
);

create index if not exists idx_rlt_restaurant on restaurant_loyalty_tiers (restaurant_id);

-- ---------------------------------------------------------------
-- 3. The ledger. Append-only. Truth.
--    customer_id is NULL for guests — points accrue to the phone
--    and attach on first verification.
-- ---------------------------------------------------------------
create table if not exists loyalty_transactions (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  customer_id     uuid references customer_identities(id) on delete set null,
  phone_e164      text not null,
  order_id        uuid references orders(id) on delete set null,
  reason          text not null,
  points_delta    integer not null,
  basis_cents     integer,
  rate_per_dollar numeric(6,2),
  tier_level      smallint,
  tier_multiplier numeric(5,3),
  note            text,
  created_at      timestamptz not null default now(),
  constraint lt_reason_valid
    check (reason in ('earn','redeem','refund','adjustment','expiry','backfill')),
  constraint lt_phone_format check (phone_e164 ~ '^\+1[0-9]{10}$')
);

create index if not exists idx_lt_phone_restaurant
  on loyalty_transactions (phone_e164, restaurant_id, created_at desc);
create index if not exists idx_lt_customer
  on loyalty_transactions (customer_id) where customer_id is not null;
create index if not exists idx_lt_order
  on loyalty_transactions (order_id) where order_id is not null;

-- One earn row per order, ever. Closes double-accrual at the DB level.
create unique index if not exists idx_lt_one_earn_per_order
  on loyalty_transactions (order_id) where reason = 'earn' and order_id is not null;

-- ---------------------------------------------------------------
-- 4. Replace the hardcoded tier text column with a structural level.
--    Safe: only test rows exist today.
-- ---------------------------------------------------------------
alter table restaurant_customers drop constraint if exists restaurant_customers_tier_valid;
alter table restaurant_customers add column if not exists tier_level smallint not null default 1;
alter table restaurant_customers add column if not exists lifetime_points_earned integer not null default 0;

alter table restaurant_customers drop constraint if exists rc_tier_level_valid;
alter table restaurant_customers add constraint rc_tier_level_valid
  check (tier_level between 1 and 5);

alter table restaurant_customers drop column if exists tier;

-- ---------------------------------------------------------------
-- 5. Normalize phone on order insert. Exception-safe.
-- ---------------------------------------------------------------
create or replace function orders_set_phone_e164()
returns trigger
language plpgsql
as $$
begin
  begin
    new.phone_e164 := normalize_phone_e164(new.customer_phone);
  exception when others then
    new.phone_e164 := null;
  end;
  return new;
end;
$$;

drop trigger if exists trg_orders_set_phone_e164 on orders;
create trigger trg_orders_set_phone_e164
  before insert or update of customer_phone on orders
  for each row execute function orders_set_phone_e164();

-- ---------------------------------------------------------------
-- 6. One formula. Checkout preview and accrual both call this.
--    Floor, always — never round up.
-- ---------------------------------------------------------------
create or replace function calculate_loyalty_points(
  p_restaurant_id uuid,
  p_tier_level    smallint,
  p_basis_cents   integer
)
returns integer
language plpgsql
stable
as $$
declare
  v_enabled    boolean;
  v_rate       numeric(6,2);
  v_multiplier numeric(5,3);
begin
  if p_basis_cents is null or p_basis_cents <= 0 then
    return 0;
  end if;

  select loyalty_enabled, loyalty_points_per_dollar
    into v_enabled, v_rate
    from restaurants where id = p_restaurant_id;

  if not coalesce(v_enabled, false) then
    return 0;
  end if;

  select multiplier into v_multiplier
    from restaurant_loyalty_tiers
   where restaurant_id = p_restaurant_id
     and tier_level = coalesce(p_tier_level, 1);

  v_multiplier := coalesce(v_multiplier, 1.000);

  return floor((p_basis_cents::numeric / 100.0) * v_rate * v_multiplier)::integer;
end;
$$;

-- ---------------------------------------------------------------
-- 7. Accrual. Fires when items finish writing. Exception-safe:
--    a loyalty failure can never fail the order update.
-- ---------------------------------------------------------------
create or replace function orders_accrue_loyalty()
returns trigger
language plpgsql
security definer
as $$
declare
  v_enabled     boolean;
  v_basis_mode  text;
  v_rate        numeric(6,2);
  v_basis_cents integer;
  v_customer_id uuid;
  v_tier_level  smallint := 1;
  v_multiplier  numeric(5,3) := 1.000;
  v_points      integer;
begin
  begin
    if new.phone_e164 is null then
      return new;
    end if;

    select loyalty_enabled, loyalty_earn_basis, loyalty_points_per_dollar
      into v_enabled, v_basis_mode, v_rate
      from restaurants where id = new.restaurant_id;

    if not coalesce(v_enabled, false) then
      return new;
    end if;

    v_basis_cents := case coalesce(v_basis_mode, 'subtotal')
      when 'subtotal'               then round(new.subtotal * 100)
      when 'subtotal_less_discount' then round(greatest(new.subtotal - coalesce(new.discount_amount,0), 0) * 100)
      when 'total'                  then round(new.total_amount * 100)
      else round(new.subtotal * 100)
    end::integer;

    select id into v_customer_id
      from customer_identities where phone_e164 = new.phone_e164;

    if v_customer_id is not null then
      select tier_level into v_tier_level
        from restaurant_customers
       where restaurant_id = new.restaurant_id and customer_id = v_customer_id;
      v_tier_level := coalesce(v_tier_level, 1);
    end if;

    select multiplier into v_multiplier
      from restaurant_loyalty_tiers
     where restaurant_id = new.restaurant_id and tier_level = v_tier_level;
    v_multiplier := coalesce(v_multiplier, 1.000);

    v_points := calculate_loyalty_points(new.restaurant_id, v_tier_level, v_basis_cents);

    if v_points <= 0 then
      return new;
    end if;

    insert into loyalty_transactions (
      restaurant_id, customer_id, phone_e164, order_id, reason,
      points_delta, basis_cents, rate_per_dollar, tier_level, tier_multiplier
    ) values (
      new.restaurant_id, v_customer_id, new.phone_e164, new.id, 'earn',
      v_points, v_basis_cents, v_rate, v_tier_level, v_multiplier
    )
    on conflict do nothing;

    -- Cache update only for known customers. Guests live in the ledger
    -- until they verify, then get swept in.
    if v_customer_id is not null then
      update restaurant_customers
         set points_balance = points_balance + v_points,
             lifetime_points_earned = lifetime_points_earned + v_points,
             last_order_at = now(),
             updated_at = now()
       where restaurant_id = new.restaurant_id and customer_id = v_customer_id;
    end if;

  exception when others then
    raise warning 'loyalty accrual failed for order %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists trg_orders_accrue_loyalty on orders;
create trigger trg_orders_accrue_loyalty
  after update of items_written_at on orders
  for each row
  when (old.items_written_at is null and new.items_written_at is not null)
  execute function orders_accrue_loyalty();

-- ---------------------------------------------------------------
-- 8. Lock down.
-- ---------------------------------------------------------------
alter table loyalty_transactions      enable row level security;
alter table restaurant_loyalty_tiers  enable row level security;

revoke all on loyalty_transactions     from anon, authenticated;
revoke all on restaurant_loyalty_tiers from anon, authenticated;
grant all on loyalty_transactions      to service_role;
grant all on restaurant_loyalty_tiers  to service_role;

revoke all on function calculate_loyalty_points(uuid, smallint, integer) from public, anon, authenticated;
grant execute on function calculate_loyalty_points(uuid, smallint, integer) to service_role;

commit;