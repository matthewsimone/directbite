-- Update dressings topping group to single selection, required
update topping_groups
  set selection_type = 'single',
      required = true
  where id = '00000000-0000-0000-0003-000000000001';
