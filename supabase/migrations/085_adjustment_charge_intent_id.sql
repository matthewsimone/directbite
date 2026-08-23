-- Already applied live. Committed for replay integrity.
-- adjustment_requests.stripe_charge_intent_id has been written by
-- admin-approve-adjustment since commit 6c7827d but was never captured in a
-- migration. stripe-settlement-report now .select()s it, so a replayed
-- database without this column fails the report outright.
alter table adjustment_requests
  add column if not exists stripe_charge_intent_id text;
