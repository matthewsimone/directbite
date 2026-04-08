-- ============================================================
-- DirectBite Initial Schema
-- ============================================================

-- RESTAURANTS
create table restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  phone text,
  address text,
  hero_image_url text,
  tax_rate numeric not null default 0,
  delivery_available boolean not null default false,
  delivery_fee numeric not null default 0,
  delivery_note text,
  estimated_pickup_minutes integer not null default 30,
  estimated_delivery_minutes integer not null default 60,
  is_open boolean not null default true,
  stripe_account_id text,
  printnode_printer_id text,
  tablet_email text,
  created_at timestamptz not null default now()
);

-- HOURS
create table hours (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  is_open boolean not null default true,
  open_time time,
  close_time time
);

-- MENU CATEGORIES
create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0
);

-- MENU ITEMS
create table menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  category_id uuid not null references menu_categories(id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ITEM SIZES
create table item_sizes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references menu_items(id) on delete cascade,
  name text not null,
  price numeric not null,
  sort_order integer not null default 0
);

-- TOPPING GROUPS
create table topping_groups (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0
);

-- TOPPINGS
create table toppings (
  id uuid primary key default gen_random_uuid(),
  topping_group_id uuid not null references topping_groups(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,
  price numeric not null,
  is_available boolean not null default true,
  sort_order integer not null default 0
);

-- ITEM TOPPING GROUPS (join table)
create table item_topping_groups (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references menu_items(id) on delete cascade,
  topping_group_id uuid not null references topping_groups(id) on delete cascade
);

-- PROMOTIONS
create table promotions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  discount_percentage numeric not null,
  is_active boolean not null default false,
  is_perpetual boolean not null default false,
  start_date date,
  end_date date,
  created_at timestamptz not null default now()
);

-- ORDER NUMBER SEQUENCE
create sequence order_number_seq start with 1000001;

-- ORDERS
create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint unique not null default nextval('order_number_seq'),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  status text not null default 'new',
  order_type text not null,
  customer_name text not null,
  customer_phone text not null,
  customer_email text not null,
  delivery_address text,
  subtotal numeric not null,
  discount_amount numeric not null default 0,
  discount_percentage numeric not null default 0,
  delivery_fee numeric not null default 0,
  tax_amount numeric not null,
  tip_amount numeric not null default 0,
  service_fee numeric not null default 1.50,
  total_amount numeric not null,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  print_status text not null default 'pending',
  print_attempts integer not null default 0,
  last_print_attempt timestamptz,
  special_instructions text,
  created_at timestamptz not null default now(),
  constraint orders_status_check check (status in ('new', 'in_progress', 'complete', 'cancelled')),
  constraint orders_order_type_check check (order_type in ('pickup', 'delivery')),
  constraint orders_print_status_check check (print_status in ('pending', 'printed', 'failed'))
);

-- ORDER ITEMS
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid not null references menu_items(id),
  item_size_id uuid references item_sizes(id),
  item_name text not null,
  size_name text,
  base_price numeric not null,
  quantity integer not null default 1,
  special_instructions text,
  created_at timestamptz not null default now()
);

-- ORDER ITEM TOPPINGS
create table order_item_toppings (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  topping_id uuid not null references toppings(id),
  topping_name text not null,
  placement text not null,
  price_charged numeric not null,
  constraint order_item_toppings_placement_check check (placement in ('whole', 'left', 'right'))
);

-- PRINT LOGS
create table print_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  order_number bigint,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  attempt_number integer not null,
  status text not null,
  error_message text,
  created_at timestamptz not null default now(),
  constraint print_logs_status_check check (status in ('success', 'failed'))
);

-- ADJUSTMENT REQUESTS
create table adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  order_number bigint,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  type text not null,
  amount numeric not null,
  note text not null,
  status text not null default 'pending',
  approved_at timestamptz,
  stripe_refund_id text,
  created_at timestamptz not null default now(),
  constraint adjustment_requests_type_check check (type in ('charge', 'refund')),
  constraint adjustment_requests_status_check check (status in ('pending', 'approved', 'denied'))
);

-- ============================================================
-- INDEXES
-- ============================================================

create index idx_orders_restaurant_id on orders(restaurant_id);
create index idx_orders_status on orders(status);
create index idx_orders_created_at on orders(created_at);
create index idx_orders_order_number on orders(order_number);
create index idx_menu_items_restaurant_id on menu_items(restaurant_id);
create index idx_menu_items_category_id on menu_items(category_id);

-- ============================================================
-- ORDER NUMBER TRIGGER
-- ============================================================

create or replace function assign_order_number()
returns trigger as $$
begin
  if new.order_number is null then
    new.order_number := nextval('order_number_seq');
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_assign_order_number
  before insert on orders
  for each row
  execute function assign_order_number();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table restaurants enable row level security;
alter table hours enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;
alter table item_sizes enable row level security;
alter table topping_groups enable row level security;
alter table toppings enable row level security;
alter table item_topping_groups enable row level security;
alter table promotions enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_item_toppings enable row level security;
alter table print_logs enable row level security;
alter table adjustment_requests enable row level security;

-- --------------------------------------------------------
-- RESTAURANT TABLET POLICIES
-- Tablet users authenticate via Supabase Auth; their email
-- matches restaurants.tablet_email.
-- --------------------------------------------------------

-- Restaurants: tablet can read own restaurant
create policy "tablet_read_own_restaurant"
  on restaurants for select
  using (tablet_email = auth.jwt() ->> 'email');

-- Restaurants: tablet can update own restaurant
create policy "tablet_update_own_restaurant"
  on restaurants for update
  using (tablet_email = auth.jwt() ->> 'email');

-- Hours: tablet can read/update own
create policy "tablet_read_own_hours"
  on hours for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_hours"
  on hours for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Menu categories: tablet can read/update own
create policy "tablet_read_own_categories"
  on menu_categories for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_categories"
  on menu_categories for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Menu items: tablet can read/update own
create policy "tablet_read_own_items"
  on menu_items for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_items"
  on menu_items for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Item sizes: tablet can read/update own
create policy "tablet_read_own_sizes"
  on item_sizes for select
  using (item_id in (
    select id from menu_items where restaurant_id in (
      select id from restaurants where tablet_email = auth.jwt() ->> 'email'
    )
  ));

create policy "tablet_update_own_sizes"
  on item_sizes for update
  using (item_id in (
    select id from menu_items where restaurant_id in (
      select id from restaurants where tablet_email = auth.jwt() ->> 'email'
    )
  ));

-- Topping groups: tablet can read/update own
create policy "tablet_read_own_topping_groups"
  on topping_groups for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_topping_groups"
  on topping_groups for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Toppings: tablet can read/update own
create policy "tablet_read_own_toppings"
  on toppings for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_toppings"
  on toppings for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Item topping groups: tablet can read/update own
create policy "tablet_read_own_item_topping_groups"
  on item_topping_groups for select
  using (item_id in (
    select id from menu_items where restaurant_id in (
      select id from restaurants where tablet_email = auth.jwt() ->> 'email'
    )
  ));

create policy "tablet_update_own_item_topping_groups"
  on item_topping_groups for update
  using (item_id in (
    select id from menu_items where restaurant_id in (
      select id from restaurants where tablet_email = auth.jwt() ->> 'email'
    )
  ));

-- Promotions: tablet can read/update own
create policy "tablet_read_own_promotions"
  on promotions for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_promotions"
  on promotions for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Orders: tablet can read/update own restaurant orders
create policy "tablet_read_own_orders"
  on orders for select
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

create policy "tablet_update_own_orders"
  on orders for update
  using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Order items: tablet can read own
create policy "tablet_read_own_order_items"
  on order_items for select
  using (order_id in (
    select id from orders where restaurant_id in (
      select id from restaurants where tablet_email = auth.jwt() ->> 'email'
    )
  ));

-- Order item toppings: tablet can read own
create policy "tablet_read_own_order_item_toppings"
  on order_item_toppings for select
  using (order_item_id in (
    select id from order_items where order_id in (
      select id from orders where restaurant_id in (
        select id from restaurants where tablet_email = auth.jwt() ->> 'email'
      )
    )
  ));

-- --------------------------------------------------------
-- CUSTOMER (ANON) POLICIES
-- Customers browse menus without logging in (anon role).
-- --------------------------------------------------------

-- Customers can read any restaurant
create policy "anon_read_restaurants"
  on restaurants for select
  to anon
  using (true);

-- Customers can read hours
create policy "anon_read_hours"
  on hours for select
  to anon
  using (true);

-- Customers can read menu categories
create policy "anon_read_categories"
  on menu_categories for select
  to anon
  using (true);

-- Customers can read menu items
create policy "anon_read_items"
  on menu_items for select
  to anon
  using (true);

-- Customers can read item sizes
create policy "anon_read_sizes"
  on item_sizes for select
  to anon
  using (true);

-- Customers can read topping groups
create policy "anon_read_topping_groups"
  on topping_groups for select
  to anon
  using (true);

-- Customers can read toppings
create policy "anon_read_toppings"
  on toppings for select
  to anon
  using (true);

-- Customers can read item topping groups
create policy "anon_read_item_topping_groups"
  on item_topping_groups for select
  to anon
  using (true);

-- Customers can read active promotions
create policy "anon_read_promotions"
  on promotions for select
  to anon
  using (is_active = true);

-- Customers can insert orders
create policy "anon_insert_orders"
  on orders for insert
  to anon
  with check (true);

-- Customers can insert order items
create policy "anon_insert_order_items"
  on order_items for insert
  to anon
  with check (true);

-- Customers can insert order item toppings
create policy "anon_insert_order_item_toppings"
  on order_item_toppings for insert
  to anon
  with check (true);

-- --------------------------------------------------------
-- SERVICE ROLE POLICIES
-- The service_role bypasses RLS by default in Supabase,
-- so no explicit policies are needed. Print logs and
-- adjustment requests have NO anon/authenticated policies,
-- meaning only service_role can access them.
-- --------------------------------------------------------
