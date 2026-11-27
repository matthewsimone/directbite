set lock_timeout = '3s';
-- 120_pos_orders_sales_day_index.sql — Owner Reports v1 (pos-reports): read a restaurant's POS orders by business day.
-- pos-reports reads pos_orders WHERE restaurant_id = $1 AND sales_day BETWEEN $2 AND $3 (_shared/pos-reports/store.ts);
-- 104 indexes (restaurant_id, created_at desc) and (restaurant_id, ticket_business_date) only.
--
-- pos_* ONLY: one index on pos_orders. Nothing on orders / order_items / external_orders / restaurants or any
-- live-path table; no column, trigger, default, constraint, function or grant changes (an index needs no grant).
--
-- Not CONCURRENTLY (it cannot run inside a transaction): pos_orders is small and lock_timeout bounds the brief write
-- lock — if it can't get the lock in 3 s the migration fails cleanly and can simply be run again.
--
-- NOT APPLIED. Needs 104 (pos_orders.sales_day). Rollback: docs/migrations/120_rollback.sql.
-- Smoke: docs/migrations/120_smoke.sql. Verify: docs/migrations/120_verify.sql.

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pos_orders' and column_name = 'sales_day') then
    raise exception '120: needs 104 (pos_orders.sales_day)' using errcode = '55000';
  end if;
end;
$$;

create index pos_orders_restaurant_sales_day on public.pos_orders (restaurant_id, sales_day) where sales_day is not null;

comment on index public.pos_orders_restaurant_sales_day is
  'Owner Reports (pos-reports): a restaurant''s closed / voided POS orders by business day (sales_day).';

commit;
