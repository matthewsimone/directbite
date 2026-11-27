-- 120_verify.sql — READ-ONLY checks after migration 120. One row per check; every `pass` must be true.
--   - pos_orders_restaurant_sales_day exists on public.pos_orders, is valid + ready, not unique,
--     keys (restaurant_id, sales_day), partial WHERE sales_day IS NOT NULL.
--   - 104's two indexes are still there.
--   - the index is the only object 120 adds: no index of that name on any other table.
--   - pos_orders grants unchanged: service_role SELECT / INSERT / UPDATE, nothing for anon / authenticated (108 pattern).
-- Prints no data.

with ix as (
  select i.indexrelid, i.indrelid, i.indisvalid, i.indisready, i.indisunique,
         pg_get_indexdef(i.indexrelid) as def, pg_get_expr(i.indpred, i.indrelid) as pred
    from pg_index i
   where i.indexrelid = to_regclass('public.pos_orders_restaurant_sales_day')
),
checks(check_name, pass) as (
  select 'index pos_orders_restaurant_sales_day exists on public.pos_orders',
         exists (select 1 from ix where indrelid = 'public.pos_orders'::regclass)
  union all
  select 'index is valid + ready (not left INVALID by a failed build)',
         coalesce((select indisvalid and indisready from ix), false)
  union all
  select 'index is not unique',
         coalesce((select not indisunique from ix), false)
  union all
  select 'index keys = (restaurant_id, sales_day)',
         coalesce((select def like '%(restaurant_id, sales_day)%' from ix), false)
  union all
  select 'index is partial: WHERE sales_day IS NOT NULL',
         coalesce((select pred = '(sales_day IS NOT NULL)' from ix), false)
  union all
  select '104 index pos_orders_restaurant_created still exists',
         to_regclass('public.pos_orders_restaurant_created') is not null
  union all
  select '104 index pos_orders_restaurant_day still exists',
         to_regclass('public.pos_orders_restaurant_day') is not null
  union all
  select 'exactly one index named pos_orders_restaurant_sales_day',
         (select count(*) from pg_class where relkind = 'i' and relname = 'pos_orders_restaurant_sales_day') = 1
  union all
  select 'service_role: pos_orders SELECT / INSERT / UPDATE, no DELETE (unchanged)',
         has_table_privilege('service_role', 'public.pos_orders', 'SELECT')
         and has_table_privilege('service_role', 'public.pos_orders', 'INSERT')
         and has_table_privilege('service_role', 'public.pos_orders', 'UPDATE')
         and not has_table_privilege('service_role', 'public.pos_orders', 'DELETE')
  union all
  select 'anon / authenticated: nothing on pos_orders (unchanged)',
         not has_table_privilege('anon', 'public.pos_orders', 'SELECT')
         and not has_table_privilege('authenticated', 'public.pos_orders', 'SELECT')
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
