-- 066_loyalty_admin_policies.sql
-- Admin panel reads/writes loyalty config and browses the ledger via the
-- client, matching how every other admin tab works. anon stays revoked.
-- The ledger is read-only even for admins: it is append-only truth, and
-- adjustments must be written as new rows, never edits.

begin;

grant select, insert, update, delete on restaurant_loyalty_tiers to authenticated;
grant select on loyalty_transactions to authenticated;

drop policy if exists admin_all_loyalty_tiers on restaurant_loyalty_tiers;
create policy admin_all_loyalty_tiers on restaurant_loyalty_tiers
  for all to authenticated
  using (is_admin())
  with check (is_admin());

drop policy if exists admin_read_loyalty_transactions on loyalty_transactions;
create policy admin_read_loyalty_transactions on loyalty_transactions
  for select to authenticated
  using (is_admin());

commit;