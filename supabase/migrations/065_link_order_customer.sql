-- 065_link_order_customer.sql
-- The accrual trigger resolves customer_id from the phone but never
-- wrote it back to the order. Order-history lookups by customer_id
-- would miss every order placed before that customer verified.

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

    -- Link the order to a known identity regardless of loyalty config.
    -- Order history is keyed on customer_id and must resolve even for
    -- restaurants with loyalty disabled.
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

-- Backfill orders whose phone already has a verified identity.
update orders o
   set customer_id = ci.id
  from customer_identities ci
 where o.phone_e164 = ci.phone_e164
   and o.customer_id is null;

commit;