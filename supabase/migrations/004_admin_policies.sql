-- ============================================================
-- Admin user table and RLS policies
-- Admin gets full access to all tables
-- ============================================================

create table admin_users (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;

-- Helper function
create or replace function is_admin()
returns boolean as $$
begin
  return exists (
    select 1 from admin_users where email = auth.jwt() ->> 'email'
  );
end;
$$ language plpgsql security definer stable;

-- --------------------------------------------------------
-- Admin policies for all tables
-- --------------------------------------------------------

-- Restaurants
create policy "admin_all_restaurants" on restaurants for all using (is_admin()) with check (is_admin());

-- Hours
create policy "admin_all_hours" on hours for all using (is_admin()) with check (is_admin());

-- Menu categories
create policy "admin_all_categories" on menu_categories for all using (is_admin()) with check (is_admin());

-- Menu items
create policy "admin_all_items" on menu_items for all using (is_admin()) with check (is_admin());

-- Item sizes
create policy "admin_all_sizes" on item_sizes for all using (is_admin()) with check (is_admin());

-- Topping groups
create policy "admin_all_topping_groups" on topping_groups for all using (is_admin()) with check (is_admin());

-- Toppings
create policy "admin_all_toppings" on toppings for all using (is_admin()) with check (is_admin());

-- Item topping groups
create policy "admin_all_item_topping_groups" on item_topping_groups for all using (is_admin()) with check (is_admin());

-- Promotions
create policy "admin_all_promotions" on promotions for all using (is_admin()) with check (is_admin());

-- Orders
create policy "admin_all_orders" on orders for all using (is_admin()) with check (is_admin());

-- Order items
create policy "admin_all_order_items" on order_items for all using (is_admin()) with check (is_admin());

-- Order item toppings
create policy "admin_all_order_item_toppings" on order_item_toppings for all using (is_admin()) with check (is_admin());

-- Print logs
create policy "admin_all_print_logs" on print_logs for all using (is_admin()) with check (is_admin());

-- Adjustment requests
create policy "admin_all_adjustments" on adjustment_requests for all using (is_admin()) with check (is_admin());

-- Pending orders
create policy "admin_all_pending_orders" on pending_orders for all using (is_admin()) with check (is_admin());

-- Admin users (admin can read own table)
create policy "admin_read_admin_users" on admin_users for select using (is_admin());
