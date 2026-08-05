-- 068_loyalty_rewards.sql
-- Redemption side of loyalty. Additive only; nothing reads these tables yet.
--
-- A reward is either a free menu item (added to the cart at $0) or a fixed
-- dollar discount. Both stack with percentage promotions, and the order of
-- operations is fixed: promo percentage applies to the pre-reward subtotal,
-- then the loyalty dollar amount is subtracted.
--
-- Points are spent through loyalty_transactions as a negative 'redeem' row.
-- The ledger stays the single source of truth; balances remain a cache.

begin;

-- ---------------------------------------------------------------
-- 1. The catalog. Per restaurant, per reward.
-- ---------------------------------------------------------------
create table if not exists loyalty_rewards (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references restaurants(id) on delete cascade,
  kind               text not null,
  name               text not null,
  description        text,
  points_cost        integer not null,
  menu_item_id       uuid references menu_items(id) on delete set null,
  item_size_id       uuid references item_sizes(id) on delete set null,
  discount_cents     integer,
  min_subtotal_cents integer not null default 0,
  active             boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint lr_kind_valid        check (kind in ('item', 'discount')),
  constraint lr_points_positive   check (points_cost > 0),
  constraint lr_min_subtotal_ok   check (min_subtotal_cents >= 0),
  -- An item reward must name an item and carry no dollar amount.
  -- A discount reward must carry a positive amount and no item.
  constraint lr_shape_valid check (
    (kind = 'item'     and menu_item_id is not null and discount_cents is null)
    or
    (kind = 'discount' and menu_item_id is null and discount_cents > 0)
  )
);

create index if not exists idx_lr_restaurant_active
  on loyalty_rewards (restaurant_id, active, sort_order);

-- ---------------------------------------------------------------
-- 2. Redemptions. One row per claim, online or in person.
--    code is null for online; a short-lived 6-digit string in person.
-- ---------------------------------------------------------------
create table if not exists loyalty_redemptions (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  customer_id     uuid not null references customer_identities(id) on delete cascade,
  reward_id       uuid references loyalty_rewards(id) on delete set null,
  order_id        uuid references orders(id) on delete set null,
  channel         text not null,
  status          text not null default 'pending',
  points_spent    integer not null,
  reward_kind     text not null,
  reward_name     text not null,
  discount_cents  integer,
  menu_item_id    uuid,
  item_size_id    uuid,
  code            text,
  code_expires_at timestamptz,
  applied_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint lrd_channel_valid check (channel in ('online', 'in_person')),
  constraint lrd_status_valid  check (status in ('pending', 'applied', 'expired', 'cancelled')),
  constraint lrd_points_positive check (points_spent > 0),
  constraint lrd_kind_valid    check (reward_kind in ('item', 'discount'))
);

create index if not exists idx_lrd_customer
  on loyalty_redemptions (customer_id, created_at desc);
create index if not exists idx_lrd_restaurant_status
  on loyalty_redemptions (restaurant_id, status, created_at desc);
create index if not exists idx_lrd_order
  on loyalty_redemptions (order_id) where order_id is not null;

-- Only one live in-person code at a time per restaurant. Prevents a
-- staff member typing a code that matches two pending redemptions.
create unique index if not exists idx_lrd_active_code
  on loyalty_redemptions (restaurant_id, code)
  where code is not null and status = 'pending';

-- ---------------------------------------------------------------
-- 3. Order columns. Loyalty is its own money line, never merged
--    with discount_amount — the receipt has to name which is which,
--    and settlement will eventually need them split.
-- ---------------------------------------------------------------
alter table orders add column if not exists loyalty_discount_amount numeric not null default 0;
alter table orders add column if not exists loyalty_points_spent integer not null default 0;

-- Marks a line item as a redeemed reward. Non-null means the line
-- prints at 0.00 with a reward callout.
alter table order_items add column if not exists loyalty_redemption_id uuid
  references loyalty_redemptions(id) on delete set null;

create index if not exists idx_order_items_loyalty
  on order_items (loyalty_redemption_id) where loyalty_redemption_id is not null;

-- ---------------------------------------------------------------
-- 4. Earn basis excludes loyalty-redeemed money. A customer must not
--    earn points on a dollar amount they paid for with points.
--    Promo discounts still earn — only the loyalty portion is removed.
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

    select id into v_customer_id
      from customer_identities where phone_e164 = new.phone_e164;

    if v_customer_id is not null and new.customer_id is null then
      update orders set customer_id = v_customer_id where id = new.id;
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

    -- Always remove the loyalty-redeemed portion, whatever the basis mode.
    v_basis_cents := greatest(
      v_basis_cents - round(coalesce(new.loyalty_discount_amount, 0) * 100)::integer,
      0
    );

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

-- ---------------------------------------------------------------
-- 5. Lock down. Admins manage the catalog; the ledger and
--    redemptions stay read-only to them.
-- ---------------------------------------------------------------
alter table loyalty_rewards     enable row level security;
alter table loyalty_redemptions enable row level security;

revoke all on loyalty_rewards     from anon, authenticated;
revoke all on loyalty_redemptions from anon, authenticated;
grant all on loyalty_rewards      to service_role;
grant all on loyalty_redemptions  to service_role;

grant select, insert, update, delete on loyalty_rewards to authenticated;
grant select on loyalty_redemptions to authenticated;

drop policy if exists admin_all_loyalty_rewards on loyalty_rewards;
create policy admin_all_loyalty_rewards on loyalty_rewards
  for all to authenticated
  using (is_admin())
  with check (is_admin());

drop policy if exists admin_read_loyalty_redemptions on loyalty_redemptions;
create policy admin_read_loyalty_redemptions on loyalty_redemptions
  for select to authenticated
  using (is_admin());

commit;