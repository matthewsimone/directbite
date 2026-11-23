-- 106_verify.sql — READ-ONLY checks of the persisted state after migration 106. One row per check;
-- every `pass` must be true. Prints no rows of data (counts only).

with t(name) as (values ('pos_shifts'), ('pos_cash_movements'), ('pos_refunds'), ('pos_day_closes'), ('pos_entity_submissions')),
f(sig) as (values ('public.pos_entity_idem(text, uuid, integer, text)'),
                  ('public.pos_entity_store(text, uuid, integer, jsonb, uuid, jsonb, timestamp with time zone)'),
                  ('public.pos_apply_shift(jsonb, uuid, uuid, jsonb, timestamp with time zone)'),
                  ('public.pos_apply_refund(jsonb, uuid, uuid, jsonb, timestamp with time zone)'),
                  ('public.pos_apply_day_close(jsonb, uuid, uuid, jsonb, timestamp with time zone)'),
                  ('public.pos_set_shift_drawer_flags(uuid, boolean, boolean)')),
checks(check_name, pass) as (
  select 'table exists: ' || name, to_regclass('public.' || name) is not null from t
  union all
  select 'rls enabled: ' || name, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || name)), false) from t
  union all
  select 'zero policies: ' || name, (select count(*) from pg_policies where schemaname = 'public' and tablename = name) = 0 from t
  union all
  select 'no privileges: ' || g || ' on ' || name,
         case when to_regclass('public.' || name) is null then false
              else not has_table_privilege(g, 'public.' || name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') end
  from (select name from t union all select 'pos_post_z') t2 cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'service_role select + insert, no delete: ' || name,
         case when to_regclass('public.' || name) is null then false
              else has_table_privilege('service_role', 'public.' || name, 'SELECT') and has_table_privilege('service_role', 'public.' || name, 'INSERT')
                   and not has_table_privilege('service_role', 'public.' || name, 'DELETE') end
  from t
  union all
  select 'immutable (no update): ' || name,
         case when to_regclass('public.' || name) is null then false else not has_table_privilege('service_role', 'public.' || name, 'UPDATE') end
  from t where name <> 'pos_shifts'
  union all
  select 'function service_role only: ' || sig,
         case when to_regprocedure(sig) is null then false
              else has_function_privilege('service_role', sig, 'EXECUTE') and not has_function_privilege('anon', sig, 'EXECUTE')
                   and not has_function_privilege('authenticated', sig, 'EXECUTE') end
  from f
  union all
  select 'search_path pinned: ' || sig,
         exists (select 1 from pg_proc where oid = to_regprocedure(sig) and proconfig is not null and 'search_path=public' = any(proconfig))
  from f
  union all
  select 'trigger trg_pos_shifts_guard enabled',
         exists (select 1 from pg_trigger where tgname = 'trg_pos_shifts_guard' and tgrelid = to_regclass('public.pos_shifts') and tgenabled = 'O')
  union all
  select 'Z: (device, business_date, sequence) unique + supplemental CHECK',
         exists (select 1 from pg_constraint where conrelid = to_regclass('public.pos_day_closes') and contype = 'u')
         and exists (select 1 from pg_constraint where conrelid = to_regclass('public.pos_day_closes') and conname = 'pos_day_closes_supplemental')
  union all
  select 'refunds FK → pos_orders + pos_payments',
         (select count(*) from pg_constraint c where c.conrelid = to_regclass('public.pos_refunds') and c.contype = 'f'
            and c.confrelid in (to_regclass('public.pos_orders'), to_regclass('public.pos_payments'))) = 2
  union all
  select 'view pos_post_z is security_invoker',
         coalesce((select 'security_invoker=true' = any(reloptions) from pg_class where oid = to_regclass('public.pos_post_z')), false)
  union all
  select 'pos_orders.sales_day exists (104 amended)',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pos_orders' and column_name = 'sales_day' and data_type = 'date')
  union all
  select 'empty: pos_shifts (smoke rolled back)',
         case when to_regclass('public.pos_shifts') is null then false
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.pos_shifts', false, true, '')))[1]::text::int = 0 end
)
select check_name, pass from checks order by pass, check_name;
