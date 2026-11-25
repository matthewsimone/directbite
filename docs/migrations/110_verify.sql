-- 110_verify.sql — READ-ONLY checks after migration 110. One row per check; every `pass` must be true.
--   - service_role: every table privilege (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) on the
--     four 110 tables held iff intended, table-level AND column-level (the 108 lesson).
--   - anon / authenticated / public: nothing on the tables, no EXECUTE on the functions.
--   - service_role: EXECUTE on the 3 new callable functions; every 110 function SECURITY INVOKER;
--     109's pos_claim_online_print(uuid,uuid,uuid) and pos_finish_online_print(…) are gone.
--   - the reshaped columns: claims (order_channel, printed_at; no attempt / finished_at), log (order_channel, action_id,
--     variant, station, error, device_time; no attempt), settings (the 3 flags), stations (handoff columns).
--   - RLS on, no policies; the guard triggers exist (stations: update + delete).
--   - NO foreign key from a pos_ table to orders / order_items / order_item_toppings / print_logs /
--     adjustment_requests / external_orders, and no trigger on those tables calls a pos_ function.
-- Prints no data.

with intended(rel, privs) as (values
  ('pos_restaurant_settings',   array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_online_print_claims',   array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_online_print_stations', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_online_print_log',      array['SELECT', 'INSERT'])
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
fns(sig, granted) as (values
  ('public.pos_claim_online_print(uuid, text, uuid, uuid, jsonb, boolean)', true),
  ('public.pos_record_online_print(uuid, text, uuid, uuid, uuid, text, text, jsonb, text, timestamptz)', true),
  ('public.pos_online_print_state(uuid, uuid[])', true),
  ('public.pos_online_print_claims_guard()', false),
  ('public.pos_online_print_stations_guard()', false)
),
cols(rel, col, present) as (values
  ('pos_online_print_claims', 'order_channel', true), ('pos_online_print_claims', 'printed_at', true),
  ('pos_online_print_claims', 'device_id', true), ('pos_online_print_claims', 'result', true),
  ('pos_online_print_claims', 'attempt', false), ('pos_online_print_claims', 'finished_at', false),
  ('pos_online_print_log', 'order_channel', true), ('pos_online_print_log', 'action_id', true),
  ('pos_online_print_log', 'variant', true), ('pos_online_print_log', 'station', true),
  ('pos_online_print_log', 'error', true), ('pos_online_print_log', 'device_time', true),
  ('pos_online_print_log', 'attempt', false),
  ('pos_restaurant_settings', 'pos_online_orders_enabled', true), ('pos_restaurant_settings', 'online_auto_print_enabled', true),
  ('pos_restaurant_settings', 'kitchenhub_auto_print_enabled', true),
  ('pos_online_print_stations', 'order_channel', true), ('pos_online_print_stations', 'order_id', true),
  ('pos_online_print_stations', 'station', true), ('pos_online_print_stations', 'restaurant_id', true),
  ('pos_online_print_stations', 'name', true), ('pos_online_print_stations', 'lines', true),
  ('pos_online_print_stations', 'position', true), ('pos_online_print_stations', 'result', true),
  ('pos_online_print_stations', 'printed_at', true)
),
live(lt) as (values ('orders'), ('order_items'), ('order_item_toppings'), ('print_logs'), ('adjustment_requests'), ('external_orders')),
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
  select '109 function dropped: ' || sig, to_regprocedure(sig) is null
  from (values ('public.pos_claim_online_print(uuid, uuid, uuid)'),
               ('public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb)')) x(sig)
  union all
  select case when present then 'column present: ' else 'column gone: ' end || rel || '.' || col,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = rel and column_name = col) = present
  from cols
  union all
  select 'primary key ' || rel || ' (' || k || ')',
         coalesce((select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
                     from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                    where c.conrelid = to_regclass('public.' || rel) and c.contype = 'p'), '') = k
  from (values ('pos_online_print_claims', 'order_channel,order_id'),
               ('pos_online_print_stations', 'order_channel,order_id,station')) y(rel, k)
  union all
  select 'pos_online_print_log.action_id unique',
         exists (select 1 from pg_constraint where conname = 'pos_online_print_log_action_id_key'
                    and conrelid = 'public.pos_online_print_log'::regclass and contype = 'u')
  union all
  select 'guard trigger exists: ' || t,
         exists (select 1 from pg_trigger where tgname = t and not tgisinternal)
  from (values ('trg_pos_online_print_claims_guard'), ('trg_pos_online_print_stations_guard')) x(t)
  union all
  select 'stations guard fires on UPDATE and DELETE',
         coalesce((select (tgtype & 16) <> 0 and (tgtype & 8) <> 0 from pg_trigger
                    where tgname = 'trg_pos_online_print_stations_guard' and not tgisinternal), false)
  union all
  select 'FK targets only restaurants / pos_devices / pos_staff: ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not exists (select 1 from pg_constraint k
                                where k.contype = 'f' and k.conrelid = to_regclass('public.' || rel)
                                  and k.confrelid not in ('public.restaurants'::regclass, 'public.pos_devices'::regclass, 'public.pos_staff'::regclass)) end
  from intended
  union all
  select 'no pos_* FK to ' || lt,
         not exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
                      where k.contype = 'f' and k.confrelid = to_regclass('public.' || lt) and c.relname like 'pos\_%')
  from live
  union all
  select 'no trigger on ' || lt || ' calls a pos_ function',
         not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                      where tg.tgrelid = to_regclass('public.' || lt) and not tg.tgisinternal and p.proname like 'pos\_%')
  from live
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
