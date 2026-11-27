set lock_timeout = '3s';
-- 120_rollback.sql — undo migration 120: drop the Owner Reports index on pos_orders. Run as postgres in the SQL editor.
-- No data is touched. pos-reports keeps working without it (its sales_day read falls back to a scan of the
-- restaurant's rows) — slower on a long range, never wrong.

begin;

drop index if exists public.pos_orders_restaurant_sales_day;

commit;
