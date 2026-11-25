-- 113_verify.sql — READ-ONLY checks after migration 113. One row per check; every `pass` must be true.
--   - the two new functions + 111's begin: exist, SECURITY INVOKER, EXECUTE for service_role only.
--   - pos_online_actions: the outcome CHECK allows a pending cancel_refund (and print) only; grants unchanged
--     (select insert update — the 108 lesson, table + column level); RLS on, no policies.
--   - what 113 + the TS glue need and already have (Supabase defaults, NOT granted by 113): service_role INSERT on the
--     tablet's adjustment_requests columns; SELECT / UPDATE on the orders columns admin-refund reads / writes;
--     SELECT on the restaurants columns admin-refund reads.
--   - no pos_ FK to orders / adjustment_requests; no trigger on them calls a pos_ function; 081's loyalty reversal
--     trigger (orders, refund_status) still exists.
-- Prints no data.

with fns(sig, granted) as (values
  ('public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_online_action_finish(uuid, uuid, text, int, text, text)', true),
  ('public.pos_online_adjustment_request(uuid, uuid, uuid, uuid, text, text, bigint, text, jsonb, text, uuid, timestamptz)', true)
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
needs(rel, col, p) as (values
  ('adjustment_requests', 'order_id', 'INSERT'), ('adjustment_requests', 'order_number', 'INSERT'),
  ('adjustment_requests', 'restaurant_id', 'INSERT'), ('adjustment_requests', 'type', 'INSERT'),
  ('adjustment_requests', 'amount', 'INSERT'), ('adjustment_requests', 'note', 'INSERT'),
  ('orders', 'status', 'SELECT'), ('orders', 'order_number', 'SELECT'), ('orders', 'stripe_payment_intent_id', 'SELECT'),
  ('orders', 'uber_status', 'SELECT'), ('orders', 'delivery_fulfillment_method', 'SELECT'),
  ('orders', 'refund_status', 'UPDATE'), ('orders', 'refund_amount', 'UPDATE'), ('orders', 'refunded_at', 'UPDATE'),
  ('orders', 'refund_reason', 'UPDATE'), ('orders', 'status', 'UPDATE'), ('orders', 'cancelled_by', 'UPDATE'),
  ('orders', 'uber_status', 'UPDATE'), ('orders', 'uber_status_updated_at', 'UPDATE'),
  ('restaurants', 'stripe_account_id', 'SELECT'), ('restaurants', 'uber_customer_id', 'SELECT'),
  ('restaurants', 'uber_environment', 'SELECT'), ('restaurants', 'uber_billing_mode', 'SELECT')
),
checks(check_name, pass) as (
  select 'function exists + SECURITY INVOKER: ' || sig,
         coalesce((select not p.prosecdef from pg_proc p where p.oid = to_regprocedure(sig)), false)
  from fns
  union all
  select 'service_role HAS EXECUTE: ' || sig,
         case when to_regprocedure(sig) is null then false else has_function_privilege('service_role', sig, 'EXECUTE') end
  from fns where granted
  union all
  select 'no EXECUTE: ' || g || ' on ' || sig,
         case when to_regprocedure(sig) is null then false else not has_function_privilege(g, sig, 'EXECUTE') end
  from fns cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'outcome CHECK allows a pending cancel_refund',
         coalesce((select pg_get_constraintdef(c.oid) like '%cancel_refund%' from pg_constraint c
                    where c.conname = 'pos_online_actions_outcome_check' and c.conrelid = 'public.pos_online_actions'::regclass), false)
  union all
  select 'service_role ' || case when p in ('SELECT', 'INSERT', 'UPDATE') then 'HAS ' else 'NOT ' end || p || ' on pos_online_actions',
         has_table_privilege('service_role', 'public.pos_online_actions', p) = (p in ('SELECT', 'INSERT', 'UPDATE'))
  from priv
  union all
  select 'service_role no column ' || p || ' on pos_online_actions',
         not has_any_column_privilege('service_role', 'public.pos_online_actions', p)
  from priv where p = 'REFERENCES'
  union all
  select 'no privileges: ' || g || ' on pos_online_actions',
         not has_table_privilege(g, 'public.pos_online_actions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  from (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'RLS on, no policies: pos_online_actions',
         coalesce((select c.relrowsecurity from pg_class c where c.oid = 'public.pos_online_actions'::regclass), false)
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'pos_online_actions')
  union all
  select 'prerequisite: service_role ' || p || ' on ' || rel || '.' || col,
         has_column_privilege('service_role', 'public.' || rel, col, p)
  from needs
  union all
  select 'no pos_* FK to ' || lt,
         not exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
                      where k.contype = 'f' and k.confrelid = to_regclass('public.' || lt) and c.relname like 'pos\_%')
  from (values ('orders'), ('adjustment_requests')) x(lt)
  union all
  select 'no trigger on ' || lt || ' calls a pos_ function',
         not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                      where tg.tgrelid = to_regclass('public.' || lt) and not tg.tgisinternal and p.proname like 'pos\_%')
  from (values ('orders'), ('adjustment_requests')) x(lt)
  union all
  select 'loyalty reversal trigger on orders still calls orders_reverse_loyalty (081)',
         exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                  where tg.tgrelid = 'public.orders'::regclass and not tg.tgisinternal and p.proname = 'orders_reverse_loyalty')
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
