-- Rollback for supabase/migrations/107_pos_payments_void_reason.sql. Drops only the CHECK; the column
-- (from 104) and its values stay.

begin;
alter table public.pos_payments drop constraint if exists pos_payments_void_reason_length;
comment on column public.pos_payments.void_reason is null;
commit;
