-- Rollback for supabase/migrations/104_pos_orders.sql.
-- DESTRUCTIVE: drops every POS order, line, modifier, payment and idempotency row. Registers would
-- resend their outbox; the server would then treat each order as new (new order numbers).

begin;
drop function if exists public.pos_apply_order_submission(jsonb, uuid, uuid, jsonb, timestamptz, date);
drop table if exists public.pos_order_submissions;
drop table if exists public.pos_payments;          -- drops trg_pos_payments_guard with it
drop function if exists public.pos_payments_guard();
drop table if exists public.pos_order_line_modifiers;
drop table if exists public.pos_order_lines;
drop table if exists public.pos_orders;
drop sequence if exists public.pos_order_number_seq;
commit;
