-- 103_address_backfill_oneshot.sql — WRITES, in ONE execution (begin … commit). Run in the Supabase SQL
-- editor as postgres, AFTER migration 103 is applied and 103_address_parse_preview.sql was reviewed.
--
-- Same parse + update as 103_address_backfill.sql: fills address_street / address_city / address_state /
-- address_zip from the free-text address, only for rows whose parse is complete ('ok' in the preview) AND
-- whose four structured columns are ALL still null. Rows marked 'review' are left for hand entry.
--
-- Guard: c_expected below = the number of 'ok' rows in the preview (34). If the UPDATE changes any other
-- number of rows, 'BACKFILL FAIL: …' is raised, the transaction is aborted and NOTHING is kept (the final
-- COMMIT of an aborted transaction is a rollback). A second run updates 0 rows, so it fails the same way
-- and changes nothing — re-running is safe. (Migration 102's tablet guard doesn't apply: postgres.)
--
-- UNDO (after a successful run): null the four columns again on exactly the rows this script filled —
-- the rows whose structured values still equal the parse of their free-text address (hand-entered or
-- edited rows don't match, so they are left alone):
--
--   begin;
--   with src as (
--     select id, regexp_replace(btrim(coalesce(address, '')), ',\s*(usa|united states( of america)?)\.?$', '', 'i') as a
--     from public.restaurants
--   ), parts as (
--     select id, regexp_split_to_array(a, '\s*,\s*') as p, cardinality(regexp_split_to_array(a, '\s*,\s*')) as n from src
--   ), parsed as (
--     select id,
--       case when n >= 3 then array_to_string(p[1:n-2], ', ') when n = 2 then p[1] end as street,
--       case when n >= 3 then p[n-1]
--            when n = 2 then nullif(btrim(substring(p[2] from '^(.*?)\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$')), '') end as city,
--       upper(substring(p[n] from '(?:^|\s)([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$')) as state,
--       substring(p[n] from '(\d{5}(?:-\d{4})?)$') as zip
--     from parts
--   )
--   update public.restaurants r
--      set address_street = null, address_city = null, address_state = null, address_zip = null
--     from parsed p
--    where p.id = r.id
--      and r.address_street = p.street and r.address_city = p.city and r.address_state = p.state and r.address_zip = p.zip;
--   -- check the row count it reports (expect 34), then:
--   commit;

begin;

-- EXPECTED COUNT — the preview's 'ok' rows. The only value to edit:
create temp table _backfill_expected on commit drop as select 34 as n;   -- <<< c_expected

-- the ids this run fills (dropped at commit)
create temp table _backfilled (id uuid primary key) on commit drop;

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
), upd as (
  update public.restaurants r
     set address_street = p.street, address_city = p.city, address_state = p.state, address_zip = p.zip
    from parsed p
   where p.id = r.id
     and p.street is not null and p.city is not null and p.state is not null and p.zip is not null
  returning r.id
)
insert into _backfilled (id) select id from upd;

do $$
declare
  c_expected constant int := (select n from _backfill_expected);
  v_updated  int;
  v_review   int;
begin
  select count(*) into v_updated from _backfilled;
  select count(*) into v_review from public.restaurants
   where address_street is null and address_city is null and address_state is null and address_zip is null;
  if v_updated <> c_expected then
    raise exception 'BACKFILL FAIL: updated % rows, expected % — nothing is kept (% rows still need review)', v_updated, c_expected, v_review;
  end if;
  raise notice 'BACKFILL OK: % rows filled; % rows still need review (all four columns null)', v_updated, v_review;
end;
$$;

commit;
