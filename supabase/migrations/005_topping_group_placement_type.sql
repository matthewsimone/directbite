-- ============================================================
-- Add placement_type, required, max_selections to topping_groups
-- ============================================================

alter table topping_groups add column placement_type text not null default 'pizza';
alter table topping_groups add column required boolean not null default false;
alter table topping_groups add column max_selections integer;

alter table topping_groups add constraint topping_groups_placement_type_check
  check (placement_type in ('pizza', 'addon'));

-- Store placement_type in order_item_toppings for receipt formatting
alter table order_item_toppings add column placement_type text not null default 'pizza';
alter table order_item_toppings add constraint order_item_toppings_placement_type_check
  check (placement_type in ('pizza', 'addon'));
