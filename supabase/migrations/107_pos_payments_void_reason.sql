-- 107_pos_payments_void_reason.sql — payments[].void_reason (CONTRACT ADD 2026-11-23, ordr-pos a685442).
--
-- pos_payments.void_reason ALREADY EXISTS (104, `void_reason text`) and pos_apply_order_submission ALREADY
-- stores it — on insert and on the captured → voided update (104 lines 365-377). So this migration only
-- adds the database-side length rule, as defense in depth behind the edge function's 400:
--   void_reason is null, or 1–500 characters.
-- (The function also refuses a blank reason and requires null while captured / a reason when voided; those
-- stay in the API so older rows and the guard trigger are unaffected.)
--
-- Additive and backwards-compatible: no column / type / default change, no function change, no rewrite.
-- The CHECK scans pos_payments once (empty / tiny before the POS goes live). 104–106 are not edited.
--
-- NOT APPLIED. Needs 104. Rollback: docs/migrations/107_rollback.sql. Smoke: 107_smoke.sql.
-- Verify: 107_verify.sql.

begin;

alter table public.pos_payments
  add constraint pos_payments_void_reason_length
  check (void_reason is null or char_length(void_reason) between 1 and 500);

comment on column public.pos_payments.void_reason is
  'Why the payment was voided (staff reason, 1–500 chars; null while captured). Wire: payments[].void_reason (107).';

commit;
