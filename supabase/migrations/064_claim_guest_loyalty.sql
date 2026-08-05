-- 064_claim_guest_loyalty.sql
-- When a phone verifies, claim every unattached ledger row for it
-- and rebuild the per-restaurant balances from the ledger.

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

  -- Ensure a profile exists at every restaurant this phone has points at,
  -- then rebuild that profile's balance from the ledger. Recompute rather
  -- than increment: the ledger is truth, the balance is a cache.
  for v_rec in
    select restaurant_id,
           sum(points_delta)                                as balance,
           sum(points_delta) filter (where points_delta > 0) as earned,
           max(created_at)                                   as last_txn
      from loyalty_transactions
     where customer_id = p_customer_id
     group by restaurant_id
  loop
    insert into restaurant_customers (restaurant_id, customer_id)
    values (v_rec.restaurant_id, p_customer_id)
    on conflict (restaurant_id, customer_id) do nothing;

    update restaurant_customers
       set points_balance         = greatest(coalesce(v_rec.balance, 0), 0),
           lifetime_points_earned = coalesce(v_rec.earned, 0),
           last_order_at          = greatest(coalesce(last_order_at, v_rec.last_txn), v_rec.last_txn),
           updated_at             = now()
     where restaurant_id = v_rec.restaurant_id
       and customer_id   = p_customer_id;
  end loop;

  -- Backfill orders.customer_id for this phone so order history resolves.
  update orders
     set customer_id = p_customer_id
   where phone_e164 = v_phone
     and customer_id is null;

  return v_claimed;
end;
$$;

revoke all on function claim_guest_loyalty(uuid) from public, anon, authenticated;
grant execute on function claim_guest_loyalty(uuid) to service_role;

commit;