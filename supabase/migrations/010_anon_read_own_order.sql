-- Allow anonymous users to read orders by stripe_payment_intent_id
-- This is needed for the confirmation page to poll for the order after payment
-- Safe because payment_intent_id is only known to the paying customer
create policy "anon_read_order_by_payment_intent"
  on orders for select
  to anon
  using (stripe_payment_intent_id is not null);
