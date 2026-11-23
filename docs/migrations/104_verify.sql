-- 104_verify.sql — READ-ONLY checks of the persisted state after migration 104. One row per check;
-- every `pass` must be true. Prints no order data (counts only).

with t(name) as (values ('pos_orders'), ('pos_order_lines'), ('pos_order_line_modifiers'), ('pos_payments'), ('pos_order_submissions')),
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
  from t cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'service_role can select + insert: ' || name,
         case when to_regclass('public.' || name) is null then false
              else has_table_privilege('service_role', 'public.' || name, 'SELECT') and has_table_privilege('service_role', 'public.' || name, 'INSERT') end
  from t
  union all
  select 'service_role cannot delete: ' || name,
         case when to_regclass('public.' || name) is null then false else not has_table_privilege('service_role', 'public.' || name, 'DELETE') end
  from t where name in ('pos_orders', 'pos_payments', 'pos_order_submissions')
  union all
  select 'pos_order_submissions immutable (no update for service_role)',
         case when to_regclass('public.pos_order_submissions') is null then false
              else not has_table_privilege('service_role', 'public.pos_order_submissions', 'UPDATE') end
  union all
  select 'sequence pos_order_number_seq: service_role usage, anon none',
         case when to_regclass('public.pos_order_number_seq') is null then false
              else has_sequence_privilege('service_role', 'public.pos_order_number_seq', 'USAGE')
                   and not has_sequence_privilege('anon', 'public.pos_order_number_seq', 'USAGE') end
  union all
  select 'function pos_apply_order_submission: service_role only',
         case when to_regprocedure('public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz)') is null then false
              else has_function_privilege('service_role', 'public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz)', 'EXECUTE')
                   and not has_function_privilege('anon', 'public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz)', 'EXECUTE')
                   and not has_function_privilege('authenticated', 'public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz)', 'EXECUTE') end
  union all
  select 'function search_path pinned: pos_apply_order_submission',
         exists (select 1 from pg_proc where oid = to_regprocedure('public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz)')
                 and proconfig is not null and 'search_path=public' = any(proconfig))
  union all
  select 'trigger trg_pos_payments_guard enabled',
         exists (select 1 from pg_trigger where tgname = 'trg_pos_payments_guard' and tgrelid = to_regclass('public.pos_payments') and tgenabled = 'O')
  union all
  select 'card CHECKs on pos_payments (cash no card fields, card no change, last4, ref ≤ 40)',
         (select count(*) from pg_constraint where conrelid = to_regclass('public.pos_payments') and contype = 'c'
            and (conname in ('pos_payments_cash_no_card', 'pos_payments_card_no_change')
                 or pg_get_constraintdef(oid) ilike '%last4%' or pg_get_constraintdef(oid) ilike '%external_ref%')) >= 4
  union all
  select 'priced_against_hash FK → pos_menu_snapshots',
         exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.pos_orders') and c.contype = 'f'
                 and pg_get_constraintdef(c.oid) ilike '%pos_menu_snapshots(hash)%')
  union all
  select 'web orders table untouched by POS (no FK from pos_* to orders)',
         not exists (select 1 from pg_constraint c where c.contype = 'f' and c.confrelid = to_regclass('public.orders')
                     and c.conrelid in (select to_regclass('public.' || name) from t))
  union all
  select 'empty: pos_orders (smoke rolled back)',
         case when to_regclass('public.pos_orders') is null then false
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.pos_orders', false, true, '')))[1]::text::int = 0 end
)
select check_name, pass from checks order by pass, check_name;
