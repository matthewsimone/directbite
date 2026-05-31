-- Drop the overly-broad anon SELECT policy on orders. It allowed any anon
-- caller to read EVERY paid order (using stripe_payment_intent_id is not null),
-- exposing customer PII (name/phone/email/address) by enumeration. The
-- confirmation page no longer needs it: it now reads a single scoped, non-PII
-- order via the get-order-by-pi edge function (service_role). Verified the only
-- anon order reads were the two ConfirmationPage reads, both migrated.

drop policy if exists "anon_read_order_by_payment_intent" on orders;
