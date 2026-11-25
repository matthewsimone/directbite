-- 118_verify.sql — READ-ONLY checks after migration 118. One row per check; every `pass` must be true.
--   - the 4 alert columns exist (types, nullable); the all-or-nothing check + the alert_choice / alert_handled_by checks.
--   - alert_handled_device_id's FK targets pos_devices only; no pos_* FK / trigger on live tables.
--   - the guard knows the alert mark (set once; allowed on a final row); its trigger is on UPDATE + DELETE.
--   - pos_delivery_actions action check = dispatch | cancel | alert.
--   - the restaurant index exists.
--   - service_role: pos_deliveries SELECT / INSERT / UPDATE (no DELETE), pos_delivery_actions SELECT / INSERT / UPDATE /
--     DELETE — table-level AND column-level on the new columns (the 108 lesson); nothing for anon / authenticated.
-- Prints no data.

with cols(col, typ) as (values
  ('alert_handled_at', 'timestamp with time zone'), ('alert_handled_by', 'text'),
  ('alert_handled_device_id', 'uuid'), ('alert_choice', 'text')),
intended(rel, privs) as (values
  ('pos_deliveries',       array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_delivery_actions', array['SELECT', 'INSERT', 'UPDATE', 'DELETE'])),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
live(lt) as (values ('orders'), ('order_items'), ('uber_quotes'), ('external_orders'), ('restaurants')),
checks(check_name, pass) as (
  select 'column pos_deliveries.' || col || ' ' || typ || ' nullable',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pos_deliveries'
                    and column_name = col and data_type = typ and is_nullable = 'YES')
  from cols
  union all
  select 'check pos_deliveries_alert_mark_complete exists + validated',
         exists (select 1 from pg_constraint where conrelid = 'public.pos_deliveries'::regclass and contype = 'c'
                    and conname = 'pos_deliveries_alert_mark_complete' and convalidated)
  union all
  select 'alert_choice check = in_house | acknowledged',
         exists (select 1 from pg_constraint where conrelid = 'public.pos_deliveries'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) ilike '%alert_choice%in_house%acknowledged%')
  union all
  select 'alert_handled_device_id FK → pos_devices only',
         exists (select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
                  where k.contype = 'f' and k.conrelid = 'public.pos_deliveries'::regclass and a.attname = 'alert_handled_device_id'
                    and k.confrelid = 'public.pos_devices'::regclass)
  union all
  select 'pos_delivery_actions action check = dispatch | cancel | alert',
         exists (select 1 from pg_constraint where conrelid = 'public.pos_delivery_actions'::regclass and contype = 'c'
                    and conname = 'pos_delivery_actions_action_check'
                    and pg_get_constraintdef(oid) ilike '%dispatch%' and pg_get_constraintdef(oid) ilike '%cancel%'
                    and pg_get_constraintdef(oid) ilike '%alert%')
  union all
  select 'guard knows ' || w,
         position(w in (select prosrc from pg_proc where oid = 'public.pos_deliveries_guard()'::regprocedure)) > 0
  from unnest(array['old.alert_handled_at is not null', '''alert_handled_at'' - ''alert_handled_by''',
                    'quoted_provider_fee_cents is distinct from old.quoted_provider_fee_cents',
                    'old.canceled_by is not null and new.canceled_by is distinct from old.canceled_by']) w
  union all
  select 'guard trigger on pos_deliveries UPDATE + DELETE',
         exists (select 1 from pg_trigger t where t.tgrelid = 'public.pos_deliveries'::regclass and not t.tgisinternal
                    and t.tgfoid = 'public.pos_deliveries_guard()'::regprocedure and (t.tgtype & 16) <> 0 and (t.tgtype & 8) <> 0)
  union all
  select 'guard not executable by anon / authenticated',
         not has_function_privilege('anon', 'public.pos_deliveries_guard()', 'EXECUTE')
         and not has_function_privilege('authenticated', 'public.pos_deliveries_guard()', 'EXECUTE')
  union all
  select 'index pos_deliveries_restaurant_recent (restaurant_id, updated_at desc)',
         exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'pos_deliveries'
                    and indexname = 'pos_deliveries_restaurant_recent' and indexdef ilike '%(restaurant_id, updated_at DESC)%')
  union all
  select 'service_role ' || case when p = any(privs) then 'HAS ' else 'NOT ' end || p || ' on ' || rel,
         has_table_privilege('service_role', 'public.' || rel, p) = (p = any(privs))
  from intended cross join priv
  union all
  select 'service_role ' || p || ' on pos_deliveries.' || col, has_column_privilege('service_role', 'public.pos_deliveries', col, p)
  from cols cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) v(p)
  union all
  select r || ' has nothing on ' || rel,
         not (has_table_privilege(r, 'public.' || rel, 'SELECT') or has_table_privilege(r, 'public.' || rel, 'INSERT')
              or has_table_privilege(r, 'public.' || rel, 'UPDATE') or has_table_privilege(r, 'public.' || rel, 'DELETE')
              or has_any_column_privilege(r, 'public.' || rel, 'SELECT'))
  from intended cross join unnest(array['anon', 'authenticated']) r
  union all
  select 'no pos_* FK to ' || lt,
         not exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
                      where k.contype = 'f' and k.confrelid = to_regclass('public.' || lt) and c.relname like 'pos\_%'
                        and lt <> 'restaurants')
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
