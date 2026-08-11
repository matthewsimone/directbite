-- 076_customer_saved_contact.sql
-- ============================================================
-- Saved contact and delivery address on the identity.
--
-- WHY IDENTITY-LEVEL, NOT PER-RESTAURANT
-- These hang off customer_identities rather than restaurant_customers on
-- purpose. A customer who saves an address ordering from one restaurant gets
-- it prefilled at the next one, because the address belongs to the person,
-- not to their relationship with a particular restaurant. That is the same
-- model the phone number already follows: one identity, one number, shared
-- across every restaurant they order from.
--
-- WHO MAY WRITE THEM
-- Only a verified session. The order path must never touch these columns.
-- orders_accrue_loyalty (074) resolves a customer by matching the typed
-- checkout phone against customer_identities.phone_e164 — string equality
-- and nothing more. It cannot tell a verified customer from a guest who
-- happened to type someone else's number, because orders carries no session,
-- no token, and no verification flag. If that trigger wrote an address, one
-- stranger's typo would silently overwrite a real customer's saved home
-- address, and the next prefill would hand it back to them as their own.
-- So: written only by customer-auth, only behind a resolved session token.
--
-- ON restaurant_customers.email
-- That column has existed since 062 and nothing has ever written to it —
-- every row is null. This email column supersedes it for prefill purposes.
-- The old one is deliberately left in place: dropping it is a separate
-- decision, and it costs nothing where it is.
--
-- RLS is untouched. 062 revoked this table from anon and authenticated and
-- granted it to service_role only, which is already exactly the posture these
-- columns need — the edge function is the sole writer and the sole reader.
-- ============================================================

alter table customer_identities
  add column if not exists email              text,
  add column if not exists display_name       text,
  add column if not exists delivery_address   text,
  add column if not exists delivery_apt       text,
  add column if not exists delivery_lat       numeric,
  add column if not exists delivery_lng       numeric,
  add column if not exists address_updated_at timestamptz;
