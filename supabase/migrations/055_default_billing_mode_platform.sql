-- Default new restaurants to platform billing mode.
-- All restaurants now run UberDirect through the single DirectBite platform
-- account; self mode is retained only for sandbox testing (flip individually).
-- Existing rows were already bulk-set to 'platform' via SQL editor; this only
-- changes the column DEFAULT for future inserts.

ALTER TABLE restaurants
  ALTER COLUMN uber_billing_mode SET DEFAULT 'platform';
