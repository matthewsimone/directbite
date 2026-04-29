-- Delivery radius with tiered pricing
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_max_radius_miles DECIMAL(5,2);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_tier1_fee_cents INTEGER;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_tier1_max_miles DECIMAL(5,2);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_tier2_fee_cents INTEGER;
