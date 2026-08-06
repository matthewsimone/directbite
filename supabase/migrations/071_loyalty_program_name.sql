-- 071_loyalty_program_name.sql
-- Display name for a restaurant's loyalty program, shown as the page title
-- on /:slug/rewards. Manually entered per restaurant rather than derived
-- from restaurants.name — "Sonny's Pizzeria & Restaurant" is the legal name,
-- "Sonny's Rewards" is the program. Empty falls back to plain "Rewards".

begin;

alter table restaurants add column if not exists loyalty_program_name text not null default '';

commit;