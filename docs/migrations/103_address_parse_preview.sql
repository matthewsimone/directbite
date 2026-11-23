-- 103_address_parse_preview.sql — READ-ONLY. Run after 103 is applied (or before: it reads only
-- restaurants.address). Previews how the free-text restaurants.address would split into
-- address_street / address_city / address_state / address_zip. Matt reviews every row; only rows with
-- parse_status = 'ok' are written by 103_address_backfill.sql (and only into empty columns).
--
-- Rules (best effort, US): drop a trailing ", USA" / ", United States"; split on commas;
--   ≥ 3 parts → street = all but the last two, city = second to last, last = "ST 12345[-6789]";
--   2 parts   → street = first, last = "City ST 12345" (city taken from before the state);
--   state = two letters (uppercased), zip = 5 digits (+ optional -4).
-- These are the restaurant's own public address (no customer data).

with src as (
  select id, slug, name, address,
         regexp_replace(btrim(coalesce(address, '')), ',\s*(usa|united states( of america)?)\.?$', '', 'i') as a
  from public.restaurants
), parts as (
  select *, regexp_split_to_array(a, '\s*,\s*') as p, cardinality(regexp_split_to_array(a, '\s*,\s*')) as n
  from src
), parsed as (
  select id, slug, name, address,
    case when n >= 3 then array_to_string(p[1:n-2], ', ')
         when n = 2 then p[1] end                                                   as street,
    case when n >= 3 then p[n-1]
         when n = 2 then nullif(btrim(substring(p[2] from '^(.*?)\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$')), '') end as city,
    upper(substring(p[n] from '(?:^|\s)([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$'))         as state,
    substring(p[n] from '(\d{5}(?:-\d{4})?)$')                                      as zip
  from parts
)
select slug, name, address,
       street, city, state, zip,
       case when street is not null and city is not null and state is not null and zip is not null then 'ok' else 'review' end as parse_status
from parsed
order by parse_status desc, slug;
