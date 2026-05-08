alter table item_topping_groups
  add column sort_order integer not null default 0;

-- Helpful index for the new sort path
create index item_topping_groups_item_sort_idx
  on item_topping_groups (item_id, sort_order);
