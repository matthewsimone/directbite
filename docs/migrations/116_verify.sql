-- 116_verify.sql — READ-ONLY checks after migration 116. One row per check; every `pass` must be true.
--   - pos_deliveries.quoted_provider_fee_cents (integer, nullable) and canceled_by (text, nullable) exist.
--   - 115's `restaurant_absorbs_cents >= 0` check is gone; the two 116 checks exist and are validated.
--   - the guard knows the new columns (immutable / set once); its trigger is still on UPDATE + DELETE.
--   - service_role on pos_deliveries: SELECT / INSERT / UPDATE held, DELETE / TRUNCATE / REFERENCES / TRIGGER not —
--     table-level AND column-level on the new columns (the 108 lesson); nothing for anon / authenticated / public.
-- Prints no data.

with priv(p, want) as (values ('SELECT', true), ('INSERT', true), ('UPDATE', true), ('DELETE', false), ('TRUNCATE', false),
                              ('REFERENCES', false), ('TRIGGER', false)),
newcol(col, typ) as (values ('quoted_provider_fee_cents', 'integer'), ('canceled_by', 'text')),
checks(check_name, pass) as (
  select 'column pos_deliveries.' || col || ' ' || typ || ' nullable',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pos_deliveries' and column_name = col
                    and data_type = typ and is_nullable = 'YES')
  from newcol
  union all
  select '115 check restaurant_absorbs_cents >= 0 is gone',
         not exists (select 1 from pg_constraint where conrelid = 'public.pos_deliveries'::regclass and contype = 'c'
                        and pg_get_constraintdef(oid) ilike '%restaurant_absorbs_cents >= 0%')
  union all
  select 'check ' || c || ' exists + validated',
         exists (select 1 from pg_constraint where conrelid = 'public.pos_deliveries'::regclass and contype = 'c'
                    and conname = c and convalidated)
  from unnest(array['pos_deliveries_absorbs_is_difference', 'pos_deliveries_canceled_by_iff_canceled']) c
  union all
  select 'guard knows ' || w,
         position(w in (select prosrc from pg_proc where oid = 'public.pos_deliveries_guard()'::regprocedure)) > 0
  from unnest(array['quoted_provider_fee_cents is distinct from old.quoted_provider_fee_cents',
                    'old.canceled_by is not null and new.canceled_by is distinct from old.canceled_by']) w
  union all
  select 'guard trigger on pos_deliveries UPDATE + DELETE',
         exists (select 1 from pg_trigger t where t.tgrelid = 'public.pos_deliveries'::regclass and not t.tgisinternal
                    and t.tgfoid = 'public.pos_deliveries_guard()'::regprocedure
                    and (t.tgtype & 16) <> 0 and (t.tgtype & 8) <> 0)
  union all
  select 'guard not executable by anon / authenticated',
         not has_function_privilege('anon', 'public.pos_deliveries_guard()', 'EXECUTE')
         and not has_function_privilege('authenticated', 'public.pos_deliveries_guard()', 'EXECUTE')
  union all
  select 'service_role ' || case when want then 'HAS ' else 'NOT ' end || p || ' on pos_deliveries',
         has_table_privilege('service_role', 'public.pos_deliveries', p) = want
  from priv
  union all
  select 'service_role ' || p || ' on pos_deliveries.' || col,
         has_column_privilege('service_role', 'public.pos_deliveries', col, p)
  from newcol cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) v(p)
  union all
  select r || ' has nothing on pos_deliveries',
         not (has_table_privilege(r, 'public.pos_deliveries', 'SELECT') or has_table_privilege(r, 'public.pos_deliveries', 'INSERT')
              or has_table_privilege(r, 'public.pos_deliveries', 'UPDATE') or has_table_privilege(r, 'public.pos_deliveries', 'DELETE')
              or has_any_column_privilege(r, 'public.pos_deliveries', 'SELECT'))
  from unnest(array['anon', 'authenticated']) r
  union all
  select 'RLS on pos_deliveries, no policies',
         (select relrowsecurity from pg_class where oid = 'public.pos_deliveries'::regclass)
         and not exists (select 1 from pg_policy where polrelid = 'public.pos_deliveries'::regclass)
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
