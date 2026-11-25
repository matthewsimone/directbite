-- 111_verify.sql — READ-ONLY checks after migration 111. One row per check; every `pass` must be true.
--   - service_role: every table privilege (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) on
--     pos_online_actions held iff intended (select insert update), table-level AND column-level (the 108 lesson);
--     pos_restaurant_settings unchanged (select insert update).
--   - anon / authenticated / public: nothing on those tables, no EXECUTE on the 111 functions.
--   - service_role: EXECUTE on the 4 callable functions; every 111 function SECURITY INVOKER; 109's begin / complete
--     signatures are gone.
--   - the reshaped columns (handoff DDL): present / gone; order_id nullable; the named CHECKs; the partial unique
--     ready-email index; the guard trigger (BEFORE UPDATE).
--   - what the functions need and already have (Supabase defaults, NOT granted by 111): service_role SELECT + the
--     UPDATE columns on orders, SELECT on restaurants.estimated_pickup_minutes.
--   - NO foreign key from a pos_ table to orders / order_items / order_item_toppings / print_logs /
--     adjustment_requests / external_orders / menu_items, and no trigger on those tables (or restaurants) calls a
--     pos_ function (111 adds none).
-- Prints no data.

with intended(rel, privs) as (values
  ('pos_online_actions',      array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_restaurant_settings', array['SELECT', 'INSERT', 'UPDATE'])
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
fns(sig, granted) as (values
  ('public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_online_action_complete(uuid, uuid, text)', true),
  ('public.pos_online_order_action(uuid, uuid, uuid, uuid, text, text, int, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_online_settings_change(uuid, uuid, uuid, text, uuid, boolean, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_online_actions_guard()', false)
),
cols(rel, col, present) as (values
  ('pos_online_actions', 'action_id', true), ('pos_online_actions', 'function', true),
  ('pos_online_actions', 'restaurant_id', true), ('pos_online_actions', 'device_id', true),
  ('pos_online_actions', 'order_channel', true), ('pos_online_actions', 'order_id', true),
  ('pos_online_actions', 'action', true), ('pos_online_actions', 'request', true),
  ('pos_online_actions', 'request_hash', true), ('pos_online_actions', 'outcome', true),
  ('pos_online_actions', 'error_status', true), ('pos_online_actions', 'error_code', true),
  ('pos_online_actions', 'error_message', true), ('pos_online_actions', 'order_ids', true),
  ('pos_online_actions', 'ready_email_sent', true), ('pos_online_actions', 'actor_staff_id', true),
  ('pos_online_actions', 'approver_staff_id', true), ('pos_online_actions', 'device_time', true),
  ('pos_online_actions', 'created_at', true), ('pos_online_actions', 'completed_at', true),
  ('pos_online_actions', 'staff_id', false), ('pos_online_actions', 'result', false),
  ('pos_online_actions', 'http_status', false)
),
named_checks(c) as (values
  ('pos_online_actions_function_check'), ('pos_online_actions_channel_check'), ('pos_online_actions_order_check'),
  ('pos_online_actions_action_check'), ('pos_online_actions_request_check'), ('pos_online_actions_request_hash_check'),
  ('pos_online_actions_outcome_check'), ('pos_online_actions_completed_check'), ('pos_online_actions_error_check'),
  ('pos_online_actions_order_ids_check'), ('pos_online_actions_ready_email_check'), ('pos_online_actions_actor_check')
),
needs(rel, col, p) as (values
  ('orders', 'status', 'SELECT'), ('orders', 'items_written_at', 'SELECT'), ('orders', 'restaurant_id', 'SELECT'),
  ('orders', 'status', 'UPDATE'), ('orders', 'accepted_at', 'UPDATE'), ('orders', 'quoted_for', 'UPDATE'),
  ('orders', 'acknowledged_at', 'UPDATE'), ('orders', 'stuck_acknowledged_at', 'UPDATE'),
  ('restaurants', 'estimated_pickup_minutes', 'SELECT')
),
live(lt) as (values ('orders'), ('order_items'), ('order_item_toppings'), ('print_logs'), ('adjustment_requests'),
                    ('external_orders'), ('restaurants'), ('menu_items')),
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
  from (values ('public.pos_online_action_begin(uuid, uuid, uuid, uuid, uuid, text, jsonb)'),
               ('public.pos_online_action_complete(uuid, uuid, jsonb, int)')) x(sig)
  union all
  select case when present then 'column present: ' else 'column gone: ' end || rel || '.' || col,
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = rel and column_name = col) = present
  from cols
  union all
  select 'pos_online_actions.order_id nullable',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pos_online_actions'
                    and column_name = 'order_id' and is_nullable = 'YES')
  union all
  select 'check exists: ' || c,
         exists (select 1 from pg_constraint where conname = c and conrelid = 'public.pos_online_actions'::regclass and contype = 'c')
  from named_checks
  union all
  select 'primary key pos_online_actions (action_id)',
         coalesce((select string_agg(a.attname, ',') from pg_constraint c
                     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                    where c.conrelid = 'public.pos_online_actions'::regclass and c.contype = 'p'), '') = 'action_id'
  union all
  select 'ready-email index: unique, partial, on order_id',
         coalesce((select i.indisunique and i.indpred is not null
                          and pg_get_indexdef(i.indexrelid) like '%(order_id)%WHERE ready_email_sent%'
                     from pg_index i where i.indexrelid = to_regclass('public.pos_online_actions_ready_email_once')), false)
  union all
  select 'guard trigger exists, BEFORE UPDATE: trg_pos_online_actions_guard',
         coalesce((select (tgtype & 2) <> 0 and (tgtype & 16) <> 0 from pg_trigger
                    where tgname = 'trg_pos_online_actions_guard' and not tgisinternal
                      and tgrelid = 'public.pos_online_actions'::regclass), false)
  union all
  select 'function prerequisite: service_role ' || p || ' on ' || rel || '.' || col,
         has_column_privilege('service_role', 'public.' || rel, col, p)
  from needs
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
  from live where lt not in ('restaurants')
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
