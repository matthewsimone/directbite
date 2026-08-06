-- 074_maintain_profile_stats.sql
-- Keeps display_name and order_count current. The accrual trigger already
-- runs exactly once per order, at the moment items finish writing, so it is
-- the natural place: no extra trigger, no extra write path.
--
-- Note this fires regardless of loyalty_enabled — a restaurant that turns
-- loyalty on later then has an accurate count from day one, and the profile
-- row is created either way by the identity link.

begin;

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

    -- Profile stats are maintained for every known customer, whether or not
    -- this restaurant runs a loyalty program. The name comes from the order
    -- so the rewards page can greet them without asking for it.
    if v_customer_id is not null then
      insert into restaurant_customers (restaurant_id, customer_id)
      values (new.restaurant_id, v_customer_id)
      on conflict (restaurant_id, customer_id) do nothing;

      update restaurant_customers
         set order_count   = order_count + 1,
             display_name  = coalesce(nullif(display_name, ''), nullif(new.customer_name, '')),
             last_order_at = now(),
             updated_at    = now()
       where restaurant_id = new.restaurant_id
         and customer_id   = v_customer_id;
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

    v_basis_cents := greatest(
      v_basis_cents - round(coalesce(new.loyalty_discount_amount, 0) * 100)::integer,
      0
    );

    select tier_level into v_tier_level
      from restaurant_customers
     where restaurant_id = new.restaurant_id and customer_id = v_customer_id;
    v_tier_level := coalesce(v_tier_level, 1);

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
             updated_at = now()
       where restaurant_id = new.restaurant_id and customer_id = v_customer_id;
    end if;

  exception when others then
    raise warning 'loyalty accrual failed for order %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

commit;