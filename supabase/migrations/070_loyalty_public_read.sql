-- 070_loyalty_public_read.sql
-- The customer rewards page reads tiers and the active reward catalog with
-- the anon key. 066 and 068 revoked anon from both tables because only the
-- admin panel touched them; a public page changes that.
--
-- Scope is deliberately narrow: read-only, and only for restaurants that
-- have actually enabled loyalty. Nothing customer-identifying is exposed —
-- loyalty_transactions, loyalty_redemptions, restaurant_customers and
-- customer_identities all stay revoked.

begin;

grant select on restaurant_loyalty_tiers to anon;
grant select on loyalty_rewards to anon;

drop policy if exists anon_read_loyalty_tiers on restaurant_loyalty_tiers;
create policy anon_read_loyalty_tiers on restaurant_loyalty_tiers
  for select to anon
  using (
    exists (
      select 1 from restaurants r
       where r.id = restaurant_loyalty_tiers.restaurant_id
         and r.loyalty_enabled = true
    )
  );

drop policy if exists anon_read_loyalty_rewards on loyalty_rewards;
create policy anon_read_loyalty_rewards on loyalty_rewards
  for select to anon
  using (
    active = true
    and exists (
      select 1 from restaurants r
       where r.id = loyalty_rewards.restaurant_id
         and r.loyalty_enabled = true
    )
  );

commit;