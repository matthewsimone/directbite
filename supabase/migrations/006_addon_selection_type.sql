-- ============================================================
-- Add selection_type to topping_groups for addon groups
-- ============================================================

alter table topping_groups add column selection_type text not null default 'unlimited';

alter table topping_groups add constraint topping_groups_selection_type_check
  check (selection_type in ('single', 'limited', 'unlimited'));
