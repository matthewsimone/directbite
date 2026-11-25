-- Rollback for supabase/migrations/106_pos_end_of_day.sql.
-- DESTRUCTIVE: drops every POS shift, cash movement, refund, Z and their idempotency rows. Registers would
-- resend their outbox entries; the server would treat each as new.

begin;
drop view if exists public.pos_post_z;
drop function if exists public.pos_set_shift_drawer_flags(uuid, boolean, boolean);
drop function if exists public.pos_apply_day_close(jsonb, uuid, uuid, jsonb, timestamptz);
drop function if exists public.pos_apply_refund(jsonb, uuid, uuid, jsonb, timestamptz);
drop function if exists public.pos_apply_shift(jsonb, uuid, uuid, jsonb, timestamptz);
drop function if exists public.pos_entity_store(text, uuid, int, jsonb, uuid, jsonb, timestamptz);
drop function if exists public.pos_entity_idem(text, uuid, int, text);
drop table if exists public.pos_entity_submissions;
drop table if exists public.pos_day_closes;
drop table if exists public.pos_refunds;
drop table if exists public.pos_cash_movements;
drop table if exists public.pos_shifts;          -- drops trg_pos_shifts_guard
drop function if exists public.pos_shifts_guard();
commit;
