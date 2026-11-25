-- 117_verify.sql — READ-ONLY checks after migration 117. One row per check; every `pass` must be true.
--   - service_role: every table privilege on the 2 new tables + pos_online_actions + pos_restaurant_settings held iff
--     intended, table-level AND column-level (the 108 lesson); nothing for anon / authenticated; RLS on, no policies.
--   - pos_kitchenhub_item_map_change: SECURITY INVOKER, EXECUTE for service_role only; the release function still
--     service_role only; the guard not executable.
--   - pos_online_actions: the outcome CHECK allows a pending ext_*; the release guard / function know ext_*.
--   - pos_restaurant_settings.kitchenhub_fallback_category_id: uuid, nullable, no FK.
--   - FK targets of the new tables: only restaurants / pos_devices; NO FK to menu_items / menu_categories /
--     external_orders / kitchenhub_stores; no trigger on external_orders / menu_items / menu_categories calls a pos_ fn.
--   - what the TS reads (NOT granted by 117): service_role SELECT on external_orders / kitchenhub_stores /
--     dsp_provider_status / menu_items / menu_categories columns it uses, and UPDATE on the external_orders columns the
--     KitchenHub actions write (kh-order-action's writes).
-- Prints no data.

with intended(rel, privs) as (values
  ('pos_kitchenhub_item_maps',  array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_kitchenhub_menu_pulls', array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_online_actions',        array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_restaurant_settings',   array['SELECT', 'INSERT', 'UPDATE'])
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
newrel(rel) as (values ('pos_kitchenhub_item_maps'), ('pos_kitchenhub_menu_pulls')),
fns(sig, granted) as (values
  ('public.pos_kitchenhub_item_map_change(uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_online_action_release(uuid, uuid)', true),
  ('public.pos_online_actions_release_guard()', false)
),
needs(rel, col, p) as (values
  ('external_orders', 'provider_id', 'SELECT'), ('external_orders', 'items', 'SELECT'), ('external_orders', 'status', 'SELECT'),
  ('external_orders', 'kh_order_id', 'SELECT'), ('external_orders', 'provider_name', 'SELECT'), ('external_orders', 'acknowledged_at', 'UPDATE'),
  ('external_orders', 'status', 'UPDATE'), ('external_orders', 'accepted_at', 'UPDATE'), ('external_orders', 'prep_time_minutes', 'UPDATE'),
  ('external_orders', 'completed_at', 'UPDATE'), ('external_orders', 'cancelled_at', 'UPDATE'), ('external_orders', 'cancelled_by', 'UPDATE'),
  ('external_orders', 'updated_at', 'UPDATE'), ('kitchenhub_stores', 'enabled', 'SELECT'), ('kitchenhub_stores', 'kh_store_id', 'SELECT'),
  ('dsp_provider_status', 'provider_id', 'SELECT'), ('menu_items', 'category_id', 'SELECT'), ('menu_items', 'name', 'SELECT'),
  ('menu_categories', 'id', 'SELECT'), ('menu_categories', 'name', 'SELECT'), ('kitchenhub_tokens', 'access_token', 'SELECT')
),
live(lt) as (values ('external_orders'), ('menu_items'), ('menu_categories'), ('kitchenhub_stores')),
checks(check_name, pass) as (
  select 'service_role ' || case when p = any(privs) then 'HAS ' else 'NOT ' end || p || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else has_table_privilege('service_role', 'public.' || rel, p) = (p = any(privs)) end
  from intended cross join priv
  union all
  select 'service_role column ' || p || ' on every ' || rel || ' column = intended',
         case when to_regclass('public.' || rel) is null then false
              else not exists (select 1 from information_schema.columns c
                                where c.table_schema = 'public' and c.table_name = rel
                                  and has_column_privilege('service_role', 'public.' || rel, c.column_name, p) <> (p = any(privs))) end
  from intended cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) v(p)
  union all
  select r || ' has nothing on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not (has_table_privilege(r, 'public.' || rel, 'SELECT') or has_table_privilege(r, 'public.' || rel, 'INSERT')
                        or has_table_privilege(r, 'public.' || rel, 'UPDATE') or has_table_privilege(r, 'public.' || rel, 'DELETE')
                        or has_any_column_privilege(r, 'public.' || rel, 'SELECT')) end
  from newrel cross join unnest(array['anon', 'authenticated']) r
  union all
  select 'RLS on ' || rel || ', no policies',
         case when to_regclass('public.' || rel) is null then false
              else (select relrowsecurity from pg_class where oid = ('public.' || rel)::regclass)
                   and not exists (select 1 from pg_policy where polrelid = ('public.' || rel)::regclass) end
  from newrel
  union all
  select 'function ' || split_part(sig, '(', 1) || case when granted then ' executable by service_role only' else ' not executable by anon / authenticated' end,
         case when to_regprocedure(sig) is null then false
              else (not granted or has_function_privilege('service_role', sig, 'EXECUTE'))
                   and not has_function_privilege('anon', sig, 'EXECUTE')
                   and not has_function_privilege('authenticated', sig, 'EXECUTE')
                   and not (select prosecdef from pg_proc where oid = to_regprocedure(sig)) end
  from fns
  union all
  select 'outcome check allows a pending ' || x,
         exists (select 1 from pg_constraint where conrelid = 'public.pos_online_actions'::regclass and conname = 'pos_online_actions_outcome_check'
                    and position(quote_literal(x) in pg_get_constraintdef(oid)) > 0)
  from unnest(array['ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel', 'cancel_refund', 'dispatch_delivery', 'self_deliver']) x
  union all
  select 'release guard + function know ' || x,
         position(quote_literal(x) in (select prosrc from pg_proc where oid = 'public.pos_online_actions_release_guard()'::regprocedure)) > 0
         and position(quote_literal(x) in (select prosrc from pg_proc where oid = 'public.pos_online_action_release(uuid, uuid)'::regprocedure)) > 0
  from unnest(array['ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel', 'dispatch_delivery', 'self_deliver']) x
  union all
  select 'release guard trigger on pos_online_actions DELETE',
         exists (select 1 from pg_trigger t where t.tgrelid = 'public.pos_online_actions'::regclass and not t.tgisinternal
                    and t.tgfoid = 'public.pos_online_actions_release_guard()'::regprocedure and (t.tgtype & 8) <> 0)
  union all
  select 'pos_restaurant_settings.kitchenhub_fallback_category_id uuid nullable',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pos_restaurant_settings'
                    and column_name = 'kitchenhub_fallback_category_id' and data_type = 'uuid' and is_nullable = 'YES')
  union all
  select 'unique (restaurant_id, provider, match_kind, match_key) on pos_kitchenhub_item_maps',
         exists (select 1 from pg_constraint where conrelid = 'public.pos_kitchenhub_item_maps'::regclass and contype = 'u'
                    and pg_get_constraintdef(oid) = 'UNIQUE (restaurant_id, provider, match_kind, match_key)')
  union all
  select 'FK targets only restaurants / pos_devices: ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not exists (select 1 from pg_constraint k where k.contype = 'f' and k.conrelid = to_regclass('public.' || rel)
                                  and k.confrelid not in ('public.restaurants'::regclass, 'public.pos_devices'::regclass)) end
  from newrel
  union all
  select 'no FK on pos_restaurant_settings.kitchenhub_fallback_category_id',
         not exists (select 1 from pg_constraint k join pg_attribute at on at.attrelid = k.conrelid and at.attnum = any(k.conkey)
                      where k.contype = 'f' and k.conrelid = 'public.pos_restaurant_settings'::regclass and at.attname = 'kitchenhub_fallback_category_id')
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
  union all
  select 'prerequisite: service_role ' || p || ' on ' || rel || '.' || col, has_column_privilege('service_role', 'public.' || rel, col, p)
  from needs
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
