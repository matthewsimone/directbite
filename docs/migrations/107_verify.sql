-- 107_verify.sql — READ-ONLY checks after migration 107. Every `pass` must be true. Prints no row data.

with checks(check_name, pass) as (
  select 'pos_payments.void_reason exists (text, nullable)',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pos_payments'
                   and column_name = 'void_reason' and data_type = 'text' and is_nullable = 'YES')
  union all
  select 'CHECK pos_payments_void_reason_length present',
         exists (select 1 from pg_constraint where conrelid = to_regclass('public.pos_payments') and conname = 'pos_payments_void_reason_length' and convalidated)
  union all
  select 'CHECK text = null or 1–500 chars',
         coalesce((select pg_get_constraintdef(oid) ilike '%char_length(void_reason)%1%500%' from pg_constraint
                    where conrelid = to_regclass('public.pos_payments') and conname = 'pos_payments_void_reason_length'), false)
  union all
  select 'pos_apply_order_submission signature unchanged',
         to_regprocedure('public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamp with time zone, date)') is not null
  union all
  select 'no stored row breaks the rule',
         case when to_regclass('public.pos_payments') is null then false
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.pos_payments where void_reason is not null and char_length(void_reason) not between 1 and 500', false, true, '')))[1]::text::int = 0 end
)
select check_name, pass from checks order by pass, check_name;
