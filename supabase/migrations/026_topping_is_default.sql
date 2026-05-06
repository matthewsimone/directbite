-- ============================================================
-- Default-selected toppings
-- Adds is_default flag so admins can pre-check toppings on the
-- customer modal (matches Slice's pre-checked defaults like
-- "Spaghetti" on Pasta Vodka, "Plain" on Chicken Wings).
-- ============================================================

alter table toppings
  add column if not exists is_default boolean not null default false;
