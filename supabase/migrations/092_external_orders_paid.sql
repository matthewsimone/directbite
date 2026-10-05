-- 092_external_orders_paid.sql
-- KitchenHub order.paid. Nullable on purpose: null = the provider did not say
-- (rows ingested before this column, or events without the field).
-- No new grants: the tablet reads it through the existing table-level SELECT
-- on external_orders; only kh-webhook (service role) writes it.
alter table public.external_orders
  add column if not exists paid boolean;
