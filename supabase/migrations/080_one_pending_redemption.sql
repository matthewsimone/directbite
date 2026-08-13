-- 080_one_pending_redemption.sql
-- One reward per order, enforced at the pending stage rather than only at
-- the applied stage.
--
-- idx_lrd_one_per_order already forbids two applied redemptions on an order,
-- but pending rows carry no order_id and so are unconstrained. Two tabs — or
-- one customer adding a second reward without removing the first — could
-- therefore hold two pending redemptions, spending points twice and leaving
-- create-payment-intent to guess which one applies.
--
-- Removing a reward from the cart cancels its redemption and returns the
-- points, so the remove-then-add flow is unaffected: the customer's full
-- balance is available the moment the first reward leaves the cart.
--
-- Only redeem_reward changes. Everything else from 078 is carried forward
-- verbatim.

create or replace function redeem_reward(
  p_restaurant_id uuid,
  p_customer_id   uuid,
  p_reward_id     uuid,
  p_channel       text default 'online',
  p_ttl_minutes   integer default 30
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_reward   loyalty_rewards%rowtype;
  v_balance  integer;
  v_phone    text;
  v_id       uuid;
  v_enabled  boolean;
  v_existing integer;
begin
  if p_channel not in ('online', 'in_person') then
    raise exception 'invalid_channel';
  end if;

  select loyalty_enabled into v_enabled
    from restaurants where id = p_restaurant_id;
  if not coalesce(v_enabled, false) then
    raise exception 'loyalty_disabled';
  end if;

  -- Return anything already stale before checking affordability, so a
  -- customer is never blocked by points held on an abandoned cart.
  perform expire_stale_redemptions(p_restaurant_id, p_customer_id);

  -- One live reward at a time. Checked AFTER the expiry sweep so a stale
  -- pending row can never block a legitimate redemption.
  select count(*) into v_existing
    from loyalty_redemptions
   where restaurant_id = p_restaurant_id
     and customer_id   = p_customer_id
     and status        = 'pending';

  if v_existing > 0 then
    raise exception 'redemption_in_progress';
  end if;

  select * into v_reward
    from loyalty_rewards
   where id = p_reward_id
     and restaurant_id = p_restaurant_id
     and active = true;

  if not found then
    raise exception 'reward_unavailable';
  end if;

  select phone_e164 into v_phone
    from customer_identities where id = p_customer_id;
  if v_phone is null then
    raise exception 'unknown_customer';
  end if;

  -- Lock the profile row so two tabs cannot both pass the balance check.
  select points_balance into v_balance
    from restaurant_customers
   where restaurant_id = p_restaurant_id
     and customer_id   = p_customer_id
   for update;

  if v_balance is null or v_balance < v_reward.points_cost then
    raise exception 'insufficient_points';
  end if;

  insert into loyalty_redemptions (
    restaurant_id, customer_id, reward_id, channel, status,
    points_spent, reward_kind, reward_name, discount_cents,
    menu_item_id, item_size_id, code_expires_at
  ) values (
    p_restaurant_id, p_customer_id, p_reward_id, p_channel, 'pending',
    v_reward.points_cost, v_reward.kind, v_reward.name, v_reward.discount_cents,
    v_reward.menu_item_id, v_reward.item_size_id,
    now() + make_interval(mins => p_ttl_minutes)
  )
  returning id into v_id;

  insert into loyalty_transactions (
    restaurant_id, customer_id, phone_e164, reason, points_delta
  ) values (
    p_restaurant_id, p_customer_id, v_phone, 'redeem', -v_reward.points_cost
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

  return v_id;
end;
$$;

revoke all on function redeem_reward(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function redeem_reward(uuid, uuid, uuid, text, integer) to service_role;
