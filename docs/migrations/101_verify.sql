-- 101_verify.sql — READ-ONLY checks of the persisted state after migration 101
-- (pos device auth). Run in the Supabase SQL editor after applying 101 (and after 101_smoke.sql,
-- which rolls back and must leave the tables empty). One row per check; every `pass` must be true.
-- Writes nothing. Prints no row data from the device tables (counts only).

with
tbl(t) as (values ('pos_devices'), ('pos_device_enrollments'), ('pos_auth_attempts'), ('pos_device_events')),
fn(f) as (values
  ('public.pos_next_prefix(uuid)'),
  ('public.pos_create_enrollment(uuid, text, uuid, text, text, timestamptz, uuid, timestamptz)'),
  ('public.pos_record_enrollment_failure(inet, uuid, timestamptz, int)'),
  ('public.pos_consume_enrollment(uuid, uuid, text, uuid, text, text, inet, timestamptz, int)'),
  ('public.pos_replay_enrollment(uuid, uuid, text, bigint, timestamptz)'),
  ('public.pos_record_auth_failed(uuid, uuid, text, timestamptz, int)'),
  ('public.pos_revoke_device(uuid, uuid, text, text, timestamptz)')
),
grantee(g) as (values ('anon'), ('authenticated'), ('public')),
checks(check_name, pass) as (
  -- tables exist
  select 'table exists: ' || t, to_regclass('public.' || t) is not null from tbl
  union all
  -- RLS enabled
  select 'rls enabled: ' || t,
         coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t)), false)
  from tbl
  union all
  -- no policies
  select 'zero policies: ' || t,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = tbl.t) = 0
  from tbl
  union all
  -- anon / authenticated / public: no table privileges at all
  select 'no table privileges: ' || g || ' on ' || t,
         case when to_regclass('public.' || t) is null then false
              else not has_table_privilege(g, 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') end
  from tbl cross join grantee
  union all
  -- service_role: full DML on every table
  select 'service_role DML: ' || t,
         case when to_regclass('public.' || t) is null then false
              else has_table_privilege('service_role', 'public.' || t, 'SELECT')
                   and has_table_privilege('service_role', 'public.' || t, 'INSERT')
                   and has_table_privilege('service_role', 'public.' || t, 'UPDATE')
                   and has_table_privilege('service_role', 'public.' || t, 'DELETE') end
  from tbl
  union all
  -- the identity sequence of pos_device_events
  select 'no sequence privileges: ' || g || ' on pos_device_events_id_seq',
         case when to_regclass('public.pos_device_events_id_seq') is null then false
              else not has_sequence_privilege(g, 'public.pos_device_events_id_seq', 'USAGE, SELECT, UPDATE') end
  from grantee
  union all
  select 'service_role sequence usage: pos_device_events_id_seq',
         case when to_regclass('public.pos_device_events_id_seq') is null then false
              else has_sequence_privilege('service_role', 'public.pos_device_events_id_seq', 'USAGE') end
  union all
  -- functions exist
  select 'function exists: ' || f, to_regprocedure(f) is not null from fn
  union all
  -- anon / authenticated / public: no EXECUTE
  select 'no execute: ' || g || ' on ' || f,
         case when to_regprocedure(f) is null then false
              else not has_function_privilege(g, f, 'EXECUTE') end
  from fn cross join grantee
  union all
  -- service_role: EXECUTE
  select 'service_role execute: ' || f,
         case when to_regprocedure(f) is null then false
              else has_function_privilege('service_role', f, 'EXECUTE') end
  from fn
  union all
  -- SECURITY INVOKER + pinned search_path
  select 'invoker + search_path pinned: ' || f,
         coalesce((select not p.prosecdef and p.proconfig @> array['search_path=public']
                   from pg_proc p where p.oid = to_regprocedure(f)), false)
  from fn
  union all
  -- the partial unique index on live lookup ids
  select 'index pos_enrollments_live_lookup (unique, partial)',
         exists (select 1 from pg_indexes i
                 where i.schemaname = 'public' and i.indexname = 'pos_enrollments_live_lookup'
                   and i.indexdef ilike '%unique%' and i.indexdef ilike '%where%used_at is null%locked_at is null%')
  union all
  -- prefix rules
  select 'pos_devices unique (restaurant_id, prefix)',
         exists (select 1 from pg_constraint c
                 where c.conrelid = to_regclass('public.pos_devices') and c.contype = 'u'
                   and pg_get_constraintdef(c.oid) ilike '%(restaurant_id, prefix)%')
  union all
  select 'pos_devices prefix CHECK ^[A-Z]{1,2}$',
         exists (select 1 from pg_constraint c
                 where c.conrelid = to_regclass('public.pos_devices') and c.contype = 'c'
                   and pg_get_constraintdef(c.oid) like '%^[A-Z]{1,2}$%')
  union all
  -- all 8 event types allowed
  select 'pos_device_events type CHECK has all 8 types',
         exists (select 1 from pg_constraint c
                 where c.conrelid = to_regclass('public.pos_device_events') and c.contype = 'c'
                   and pg_get_constraintdef(c.oid) like '%enrolled%' and pg_get_constraintdef(c.oid) like '%reenrolled%'
                   and pg_get_constraintdef(c.oid) like '%revoked%' and pg_get_constraintdef(c.oid) like '%rotation_offered%'
                   and pg_get_constraintdef(c.oid) like '%rotated%' and pg_get_constraintdef(c.oid) like '%auth_failed%'
                   and pg_get_constraintdef(c.oid) like '%enrollment_failed%' and pg_get_constraintdef(c.oid) like '%enrollment_locked%')
  union all
  -- the pending_token_* rotation columns exist (§7.3, build later)
  select 'pos_devices pending_token_hash + pending_token_issued_at',
         (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'pos_devices'
            and column_name in ('pending_token_hash', 'pending_token_issued_at')) = 2
  union all
  -- prune cron job
  select 'cron job pos-auth-attempts-prune (active)',
         exists (select 1 from cron.job j where j.jobname = 'pos-auth-attempts-prune' and j.active)
  union all
  -- empty tables (the smoke test rolled back). The count runs only when the table exists.
  select 'empty: ' || t,
         case when to_regclass('public.' || t) is null then false
              else (xpath('/row/c/text()',
                          query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int = 0
         end
  from tbl
)
select check_name, pass from checks
order by pass, check_name;
