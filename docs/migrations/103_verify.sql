-- 103_verify.sql — READ-ONLY checks of the persisted state after migration 103. One row per check;
-- every `pass` must be true. Prints no snapshot bodies (counts only).

with checks(check_name, pass) as (
  select 'table exists: pos_menu_snapshots', to_regclass('public.pos_menu_snapshots') is not null
  union all
  select 'rls enabled: pos_menu_snapshots',
         coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.pos_menu_snapshots')), false)
  union all
  select 'zero policies: pos_menu_snapshots',
         (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pos_menu_snapshots') = 0
  union all
  select 'no table privileges: ' || g || ' on pos_menu_snapshots',
         case when to_regclass('public.pos_menu_snapshots') is null then false
              else not has_table_privilege(g, 'public.pos_menu_snapshots', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') end
  from (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'service_role select + insert, no update / delete',
         case when to_regclass('public.pos_menu_snapshots') is null then false
              else has_table_privilege('service_role', 'public.pos_menu_snapshots', 'SELECT')
                   and has_table_privilege('service_role', 'public.pos_menu_snapshots', 'INSERT')
                   and not has_table_privilege('service_role', 'public.pos_menu_snapshots', 'UPDATE')
                   and not has_table_privilege('service_role', 'public.pos_menu_snapshots', 'DELETE') end
  union all
  select 'hash is the primary key',
         exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.pos_menu_snapshots') and c.contype = 'p'
                 and pg_get_constraintdef(c.oid) ilike '%(hash)%')
  union all
  select 'restaurant_id FK → restaurants',
         exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.pos_menu_snapshots') and c.contype = 'f'
                 and pg_get_constraintdef(c.oid) ilike '%restaurants(id)%')
  union all
  select 'restaurants.' || col || ' exists, text, nullable',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'restaurants' and column_name = col
                   and data_type = 'text' and is_nullable = 'YES')
  from (values ('address_street'), ('address_city'), ('address_state'), ('address_zip')) a(col)
  union all
  select 'empty: pos_menu_snapshots (smoke rolled back)',
         case when to_regclass('public.pos_menu_snapshots') is null then false
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.pos_menu_snapshots', false, true, '')))[1]::text::int = 0 end
)
select check_name, pass from checks order by pass, check_name;

-- informational (not checks): columns the snapshot needs but no migration creates — present live?
select column_name, table_name from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (('menu_categories', 'is_available'), ('menu_categories', 'available'), ('item_topping_groups', 'is_active'))
order by 2, 1;

-- informational: size_prices keys the canonical JSON can't carry (each blocks that restaurant's snapshot)
select r.slug, count(*) as bad_keys
from public.toppings t
join public.restaurants r on r.id = t.restaurant_id
cross join lateral jsonb_object_keys(case when jsonb_typeof(t.size_prices) = 'object' then t.size_prices else '{}'::jsonb end) as k
where k !~ '^[a-z0-9_]+$'
group by r.slug order by 2 desc;
