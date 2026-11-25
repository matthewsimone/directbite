-- 115_verify.sql — READ-ONLY checks after migration 115. One row per check; every `pass` must be true.
--   - service_role: every table privilege on the 4 new tables + pos_restaurant_settings held iff intended, table-level
--     AND column-level (the 108 lesson); nothing for anon / authenticated / public; RLS on, no policies.
--   - the 3 action functions: SECURITY INVOKER, EXECUTE for service_role only; the guard functions not executable.
--   - pos_restaurant_settings.pos_delivery_dispatch_enabled: boolean, not null, default false.
--   - the one-live-booking unique index; the guard triggers (pos_deliveries UPDATE + DELETE; actions UPDATE + DELETE).
--   - FK targets only restaurants / pos_devices / pos_orders / the 115 quote tables; NO pos_* FK to orders / order_items
--     / uber_quotes / external_orders; no trigger on orders / order_items / uber_quotes calls a pos_ function.
--   - what the TS reads and already has (108 / Supabase defaults, NOT granted by 115): SELECT on pos_orders /
--     pos_order_lines / pos_payments and the restaurants columns the Uber calls read.
-- Prints no data.

with intended(rel, privs) as (values
  ('pos_delivery_quotes',          array['SELECT', 'INSERT']),
  ('pos_delivery_provider_quotes', array['SELECT', 'INSERT']),
  ('pos_deliveries',               array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_delivery_actions',         array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_restaurant_settings',      array['SELECT', 'INSERT', 'UPDATE'])
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
fns(sig, granted) as (values
  ('public.pos_delivery_action_begin(uuid, uuid, uuid, uuid, text, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_delivery_action_finish(uuid, uuid, text, int, text, text)', true),
  ('public.pos_delivery_action_release(uuid, uuid)', true),
  ('public.pos_deliveries_guard()', false),
  ('public.pos_delivery_actions_guard()', false)
),
needs(rel, col) as (values
  ('pos_orders', 'order_id'), ('pos_orders', 'status'), ('pos_orders', 'total_cents'), ('pos_orders', 'delivery'), ('pos_orders', 'pricing'),
  ('pos_orders', 'customer_phone_e164'), ('pos_orders', 'ticket_prefix'), ('pos_order_lines', 'item_name'), ('pos_order_lines', 'base_price_cents'),
  ('pos_payments', 'method'), ('pos_payments', 'amount_cents'), ('pos_payments', 'status'),
  ('restaurants', 'latitude'), ('restaurants', 'longitude'), ('restaurants', 'uber_passthrough_mode'), ('restaurants', 'uber_passthrough_value'),
  ('restaurants', 'uber_billing_mode'), ('restaurants', 'uber_environment'), ('restaurants', 'delivery_fulfillment')
),
live(lt) as (values ('orders'), ('order_items'), ('uber_quotes'), ('external_orders')),
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
         case when to_regprocedure(sig) is null then false else has_function_privilege('service_role', sig, 'EXECUTE') end
  from fns where granted
  union all
  select 'no EXECUTE: ' || g || ' on ' || sig,
         case when to_regprocedure(sig) is null then false else not has_function_privilege(g, sig, 'EXECUTE') end
  from fns cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'pos_restaurant_settings.pos_delivery_dispatch_enabled boolean not null default false',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pos_restaurant_settings' and column_name = 'pos_delivery_dispatch_enabled'
                    and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false')
  union all
  select 'one live booking per order (unique partial index)',
         coalesce((select i.indisunique and i.indpred is not null from pg_index i where i.indexrelid = to_regclass('public.pos_deliveries_one_active')), false)
  union all
  select 'guard trigger: ' || t || ' (' || ev || ')',
         coalesce((select (tgtype & bit) <> 0 and (tgtype & 2) <> 0 from pg_trigger
                    where tgname = t and not tgisinternal and tgrelid = to_regclass('public.' || rel)), false)
  from (values ('trg_pos_deliveries_guard', 'pos_deliveries', 'UPDATE', 16), ('trg_pos_deliveries_guard', 'pos_deliveries', 'DELETE', 8),
               ('trg_pos_delivery_actions_guard', 'pos_delivery_actions', 'UPDATE', 16), ('trg_pos_delivery_actions_guard', 'pos_delivery_actions', 'DELETE', 8)) x(t, rel, ev, bit)
  union all
  select 'FK targets only restaurants / pos_devices / pos_orders / 115 quotes: ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not exists (select 1 from pg_constraint k
                                where k.contype = 'f' and k.conrelid = to_regclass('public.' || rel)
                                  and k.confrelid not in ('public.restaurants'::regclass, 'public.pos_devices'::regclass, 'public.pos_orders'::regclass,
                                                          'public.pos_delivery_quotes'::regclass, 'public.pos_delivery_provider_quotes'::regclass)) end
  from intended where rel <> 'pos_restaurant_settings'
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
  select 'prerequisite: service_role SELECT on ' || rel || '.' || col, has_column_privilege('service_role', 'public.' || rel, col, 'SELECT')
  from needs
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
