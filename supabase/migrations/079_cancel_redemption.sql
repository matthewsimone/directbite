-- 079_cancel_redemption.sql
-- Removing the reward line from the cart returns the points immediately.
-- Only a pending redemption can be cancelled: once the webhook has flipped
-- it to 'applied' the order is paid and the points are legitimately spent.
--
-- Ledger-first like the rest: a 'refund' row, then the balance is recomputed
-- from the ledger rather than incremented.

create or replace function cancel_redemption(
  p_restaurant_id uuid,
  p_customer_id   uuid,
  p_redemption_id uuid
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_rec   loyalty_redemptions%rowtype;
  v_phone text;
begin
  select * into v_rec
    from loyalty_redemptions
   where id            = p_redemption_id
     and restaurant_id = p_restaurant_id
     and customer_id   = p_customer_id
     and status        = 'pending'
   for update;

  -- Not found, already applied, or belonging to someone else: return false
  -- rather than raising. The caller is a cart interaction and a stale click
  -- must not surface an error.
  if not found then
    return false;
  end if;

  select phone_e164 into v_phone
    from customer_identities where id = p_customer_id;

  update loyalty_redemptions
     set status = 'cancelled'
   where id = p_redemption_id;

  insert into loyalty_transactions (
    restaurant_id, customer_id, phone_e164, reason, points_delta
  ) values (
    p_restaurant_id, p_customer_id, v_phone, 'refund', v_rec.points_spent
  );

  update restaurant_customers
     set points_balance = greatest(coalesce((
           select sum(points_delta) from loyalty_transactions
            where customer_id = p_customer_id
              and restaurant_id = p_restaurant_id
         ), 0), 0),
         updated_at = now()
   where restaurant_id = p_restaurant_id
     and customer_id   = p_customer_id;

  return true;
end;
$$;

revoke all on function cancel_redemption(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function cancel_redemption(uuid, uuid, uuid) to service_role;
