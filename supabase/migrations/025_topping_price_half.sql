-- ============================================================
-- Independent half-pizza topping pricing
-- Adds optional price_half column. NULL means "use whole/2"
-- (preserves current behavior). Set explicitly when a pizzeria
-- charges non-half prices for halves.
-- ============================================================

alter table toppings
  add column if not exists price_half numeric;

-- CHECK constraint wrapped in DO block so re-runs are safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'toppings_price_half_nonneg'
  ) then
    alter table toppings add constraint toppings_price_half_nonneg
      check (price_half is null or price_half >= 0);
  end if;
end$$;
