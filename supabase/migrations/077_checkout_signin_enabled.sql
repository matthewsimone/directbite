-- 077_checkout_signin_enabled.sql
-- ============================================================
-- Per-restaurant switch for inline phone verification at checkout.
--
-- WHAT IT GATES
-- The card path's phone-first flow: entering a complete number triggers a
-- verification SMS, and a code field appears below it. Off, checkout behaves
-- exactly as it did before — a plain phone input, no message sent, no code
-- field, nothing to ignore.
--
-- WHY IT DEFAULTS FALSE
-- Sending an SMS to a real customer mid-order is not something to switch on
-- by deploying. The saved-details half of the feature — the accounts work
-- this flow exists to serve — is not finished, so until it is, verifying
-- would cost the customer a text message and buy them nothing. False by
-- default means the code can sit on main, fully merged, without a single
-- customer seeing it.
--
-- SAME SHAPE AS loyalty_enabled (063)
-- A boolean on restaurants, default false, read by the client. That pattern
-- is what lets a feature ship to main without reaching customers, and what
-- makes rollout a per-restaurant decision: one canary, then a handful, rather
-- than all twenty-one the moment a deploy lands. It is also what makes
-- turning the feature off a single UPDATE rather than a revert.
--
-- ENABLED ON THE TEST CANARY ONLY
-- slug = 'test' and nothing else. Every real restaurant stays false until the
-- flow is reviewed end to end.
--
-- ALREADY APPLIED LIVE. Both statements below were run by hand in the
-- Supabase SQL editor before this file existed; it is written to record them
-- so a fresh database reaches the same state. Both are idempotent — the
-- UPDATE is a no-op once the canary is already true, and matches nothing if
-- no restaurant carries that slug.
-- ============================================================

alter table restaurants
  add column if not exists checkout_signin_enabled boolean not null default false;

update restaurants
   set checkout_signin_enabled = true
 where slug = 'test';
