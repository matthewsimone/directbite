-- ============================================================
-- Add delivery_fee_type to restaurants
-- Values: 'flat' (fixed dollar), 'percentage' (% of subtotal), 'none' (free delivery)
-- ============================================================

alter table restaurants add column delivery_fee_type text not null default 'flat';

alter table restaurants add constraint restaurants_delivery_fee_type_check
  check (delivery_fee_type in ('flat', 'percentage', 'none'));
