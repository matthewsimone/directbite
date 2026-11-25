-- 112_verify.sql — READ-ONLY checks after migration 112. One row per check; every `pass` must be true.
--   - the function exists, SECURITY INVOKER, EXECUTE for service_role only (not anon / authenticated / public).
--   - what it needs and already has (Supabase defaults, NOT granted by 112): service_role UPDATE on the exact columns
--     the tablet writes, SELECT on the columns it reads; service_role still has no extra privilege on
--     pos_online_actions (111: select insert update).
--   - none of the written columns is in 102's admin-only list (the guard function's array), and no trigger on
--     restaurants / menu_items / toppings calls a pos_ function.
-- Prints no data.

with fn(sig) as (values
  ('public.pos_online_tablet_setting_change(uuid, uuid, uuid, text, int, int, boolean, uuid, jsonb, text, uuid, timestamptz)')
),
needs(rel, col, p) as (values
  ('restaurants', 'estimated_pickup_minutes', 'UPDATE'), ('restaurants', 'estimated_delivery_minutes', 'UPDATE'),
  ('restaurants', 'delivery_available', 'UPDATE'), ('menu_items', 'is_available', 'UPDATE'),
  ('restaurants', 'id', 'SELECT'), ('restaurants', 'estimated_pickup_minutes', 'SELECT'),
  ('restaurants', 'estimated_delivery_minutes', 'SELECT'), ('restaurants', 'delivery_available', 'SELECT'),
  ('menu_items', 'id', 'SELECT'), ('menu_items', 'restaurant_id', 'SELECT'), ('menu_items', 'is_available', 'SELECT')
),
written(col) as (values ('estimated_pickup_minutes'), ('estimated_delivery_minutes'), ('delivery_available')),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
checks(check_name, pass) as (
  select 'function exists + SECURITY INVOKER: ' || sig,
         coalesce((select not p.prosecdef from pg_proc p where p.oid = to_regprocedure(sig)), false)
  from fn
  union all
  select 'service_role HAS EXECUTE: ' || sig,
         case when to_regprocedure(sig) is null then false else has_function_privilege('service_role', sig, 'EXECUTE') end
  from fn
  union all
  select 'no EXECUTE: ' || g || ' on ' || sig,
         case when to_regprocedure(sig) is null then false else not has_function_privilege(g, sig, 'EXECUTE') end
  from fn cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'function prerequisite: service_role ' || p || ' on ' || rel || '.' || col,
         has_column_privilege('service_role', 'public.' || rel, col, p)
  from needs
  union all
  select 'pos_online_actions still exactly select/insert/update: ' || p,
         has_table_privilege('service_role', 'public.pos_online_actions', p) = (p in ('SELECT', 'INSERT', 'UPDATE'))
  from priv
  union all
  select 'not admin-only in 102: restaurants.' || col,
         case when to_regprocedure('public.restaurants_tablet_guard()') is null then false   -- 102 must be live
              else position('''' || col || '''' in pg_get_functiondef(to_regprocedure('public.restaurants_tablet_guard()'))) = 0 end
  from written
  union all
  select 'no trigger on ' || lt || ' calls a pos_ function',
         not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                      where tg.tgrelid = to_regclass('public.' || lt) and not tg.tgisinternal and p.proname like 'pos\_%')
  from (values ('restaurants'), ('menu_items'), ('toppings')) x(lt)
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
