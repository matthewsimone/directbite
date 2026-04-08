-- ============================================================
-- Seed: Test Pizza restaurant
-- ============================================================

-- Restaurant
insert into restaurants (id, name, slug, tax_rate, delivery_available, delivery_fee, estimated_pickup_minutes, estimated_delivery_minutes)
values (
  '00000000-0000-0000-0000-000000000001',
  'Test Pizza',
  'test',
  0.06625,
  true,
  3.00,
  27,
  52
);

-- Hours (open every day 11:00-22:00)
insert into hours (restaurant_id, day_of_week, is_open, open_time, close_time)
values
  ('00000000-0000-0000-0000-000000000001', 0, true, '11:00', '22:00'),
  ('00000000-0000-0000-0000-000000000001', 1, true, '11:00', '22:00'),
  ('00000000-0000-0000-0000-000000000001', 2, true, '11:00', '22:00'),
  ('00000000-0000-0000-0000-000000000001', 3, true, '11:00', '22:00'),
  ('00000000-0000-0000-0000-000000000001', 4, true, '11:00', '22:00'),
  ('00000000-0000-0000-0000-000000000001', 5, true, '11:00', '23:00'),
  ('00000000-0000-0000-0000-000000000001', 6, true, '11:00', '23:00');

-- Menu category
insert into menu_categories (id, restaurant_id, name, sort_order)
values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Pizzas', 0);

-- Menu items
insert into menu_items (id, restaurant_id, category_id, name, description)
values
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'Margherita', 'Fresh mozzarella, tomato sauce, basil'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'Pepperoni', 'Mozzarella, pepperoni, tomato sauce');

-- Item sizes (Margherita)
insert into item_sizes (item_id, name, price, sort_order)
values
  ('00000000-0000-0000-0000-000000000100', 'Small', 12.00, 0),
  ('00000000-0000-0000-0000-000000000100', 'Medium', 16.00, 1),
  ('00000000-0000-0000-0000-000000000100', 'Large', 20.00, 2);

-- Item sizes (Pepperoni)
insert into item_sizes (item_id, name, price, sort_order)
values
  ('00000000-0000-0000-0000-000000000101', 'Small', 12.00, 0),
  ('00000000-0000-0000-0000-000000000101', 'Medium', 18.00, 1),
  ('00000000-0000-0000-0000-000000000101', 'Large', 20.00, 2);

-- Topping group
insert into topping_groups (id, restaurant_id, name, sort_order)
values ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000001', 'Extra Toppings', 0);

-- Toppings
insert into toppings (topping_group_id, restaurant_id, name, price, sort_order)
values
  ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000001', 'Pepperoni', 3.50, 0),
  ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000001', 'Sausage', 3.50, 1);

-- Link topping group to both items
insert into item_topping_groups (item_id, topping_group_id)
values
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000001000'),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000001000');
