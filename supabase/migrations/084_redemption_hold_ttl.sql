-- 084_redemption_hold_ttl.sql
-- A pending redemption from Aug 19 was still pending on Aug 21, against a
-- 30-minute TTL, and blocked its customer from redeeming anything else: the
-- one-pending check in 080:53-61 counted it, and the customer had no cart line
-- to cancel it from. Three causes, all fixed here.
--
-- 1. expire_stale_redemptions is a self-heal on read, not a sweep (078:17-19),
--    and 080:49 was its ONLY caller. It runs when that same customer redeems
--    again at that same restaurant, and at no other time. Nothing schedules it;
--    there is no pg_cron in this project. That half is fixed outside this file,
--    in customer-auth's session action, which now runs it before reading the
--    pending redemption it reports to the client — so any page load by a
--    signed-in customer clears their own stale holds.
--
-- 2. The sweep required `code_expires_at is not null` (078:43), so a pending
--    row with a null expiry could never be swept by anything. Both insert
--    paths populate it, so such a row predates 078 or was written by hand —
--    but "unreachable by any sweep" is not a property to leave in place.
--    created_at is NOT NULL DEFAULT now() (068:67) and stands in for it.
--
-- 3. Thirty minutes was shorter than the cart holding the reward line. The
--    cart's own TTL is 2 hours (useCart.jsx:10, CART_EXPIRY_MS), so a customer
--    could redeem, get distracted for 45 minutes, and come back to a reward
--    still visible in their cart against a hold the database had already
--    killed. The hold now matches the cart: whatever the customer can still
--    see, they can still use.
--
-- No schema changes. Both functions are create-or-replace with identical
-- signatures, so nothing is dropped and no grant is disturbed.

begin;

-- ---------------------------------------------------------------
-- 1. The sweep. Unchanged from 078 except the staleness test.
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
       -- A null expiry is treated as one derived from created_at rather than
       -- as "never expires". The interval matches redeem_reward's default
       -- below; a row old enough to have no expiry at all is long past either.
       and coalesce(code_expires_at, created_at + interval '2 hours') < now()
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
-- 2. Redeem. Carried forward from 080 verbatim; only the TTL default
--    changes, from 30 minutes to 120.
-- ---------------------------------------------------------------
create or replace function redeem_reward(
  p_restaurant_id uuid,
  p_customer_id   uuid,
  p_reward_id     uuid,
  p_channel       text default 'online',
  -- 2 hours, matching CART_EXPIRY_MS in useCart.jsx:10. The caller passes no
  -- TTL (customer-auth/index.ts:1177-1185), so this default is the live value
  -- for every online redemption.
  p_ttl_minutes   integer default 120
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

commit;

-- ---------------------------------------------------------------
-- Still open after this migration
-- ---------------------------------------------------------------
-- A customer who redeems and never returns still holds their points
-- indefinitely: every sweep is scoped to one customer at one restaurant and
-- fires only on their own traffic. Nothing expires a hold for someone who
-- never comes back, and no report surfaces it. Closing that needs an unscoped
-- sweep on a schedule (pg_cron), which is a separate change — this migration
-- deliberately adds no extension and no job.
