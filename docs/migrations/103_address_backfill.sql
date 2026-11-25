-- 103_address_backfill.sql — WRITES. Run ONLY after reviewing 103_address_parse_preview.sql.
-- Fills address_street / address_city / address_state / address_zip from the free-text address for
-- rows whose parse is complete ('ok' in the preview) AND whose structured columns are all still empty.
-- Rows marked 'review' are left for hand entry (an UPDATE per restaurant, or /admin later).
-- Re-runnable: already-filled rows are skipped. Wrapped in a transaction; inspect the count, then
-- COMMIT (or ROLLBACK).

begin;

with src as (
  select id, regexp_replace(btrim(coalesce(address, '')), ',\s*(usa|united states( of america)?)\.?$', '', 'i') as a
  from public.restaurants
  where address_street is null and address_city is null and address_state is null and address_zip is null
), parts as (
  select id, regexp_split_to_array(a, '\s*,\s*') as p, cardinality(regexp_split_to_array(a, '\s*,\s*')) as n from src
), parsed as (
  select id,
    case when n >= 3 then array_to_string(p[1:n-2], ', ') when n = 2 then p[1] end as street,
    case when n >= 3 then p[n-1]
         when n = 2 then nullif(btrim(substring(p[2] from '^(.*?)\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$')), '') end as city,
    upper(substring(p[n] from '(?:^|\s)([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$')) as state,
    substring(p[n] from '(\d{5}(?:-\d{4})?)$') as zip
  from parts
)
update public.restaurants r
   set address_street = p.street, address_city = p.city, address_state = p.state, address_zip = p.zip
  from parsed p
 where p.id = r.id
   and p.street is not null and p.city is not null and p.state is not null and p.zip is not null;

-- rows filled vs. left for review (counts only)
select count(*) filter (where address_street is not null) as structured,
       count(*) filter (where address_street is null)     as still_empty
from public.restaurants;

-- COMMIT;   -- after checking the counts
-- ROLLBACK; -- to undo
