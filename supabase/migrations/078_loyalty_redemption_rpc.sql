-- 078_loyalty_redemption_rpc.sql
-- Spending points. Two functions, no schema changes: 068 already built
-- loyalty_rewards, loyalty_redemptions, the order columns and the indexes.
--
-- Design: points are deducted when the reward is SELECTED, not on payment
-- success. The row lands as 'pending' and the webhook only flips it to
-- 'applied'. That keeps arithmetic out of stripe-webhook, where a failure is
-- unrecoverable, and gives create-payment-intent a real row to price against
-- rather than a client claim.
--
-- Ledger is truth. Every point movement writes a loyalty_transactions row
-- first; the balance is recomputed from the ledger rather than incremented,
-- matching claim_guest_loyalty.

-- ---------------------------------------------------------------
-- Expire stale pending redemptions and return the points.
-- Called at the head of redeem_reward and safe to call anywhere else.
-- Scoped to one customer at one restaurant: this is a self-heal on read,
-- not a sweep.
-- ---------------------------------------------------------------
create or replace function expire_stale_redemptions(
  p_restaurant_id uuid,
  p_customer_id   uuid
)
returns integer
language plpgsql
security definer
as $$
declare
  v_rec     record;
  v_expired integer := 0;
  v_phone   text;
begin
  select phone_e164 into v_phone
    from customer_identities where id = p_customer_id;

  for v_rec in
    select id, points_spent
      from loyalty_redemptions
     where restaurant_id = p_restaurant_id
       and customer_id   = p_customer_id
       and status        = 'pending'
       and code_expires_at is not null
       and code_expires_at < now()
     for update
  loop
    update loyalty_redemptions
       set status = 'expired'
     where id = v_rec.id;

    insert into loyalty_transactions (
      restaurant_id, customer_id, phone_e164, reason, points_delta
    ) values (
      p_restaurant_id, p_customer_id, v_phone, 'refund', v_rec.points_spent
    );

    v_expired := v_expired + 1;
  end loop;

  if v_expired > 0 then
    update restaurant_customers rc
       set points_balance = greatest(coalesce((
             select sum(points_delta) from loyalty_transactions
              where customer_id = p_customer_id
                and restaurant_id = p_restaurant_id
           ), 0), 0),
           updated_at = now()
     where rc.restaurant_id = p_restaurant_id
       and rc.customer_id   = p_customer_id;
  end if;

  return v_expired;
end;
$$;

revoke all on function expire_stale_redemptions(uuid, uuid) from public, anon, authenticated;
grant execute on function expire_stale_redemptions(uuid, uuid) to service_role;

-- ---------------------------------------------------------------
-- Redeem a reward. Returns the new redemption row's id, or raises.
-- ---------------------------------------------------------------
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
