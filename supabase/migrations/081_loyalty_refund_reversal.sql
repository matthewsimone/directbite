-- 081_loyalty_refund_reversal.sql
-- Reversing loyalty when an order is fully refunded.
--
-- Three code paths issue refunds — admin-refund, admin-approve-adjustment and
-- stripe-webhook's charge.refunded handler — and a fourth exists outside the
-- application entirely, the Stripe dashboard. All four converge on writing
-- orders.refund_status, so the reversal lives on that column rather than in
-- any one function. Same reasoning as trg_orders_accrue_loyalty, which keys
-- on items_written_at.
--
-- FULL refunds only. A partial refund is a price adjustment: the customer
-- keeps the points they earned and keeps the reward they redeemed. Only a
-- refund that unwinds the whole order unwinds the loyalty with it.
--
-- Ledger-first, like every other point movement: a refund row is written and
-- the balance is recomputed from the ledger rather than incremented.

create or replace function orders_reverse_loyalty()
returns trigger
language plpgsql
security definer
as $$
declare
  v_customer_id uuid;
  v_phone       text;
  v_earned      integer;
  v_rec         record;
begin
  begin
    -- Full refunds only. 'partial' and 'failed' are deliberately ignored.
    if coalesce(new.refund_status, '') <> 'completed' then
      return new;
    end if;

    v_customer_id := new.customer_id;
    v_phone       := new.phone_e164;

    if v_customer_id is null or v_phone is null then
      return new;
    end if;

    -- 1. Reverse the earn. The unique index idx_lt_one_earn_per_order means
    -- there is at most one, and it is scoped to reason = 'earn' so the
    -- reversal row below does not collide with it.
    select points_delta into v_earned
      from loyalty_transactions
     where order_id = new.id
       and reason   = 'earn'
     limit 1;

    if v_earned is not null and v_earned > 0 then
      -- Guard against a second refund event on the same order.
      if not exists (
        select 1 from loyalty_transactions
         where order_id = new.id
           and reason   = 'refund'
           and points_delta < 0
      ) then
        insert into loyalty_transactions (
          restaurant_id, customer_id, phone_e164, order_id, reason, points_delta
        ) values (
          new.restaurant_id, v_customer_id, v_phone, new.id, 'refund', -v_earned
        );
      end if;
    end if;

    -- 2. Return anything redeemed on this order and release the redemption.
    for v_rec in
      select id, points_spent
        from loyalty_redemptions
       where order_id = new.id
         and status   = 'applied'
       for update
    loop
      update loyalty_redemptions
         set status = 'cancelled'
       where id = v_rec.id;

      insert into loyalty_transactions (
        restaurant_id, customer_id, phone_e164, order_id, reason, points_delta
      ) values (
        new.restaurant_id, v_customer_id, v_phone, new.id, 'refund', v_rec.points_spent
      );
    end loop;

    -- 3. Recompute rather than increment. The ledger is truth.
    update restaurant_customers
       set points_balance = greatest(coalesce((
             select sum(points_delta) from loyalty_transactions
              where customer_id   = v_customer_id
                and restaurant_id = new.restaurant_id
           ), 0), 0),
           updated_at = now()
     where restaurant_id = new.restaurant_id
       and customer_id   = v_customer_id;

  exception when others then
    -- Never block a refund. The money is the customer's either way; a
    -- loyalty reversal that fails is a discrepancy to find in the logs, not
    -- a reason to leave someone unrefunded.
    raise warning 'loyalty reversal failed for order %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists trg_orders_reverse_loyalty on orders;
create trigger trg_orders_reverse_loyalty
  after update of refund_status on orders
  for each row
  when (
    old.refund_status is distinct from new.refund_status
    and new.refund_status = 'completed'
  )
  execute function orders_reverse_loyalty();

revoke all on function orders_reverse_loyalty() from public, anon, authenticated;
