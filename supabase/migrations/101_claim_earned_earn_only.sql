-- 101_claim_earned_earn_only.sql
-- 088:87 widened `earned` back to every positive delta, undoing 083:346-348.
-- Returned redemptions (079:47 cart cancel, 084:71 expired hold, 081:82 full
-- refund) are positive 'refund' rows and were being counted as lifetime earned,
-- inflating lifetime_points_earned, the displayed tier (AccountView derives it
-- from lifetime) and the accrual multiplier (083:245). Earn-only again, matching
-- the accrual trigger's increment (083:287). Everything else is 088 verbatim.
-- No backfill here: a fixed claim corrects a row only on that customer's next
-- verification. Repairing existing rows is a separate, reviewed step.

begin;

create or replace function claim_guest_loyalty(p_customer_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_phone   text;
  v_claimed integer := 0;
  v_rec     record;
  v_name    text;
  v_email   text;
  v_addr    text;
  v_addr_at timestamptz;
begin
  select phone_e164 into v_phone
    from customer_identities where id = p_customer_id;

  if v_phone is null then
    return 0;
  end if;

  -- Attach orphaned ledger rows to this identity.
  update loyalty_transactions
     set customer_id = p_customer_id
   where phone_e164 = v_phone
     and customer_id is null;

  get diagnostics v_claimed = row_count;

  -- Backfill orders.customer_id for this phone. MOVED AHEAD of the profile
  -- loop below, which now reads these rows: leaving it at the end would make
  -- the first claim count only orders that were already linked.
  update orders
     set customer_id = p_customer_id
   where phone_e164 = v_phone
     and customer_id is null;

  -- Every restaurant this customer has a ledger row OR an order at. The union
  -- is what lets a loyalty-disabled restaurant get a profile row and a count.
  for v_rec in
    select rid.restaurant_id,
           lt.balance,
           lt.earned,
           lt.last_txn,
           ord.cnt,
           ord.first_at,
           ord.last_at
      from (
             select restaurant_id from loyalty_transactions where customer_id = p_customer_id
             union
             select restaurant_id from orders               where customer_id = p_customer_id
           ) rid
      left join (
             select restaurant_id,
                    sum(points_delta)                                 as balance,
                    sum(points_delta) filter (where reason = 'earn' and points_delta > 0) as earned,
                    max(created_at)                                   as last_txn
               from loyalty_transactions
              where customer_id = p_customer_id
              group by restaurant_id
           ) lt on lt.restaurant_id = rid.restaurant_id
      left join (
             select restaurant_id,
                    count(*)        as cnt,
                    min(created_at) as first_at,
                    max(created_at) as last_at
               from orders
              where customer_id = p_customer_id
              group by restaurant_id
           ) ord on ord.restaurant_id = rid.restaurant_id
  loop
    insert into restaurant_customers (restaurant_id, customer_id)
    values (v_rec.restaurant_id, p_customer_id)
    on conflict (restaurant_id, customer_id) do nothing;

    update restaurant_customers
       set -- Ledger fields ONLY when this customer has ledger rows here. A
           -- restaurant reached through the orders half of the union has a
           -- null balance, and recomputing it to zero would wipe a real one.
           points_balance         = case when v_rec.balance is not null
                                         then greatest(v_rec.balance, 0)
                                         else points_balance end,
           lifetime_points_earned = case when v_rec.earned is not null
                                         then v_rec.earned
                                         else lifetime_points_earned end,
           tier_level             = case when v_rec.earned is not null
                                         then resolve_tier_level(v_rec.restaurant_id, v_rec.earned::integer)
                                         else tier_level end,
           -- Derived stats: rebuilt, not filled. This is the 4-against-25.
           order_count            = coalesce(v_rec.cnt::integer, order_count),
           -- least() ignores nulls, so a null column takes the order value and
           -- a set one can only move earlier — a correction, never a regression.
           first_order_at         = least(first_order_at, v_rec.first_at),
           -- greatest() likewise: never moves backwards.
           last_order_at          = greatest(last_order_at, v_rec.last_txn, v_rec.last_at),
           updated_at             = now()
     where restaurant_id = v_rec.restaurant_id
       and customer_id   = p_customer_id;
  end loop;

  -- ---- Identity saved contact, filled from order history ------------------
  -- Each field picks its own source row: a pickup order carries a name and an
  -- email but no address, so one "most recent order" would strand the address
  -- behind any later pickup.

  -- Names under three characters are skipped. An earlier path wrote initials
  -- like "A" and "C" into profiles permanently; a too-short name from order
  -- history is far more likely to be a placeholder than a real one, and
  -- leaving the field null lets the customer set it properly later.
  select btrim(name_col)
    into v_name
    from (
      select (array_agg(customer_name order by created_at desc)
                filter (where length(btrim(customer_name)) >= 3))[1] as name_col
        from orders
       where customer_id = p_customer_id
    ) s;

  select (array_agg(btrim(customer_email) order by created_at desc)
            filter (where nullif(btrim(customer_email), '') is not null))[1]
    into v_email
    from orders
   where customer_id = p_customer_id;

  -- Delivery orders only — a pickup order has no address to take. The
  -- timestamp comes from the same row, so address_updated_at reflects when the
  -- customer actually last used the address rather than when we copied it.
  select (array_agg(btrim(delivery_address) order by created_at desc)
            filter (where nullif(btrim(delivery_address), '') is not null))[1],
         (array_agg(created_at order by created_at desc)
            filter (where nullif(btrim(delivery_address), '') is not null))[1]
    into v_addr, v_addr_at
    from orders
   where customer_id = p_customer_id
     and order_type  = 'delivery';

  -- case/when rather than coalesce(nullif(...)): coalesce would hand back the
  -- TRIMMED existing value and quietly rewrite what the customer typed. These
  -- branches leave a set value byte-identical.
  --
  -- delivery_apt, delivery_lat and delivery_lng are absent by necessity, not
  -- oversight: orders carries only customer_name, customer_phone,
  -- customer_email and delivery_address. There is nothing to read them from.
  update customer_identities
     set display_name = case
           when nullif(btrim(display_name), '') is null then v_name
           else display_name end,
         email = case
           when nullif(btrim(email), '') is null then v_email
           else email end,
         delivery_address = case
           when nullif(btrim(delivery_address), '') is null then v_addr
           else delivery_address end,
         address_updated_at = case
           when nullif(btrim(delivery_address), '') is null and v_addr is not null
             then v_addr_at
           else address_updated_at end,
         updated_at = now()
   where id = p_customer_id;

  return v_claimed;
end;
$$;

revoke all on function claim_guest_loyalty(uuid) from public, anon, authenticated;
grant execute on function claim_guest_loyalty(uuid) to service_role;

commit;
