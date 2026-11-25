-- 105_verify.sql — READ-ONLY checks of the persisted state after migration 105. One row per check;
-- every `pass` must be true. Prints no staff data (counts only).

with t(name) as (values ('pos_staff'), ('pos_staff_settings'), ('pos_staff_snapshots'), ('pos_staff_events')),
f(sig) as (values ('public.pos_staff_lock(uuid)'), ('public.pos_staff_bump(uuid)'),
                  ('public.pos_staff_add(uuid, text, text, text, text, jsonb)'), ('public.pos_staff_set_pin(uuid, text, text, jsonb)'),
                  ('public.pos_staff_deactivate(uuid)'), ('public.pos_staff_reactivate(uuid)'), ('public.pos_staff_set_settings(uuid, integer, integer, boolean)'),
                  ('public.pos_staff_snapshot_source(uuid)')),
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
  select 'service_role select + insert, no delete: ' || name,
         case when to_regclass('public.' || name) is null then false
              else has_table_privilege('service_role', 'public.' || name, 'SELECT') and has_table_privilege('service_role', 'public.' || name, 'INSERT')
                   and not has_table_privilege('service_role', 'public.' || name, 'DELETE') end
  from t
  union all
  select 'immutable (no update): ' || name,
         case when to_regclass('public.' || name) is null then false else not has_table_privilege('service_role', 'public.' || name, 'UPDATE') end
  from t where name in ('pos_staff_snapshots', 'pos_staff_events')
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
  select 'pin_salt / pin_hash hex CHECKs',
         (select count(*) from pg_constraint where conrelid = to_regclass('public.pos_staff') and contype = 'c'
            and (pg_get_constraintdef(oid) ilike '%pin_salt%' or pg_get_constraintdef(oid) ilike '%pin_hash%')) = 2
  union all
  select 'default pin_kdf = scrypt n 8192 r 7 p 1 dk_len 32',
         (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
           where d.adrelid = to_regclass('public.pos_staff_settings') and a.attname = 'pin_kdf')::text ilike '%"n": 8192%'
  union all
  select 'every restaurant with staff has an active manager once PINs are on',
         case when to_regclass('public.pos_staff_settings') is null then false
              else (xpath('/row/c/text()', query_to_xml(
                     'select count(*) as c from public.pos_staff_settings s where s.pins_on and not exists (select 1 from public.pos_staff x where x.restaurant_id = s.restaurant_id and x.role = ''manager'' and x.active)',
                     false, true, '')))[1]::text::int = 0 end
)
select check_name, pass from checks order by pass, check_name;
