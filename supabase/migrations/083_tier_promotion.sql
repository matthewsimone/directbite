-- 083_tier_promotion.sql
-- ============================================================
-- Tier promotion. Until now restaurant_customers.tier_level was created with
-- a default of 1 (063:79) and never written by anything, threshold_points was
-- never compared against anything, and so calculate_loyalty_points always
-- resolved its multiplier lookup to tier 1 — in practice 1.000, the seeded
-- default. Every multiplier a restaurant configured was inert.
--
-- THE MODEL
-- Tier is DERIVED from lifetime_points_earned against the CURRENT
-- threshold_points, never stored as truth. A restaurant that lowers a
-- threshold promotes everyone above it on the next read, with no migration
-- and no recompute. Boundary is >=: landing exactly on 1,000 makes you Plus.
--
-- SPLIT EARNING
-- An order that crosses a boundary earns at both rates. A customer at 950
-- lifetime with Plus at 1,000, placing an order worth 200 base points, earns
-- 50 at Standard's 1.0x and 150 at Plus's 1.15x — 222.5, floored once to 222.
-- Multiple crossings in one order loop the ladder; nothing caps at one.
--
-- THE BOUNDARY IS IN AWARDED POINTS, NOT BASE POINTS
-- This is the subtlety the worked example above hides, because Standard's
-- multiplier is 1.0 and the two spaces coincide. lifetime_points_earned
-- advances by the AWARDED figure, multiplier included, so a segment's own
-- multiplier decides how much BASE it takes to reach the next threshold:
-- at 2.0x a customer 50 points short crosses after 25 base points, not 50.
-- Hence base_needed = gap / multiplier throughout.
--
-- ALREADY APPLIED LIVE? NO. Unlike 077 and 082 this file has not been run;
-- it is the source of the change, not a record of one.
-- ============================================================

begin;

-- ---------------------------------------------------------------
-- 1. Tier resolution. One definition of "which tier is this
--    lifetime figure in", used by the accrual trigger below and
--    mirrored by AccountView for display.
-- ---------------------------------------------------------------
-- Ordered by threshold, NOT by tier_level: nothing constrains the ladder to
-- be monotonic (see the note at the end of this file), and the threshold is
-- what the customer actually crossed. tier_level breaks ties so the result is
-- deterministic when two tiers share a threshold.
--
-- No tier rows, or a lifetime below the lowest threshold, both fall back to 1
-- — matching the coalesce that 063:145 has always applied.
create or replace function resolve_tier_level(
  p_restaurant_id uuid,
  p_lifetime      integer
)
returns smallint
language sql
stable
as $$
  select coalesce(
    (select t.tier_level
       from restaurant_loyalty_tiers t
      where t.restaurant_id = p_restaurant_id
        and t.threshold_points <= greatest(coalesce(p_lifetime, 0), 0)
      order by t.threshold_points desc, t.tier_level desc
      limit 1),
    1::smallint
  );
$$;

revoke all on function resolve_tier_level(uuid, integer) from public, anon, authenticated;
grant execute on function resolve_tier_level(uuid, integer) to service_role;

-- ---------------------------------------------------------------
-- 2. The formula. Replaces the tier_level parameter with the
--    lifetime figure the tier is derived from.
-- ---------------------------------------------------------------
-- DROP, not CREATE OR REPLACE: the middle parameter changes type, so a
-- replace would leave the old smallint version callable as an overload and
-- every existing caller would silently keep the un-split arithmetic. The
-- grants from 063:257-258 do not survive the drop and are reapplied below.
drop function if exists calculate_loyalty_points(uuid, smallint, integer);

create function calculate_loyalty_points(
  p_restaurant_id   uuid,
  p_lifetime_points integer,
  p_basis_cents     integer
)
returns integer
language plpgsql
stable
as $$
declare
  v_enabled   boolean;
  v_rate      numeric(6,2);
  v_remaining numeric;          -- base points still to be awarded
  v_lifetime  numeric;          -- position on the ladder, in awarded points
  v_awarded   numeric := 0;     -- running total, NEVER floored mid-loop
  v_mult      numeric(5,3);
  v_next      integer;
  v_gap       numeric;
  v_base_need numeric;
  v_guard     integer := 0;
begin
  if p_basis_cents is null or p_basis_cents <= 0 then
    return 0;
  end if;

  select loyalty_enabled, loyalty_points_per_dollar
    into v_enabled, v_rate
    from restaurants where id = p_restaurant_id;

  if not coalesce(v_enabled, false) then
    return 0;
  end if;

  v_remaining := (p_basis_cents::numeric / 100.0) * v_rate;
  v_lifetime  := greatest(coalesce(p_lifetime_points, 0), 0);

  loop
    -- tier_level is constrained to 1..5 (063:32), so six iterations cannot be
    -- legitimate. The guard exists for a malformed ladder — duplicate or
    -- non-monotonic thresholds — where the walk might otherwise not advance.
    v_guard := v_guard + 1;
    exit when v_guard > 6;

    -- Current tier: highest threshold at or below where we stand. `<=` is the
    -- >= boundary from the customer's side — reaching a threshold exactly
    -- means you are in that tier.
    select t.multiplier into v_mult
      from restaurant_loyalty_tiers t
     where t.restaurant_id = p_restaurant_id
       and t.threshold_points <= v_lifetime
     order by t.threshold_points desc, t.tier_level desc
     limit 1;
    v_mult := coalesce(v_mult, 1.000);

    select min(t.threshold_points) into v_next
      from restaurant_loyalty_tiers t
     where t.restaurant_id = p_restaurant_id
       and t.threshold_points > v_lifetime;

    -- Top of the ladder, or no ladder at all: everything left earns here.
    if v_next is null then
      v_awarded := v_awarded + v_remaining * v_mult;
      exit;
    end if;

    v_gap := v_next::numeric - v_lifetime;
    -- Base points required to produce that many awarded points. multiplier is
    -- constrained >= 1.000 (063:33), so this can never divide by zero.
    v_base_need := v_gap / v_mult;

    -- Not enough left to reach the next threshold: finish in this tier.
    if v_remaining <= v_base_need then
      v_awarded := v_awarded + v_remaining * v_mult;
      exit;
    end if;

    -- Cross. Landing exactly ON the threshold is what puts the next iteration
    -- into the higher tier.
    v_awarded   := v_awarded + v_gap;
    v_lifetime  := v_next;
    v_remaining := v_remaining - v_base_need;
  end loop;

  -- Floor ONCE, on the summed raw segments — never per segment. Two segments
  -- of 0.6 are worth a point together and nothing apart.
  return floor(v_awarded)::integer;
end;
$$;

revoke all on function calculate_loyalty_points(uuid, integer, integer) from public, anon, authenticated;
grant execute on function calculate_loyalty_points(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------
-- 3. Accrual. Same trigger, same exception safety as 074; it now
--    passes the lifetime figure and records where the customer
--    landed.
-- ---------------------------------------------------------------
create or replace function orders_accrue_loyalty()
returns trigger
language plpgsql
security definer
as $$
declare
  v_enabled      boolean;
  v_basis_mode   text;
  v_rate         numeric(6,2);
  v_basis_cents  integer;
  v_customer_id  uuid;
  v_lifetime     integer := 0;
  v_tier_level   smallint := 1;
  v_base_points  numeric;
  v_multiplier   numeric(5,3);
  v_points       integer;
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

    -- Where they stood BEFORE this order. This replaces the tier_level read
    -- 074:76-79 used to do: tier is no longer stored truth, it is derived from
    -- this figure, so this is the value the ladder walks from.
    select lifetime_points_earned into v_lifetime
      from restaurant_customers
     where restaurant_id = new.restaurant_id and customer_id = v_customer_id;
    v_lifetime := greatest(coalesce(v_lifetime, 0), 0);

    -- The tier they STARTED in. Recorded on the ledger row below as the tier
    -- the order was placed at; the order may finish in a higher one.
    v_tier_level := resolve_tier_level(new.restaurant_id, v_lifetime);

    v_points := calculate_loyalty_points(new.restaurant_id, v_lifetime, v_basis_cents);

    if v_points <= 0 then
      return new;
    end if;

    -- The BLENDED rate actually applied. A split order has no single
    -- multiplier, so recording the starting tier's would misstate what was
    -- awarded; awarded/base reconstructs the figure exactly and stays inside
    -- numeric(5,3) because multipliers are capped at 10.000 (063:33).
    v_base_points := (v_basis_cents::numeric / 100.0) * v_rate;
    v_multiplier  := case
                       when v_base_points > 0 then round(v_points::numeric / v_base_points, 3)
                       else 1.000
                     end;

    insert into loyalty_transactions (
      restaurant_id, customer_id, phone_e164, order_id, reason,
      points_delta, basis_cents, rate_per_dollar, tier_level, tier_multiplier
    ) values (
      new.restaurant_id, v_customer_id, new.phone_e164, new.id, 'earn',
      v_points, v_basis_cents, v_rate, v_tier_level, v_multiplier
    )
    on conflict do nothing;

    if v_customer_id is not null then
      -- tier_level here is a CACHE of where this order left them, for admin
      -- queries and support. It is NOT the source of truth and must not be
      -- rendered: a restaurant lowering a threshold promotes customers who
      -- have not ordered since, and this column would not know. Every display
      -- surface derives the tier from lifetime_points_earned instead.
      update restaurant_customers
         set points_balance         = points_balance + v_points,
             lifetime_points_earned = lifetime_points_earned + v_points,
             tier_level             = resolve_tier_level(new.restaurant_id, lifetime_points_earned + v_points),
             updated_at             = now()
       where restaurant_id = new.restaurant_id and customer_id = v_customer_id;
    end if;

  exception when others then
    raise warning 'loyalty accrual failed for order %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 4. claim_guest_loyalty: correct what "earned" means.
-- ---------------------------------------------------------------
-- Unchanged from 064 except the `earned` aggregate at 064:38, which summed
-- EVERY positive delta. A full refund writes two rows: the earn reversal as a
-- negative (081:62) and the returned redemption points as a POSITIVE
-- (081:82). So a customer who earned 200, redeemed 100 and was refunded had
-- lifetime rebuilt to 300 here while the incremental counter at 074:104 said
-- 200 — and this runs on every verification (customer-auth/index.ts:407).
--
-- That was cosmetic while nothing read lifetime. Now that tier is derived from
-- it, and no demotion is possible, it would hand out a permanent promotion
-- nobody earned. Scoping to reason = 'earn' makes this recompute agree with
-- what the accrual trigger accumulates.
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
           sum(points_delta) filter (
             where reason = 'earn' and points_delta > 0
           )                                                as earned,
           max(created_at)                                  as last_txn
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
           tier_level             = resolve_tier_level(v_rec.restaurant_id, coalesce(v_rec.earned, 0)::integer),
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

-- ---------------------------------------------------------------
-- 5. NOT ADDED: the threshold-ordering constraint.
-- ---------------------------------------------------------------
-- "thresholds must increase with tier_level" compares one row against OTHER
-- rows of the same table, which a CHECK constraint cannot do — CHECK sees a
-- single row. Enforcing it would take a statement-level trigger or an
-- exclusion constraint, neither of which is the clean check this was
-- conditional on, and both of which can fail a legitimate multi-row save:
-- LoyaltyTab.jsx:491-503 writes tiers as independent concurrent UPDATEs, so
-- any intermediate state during a reorder would be rejected.
--
-- Left unenforced deliberately. The arithmetic above is defensive instead: it
-- orders by threshold rather than tier_level, so a non-monotonic ladder still
-- walks in the direction the customer actually travels, and the iteration
-- guard bounds a ladder that fails to advance.

commit;
