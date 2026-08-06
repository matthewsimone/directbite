-- 072_loyalty_default_rate.sql
-- Platform default earn rate moves from 1 to 10 points per dollar. A
-- three-figure balance reads as meaningful where a two-figure one does not,
-- and it matches what customers see from other restaurant loyalty programs.
--
-- Affects new restaurants only — existing rows keep whatever rate they were
-- configured with. Tier thresholds and reward costs must scale by the same
-- factor wherever they were set at the old rate, or the ladder stops
-- matching the earn rate. The seeded defaults in LoyaltyTab.jsx were updated
-- alongside this.

begin;

alter table restaurants alter column loyalty_points_per_dollar set default 10.00;

commit;