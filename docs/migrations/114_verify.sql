-- 114_verify.sql — READ-ONLY checks after migration 114. One row per check; every `pass` must be true.
--   - pos_online_actions: service_role holds exactly SELECT INSERT UPDATE DELETE (table + column level, the 108
--     lesson); nothing for anon / authenticated / public; RLS on, no policies.
--   - the outcome CHECK allows a pending dispatch_delivery / self_deliver (+ 113's cancel_refund, print).
--   - the guards: 111's BEFORE UPDATE guard and 114's BEFORE DELETE release guard exist.
--   - pos_online_action_release: SECURITY INVOKER, EXECUTE for service_role only; the guard function not executable
--     by anon / authenticated / public; 113's functions still present.
--   - no pos_ FK to orders / uber_quotes; no trigger on orders / uber_quotes calls a pos_ function.
-- Prints no data.

with priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
intended(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')),
fns(sig, granted) as (values
  ('public.pos_online_action_release(uuid, uuid)', true),
  ('public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz)', true),
  ('public.pos_online_action_finish(uuid, uuid, text, int, text, text)', true),
  ('public.pos_online_actions_release_guard()', false)
),
checks(check_name, pass) as (
  select 'service_role ' || case when p in (select p from intended) then 'HAS ' else 'NOT ' end || p || ' on pos_online_actions',
         has_table_privilege('service_role', 'public.pos_online_actions', p) = (p in (select p from intended))
  from priv
  union all
  select 'service_role no column REFERENCES on pos_online_actions',
         not has_any_column_privilege('service_role', 'public.pos_online_actions', 'REFERENCES')
  union all
  select 'no privileges: ' || g || ' on pos_online_actions',
         not has_table_privilege(g, 'public.pos_online_actions', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  from (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'RLS on, no policies: pos_online_actions',
         coalesce((select c.relrowsecurity from pg_class c where c.oid = 'public.pos_online_actions'::regclass), false)
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'pos_online_actions')
  union all
  select 'outcome CHECK allows a pending ' || a,
         coalesce((select pg_get_constraintdef(c.oid) like '%' || a || '%' from pg_constraint c
                    where c.conname = 'pos_online_actions_outcome_check' and c.conrelid = 'public.pos_online_actions'::regclass), false)
  from (values ('dispatch_delivery'), ('self_deliver'), ('cancel_refund')) x(a)
  union all
  select 'guard trigger: ' || t || ' (' || ev || ')',
         coalesce((select (tgtype & bit) <> 0 and (tgtype & 2) <> 0 from pg_trigger
                    where tgname = t and not tgisinternal and tgrelid = 'public.pos_online_actions'::regclass), false)
  from (values ('trg_pos_online_actions_guard', 'BEFORE UPDATE', 16), ('trg_pos_online_actions_release_guard', 'BEFORE DELETE', 8)) x(t, ev, bit)
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
  select 'no pos_* FK to ' || lt,
         not exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
                      where k.contype = 'f' and k.confrelid = to_regclass('public.' || lt) and c.relname like 'pos\_%')
  from (values ('orders'), ('uber_quotes')) x(lt)
  union all
  select 'no trigger on ' || lt || ' calls a pos_ function',
         not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                      where tg.tgrelid = to_regclass('public.' || lt) and not tg.tgisinternal and p.proname like 'pos\_%')
  from (values ('orders'), ('uber_quotes')) x(lt)
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
