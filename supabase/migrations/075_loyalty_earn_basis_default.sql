-- 075_loyalty_earn_basis_default.sql
-- ============================================================
-- Earn on what the customer actually pays.
--
-- 063 shipped the column defaulting to 'subtotal', which earns points on the
-- full pre-promo food subtotal. That pays out points on dollars the customer
-- never handed over: during a 20% promo a $50 order costs $40 but earned as
-- if it were $50. 'subtotal_less_discount' nets the promotional discount off
-- the basis first, so the earn tracks the amount actually paid.
--
-- Unchanged by this migration: the loyalty-redeemed portion is subtracted in
-- every basis mode by the accrual trigger (see 074), and 'subtotal' and
-- 'total' remain valid choices for a restaurant that wants them — the CHECK
-- constraint from 063 is untouched. This only moves the default and brings
-- existing rows in line with it.
--
-- ALREADY APPLIED LIVE. Both statements below were run by hand in the
-- Supabase SQL editor before this file existed; it is written to record them
-- so a fresh database reaches the same state. Both are idempotent, so
-- re-running against the live database is a no-op.
-- ============================================================

alter table restaurants
  alter column loyalty_earn_basis set default 'subtotal_less_discount';

-- `is distinct from` rather than `<>` so a null would also be normalized —
-- the column is NOT NULL today, but this stays correct if that ever changes.
update restaurants
   set loyalty_earn_basis = 'subtotal_less_discount'
 where loyalty_earn_basis is distinct from 'subtotal_less_discount';
