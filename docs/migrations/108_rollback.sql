-- Rollback for supabase/migrations/108_pos_service_role_privileges.sql.
-- Puts service_role back to what it had before 108: ALL on every pos_* table / view / sequence (the state
-- Supabase's default privileges produced; 104–106 verify showed it). This RE-OPENS the gap (UPDATE / DELETE /
-- TRUNCATE on the immutable tables) — use it only if 108 breaks a code path. anon / authenticated untouched.

begin;

grant all on table public.pos_devices, public.pos_device_enrollments, public.pos_auth_attempts, public.pos_device_events,
                   public.pos_menu_snapshots,
                   public.pos_orders, public.pos_order_lines, public.pos_order_line_modifiers, public.pos_payments,
                   public.pos_order_submissions,
                   public.pos_staff, public.pos_staff_settings, public.pos_staff_snapshots, public.pos_staff_events,
                   public.pos_shifts, public.pos_cash_movements, public.pos_refunds, public.pos_day_closes,
                   public.pos_entity_submissions, public.pos_post_z
  to service_role;
grant all on sequence public.pos_device_events_id_seq, public.pos_order_number_seq to service_role;

commit;
