-- Drop unused, fully-permissive anon INSERT policies on the orders tables.
-- These granted the anon (public/browser) role the ability to insert arbitrary
-- orders / order_items / order_item_toppings rows (WITH CHECK (true)) — an
-- unauthenticated order-injection hole (fake orders reach the live tablet:
-- chime + receipt print, no payment). The legitimate flow never uses them:
-- orders are inserted only by the stripe-webhook edge function as service_role
-- (bypasses RLS) after Stripe signature verification. Verified across .insert,
-- live pg_policies, and RPC/function/trigger paths: no anon insert path exists.

drop policy if exists "anon_insert_orders" on orders;
drop policy if exists "anon_insert_order_items" on order_items;
drop policy if exists "anon_insert_order_item_toppings" on order_item_toppings;
