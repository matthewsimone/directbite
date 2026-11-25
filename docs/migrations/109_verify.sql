-- 109_verify.sql — READ-ONLY checks after migration 109. One row per check; every `pass` must be true.
--   - service_role: every table privilege (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER)
--     held iff intended, table-level AND column-level (the 108 lesson: default privileges gave ALL).
--   - anon / authenticated / public: nothing on the tables, no EXECUTE on the functions.
--   - service_role: EXECUTE on the 5 callable functions; all 8 functions (incl. 3 trigger functions) SECURITY INVOKER.
--   - RLS on, no policies; the 3 guard triggers exist.
--   - NO foreign key from a 109 table to orders (or anything but restaurants / pos_devices / pos_staff), and
--     109 added nothing to orders / order_items / order_item_toppings / print_logs / adjustment_requests
--     (no trigger on them names a pos_ function).
-- Prints no data.

with intended(rel, privs) as (values
  ('pos_restaurant_settings', array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_online_print_claims', array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_online_print_log',    array['SELECT', 'INSERT']),
  ('pos_online_actions',      array['SELECT', 'INSERT', 'UPDATE'])
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
fns(sig, granted) as (values
  ('public.pos_set_print_register(uuid, uuid, text)', true),
  ('public.pos_claim_online_print(uuid, uuid, uuid)', true),
  ('public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb)', true),
  ('public.pos_online_action_begin(uuid, uuid, uuid, uuid, uuid, text, jsonb)', true),
  ('public.pos_online_action_complete(uuid, uuid, jsonb, int)', true),
  ('public.pos_restaurant_settings_guard()', false),
  ('public.pos_online_print_claims_guard()', false),
  ('public.pos_online_actions_guard()', false)
),
checks(check_name, pass) as (
  select 'service_role ' || case when p = any(privs) then 'HAS ' else 'NOT ' end || p || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else has_table_privilege('service_role', 'public.' || rel, p) = (p = any(privs)) end
  from intended cross join priv
  union all
  select 'service_role no column ' || p || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not has_any_column_privilege('service_role', 'public.' || rel, p) end
  from intended cross join priv
  where p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and not (p = any(privs))
  union all
  select 'no privileges: ' || g || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not has_table_privilege(g, 'public.' || rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') end
  from intended cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'RLS on, no policies: ' || rel,
         coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || rel)), false)
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = rel)
  from intended
  union all
  select 'function exists + SECURITY INVOKER: ' || sig,
         coalesce((select not p.prosecdef from pg_proc p where p.oid = to_regprocedure(sig)), false)
  from fns
  union all
  select 'service_role HAS EXECUTE: ' || sig,
         case when to_regprocedure(sig) is null then false
              else has_function_privilege('service_role', sig, 'EXECUTE') end
  from fns where granted
  union all
  select 'no EXECUTE: ' || g || ' on ' || sig,
         case when to_regprocedure(sig) is null then false
              else not has_function_privilege(g, sig, 'EXECUTE') end
  from fns cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'guard trigger exists: ' || t,
         exists (select 1 from pg_trigger where tgname = t and not tgisinternal)
  from (values ('trg_pos_restaurant_settings_guard'), ('trg_pos_online_print_claims_guard'), ('trg_pos_online_actions_guard')) x(t)
  union all
  -- every FK out of the 109 tables points only at restaurants / pos_devices / pos_staff (never orders)
  select 'FK targets only restaurants / pos_devices / pos_staff: ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not exists (select 1 from pg_constraint k
                                where k.contype = 'f' and k.conrelid = to_regclass('public.' || rel)
                                  and k.confrelid not in ('public.restaurants'::regclass, 'public.pos_devices'::regclass, 'public.pos_staff'::regclass)) end
  from intended
  union all
  -- nothing references orders from a pos_ table, and no trigger on a live-path table calls a pos_ function
  select 'no pos_* FK to ' || lt,
         not exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
                      where k.contype = 'f' and k.confrelid = to_regclass('public.' || lt) and c.relname like 'pos\_%')
  from (values ('orders'), ('order_items'), ('order_item_toppings'), ('print_logs'), ('adjustment_requests')) y(lt)
  union all
  select 'no trigger on ' || lt || ' calls a pos_ function',
         not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                      where tg.tgrelid = to_regclass('public.' || lt) and not tg.tgisinternal and p.proname like 'pos\_%')
  from (values ('orders'), ('order_items'), ('order_item_toppings'), ('print_logs'), ('adjustment_requests')) y(lt)
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
