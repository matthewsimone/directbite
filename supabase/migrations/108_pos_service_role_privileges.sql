-- 108_pos_service_role_privileges.sql — service_role gets EXACTLY the privileges 101 / 103 / 104 / 105 / 106
-- intended on the pos_* tables, view and sequences.
--
-- Why: those migrations revoked only from public / anon / authenticated and then GRANTed service_role its
-- subset. Supabase's default privileges had already given service_role ALL on every new table / sequence in
-- public, so the GRANTs added nothing and the immutable / no-delete tables stayed UPDATE / DELETE-able
-- (104–106 verify: every "immutable (no update)" / "no delete" check false; 105 smoke "staff deletable").
--
-- What: per relation, `revoke all … from service_role` (also drops TRUNCATE / REFERENCES / TRIGGER /
-- MAINTAIN and any column-level grants), then re-grant the intended set, verbatim from the grant lines:
--
--   101  pos_devices, pos_device_enrollments,          select insert update delete   (101:106-108; 101_verify asserts all four)
--        pos_auth_attempts, pos_device_events
--        sequence pos_device_events_id_seq             usage select                  (101:109)
--   103  pos_menu_snapshots                             select insert                 (103:36  immutable)
--   104  pos_orders                                     select insert update          (104:403)
--        pos_order_lines, pos_order_line_modifiers      select insert update delete   (104:404-405 aggregate upsert)
--        pos_payments                                   select insert update          (104:406 update = void only, trigger)
--        pos_order_submissions                          select insert                 (104:407 immutable)
--        sequence pos_order_number_seq                  usage select                  (104:408)
--   105  pos_staff                                      select insert update          (105:281 never delete)
--        pos_staff_settings                             select insert update          (105:282)
--        pos_staff_snapshots                            select insert                 (105:283 immutable)
--        pos_staff_events                               select insert                 (105:284 append-only)
--   106  pos_shifts                                     select insert update          (106:360 closed = immutable via trigger)
--        pos_cash_movements                             select insert                 (106:361 insert-only)
--        pos_refunds, pos_day_closes,                   select insert                 (106:362-364 immutable)
--        pos_entity_submissions
--        view pos_post_z                                select                        (106:365)
--   102 / 107 create no table, view or sequence (102: a trigger on restaurants; 107: a CHECK on pos_payments).
--
-- Every pos_* SQL function is SECURITY INVOKER, so these grants are what the functions run with; every
-- write they and the pos-v1-* edge functions do fits the set above (see the CP14 notes in the commit).
-- Function EXECUTE grants are unchanged. anon / authenticated / public are not touched (already none).
-- No non-pos relation is touched. No data change. Default privileges are not changed (a future pos_*
-- migration must revoke from service_role itself).
--
-- NOT APPLIED. Needs 101, 103, 104, 105, 106. Rollback: docs/migrations/108_rollback.sql.
-- Smoke: docs/migrations/108_smoke.sql. Verify: docs/migrations/108_verify.sql.

begin;

-- every relation must exist (a typo or a missing migration aborts the whole thing)
do $$
declare r text;
begin
  foreach r in array array[
    'pos_devices', 'pos_device_enrollments', 'pos_auth_attempts', 'pos_device_events', 'pos_device_events_id_seq',
    'pos_menu_snapshots',
    'pos_orders', 'pos_order_lines', 'pos_order_line_modifiers', 'pos_payments', 'pos_order_submissions', 'pos_order_number_seq',
    'pos_staff', 'pos_staff_settings', 'pos_staff_snapshots', 'pos_staff_events',
    'pos_shifts', 'pos_cash_movements', 'pos_refunds', 'pos_day_closes', 'pos_entity_submissions', 'pos_post_z'] loop
    if to_regclass('public.' || r) is null then raise exception '108: public.% missing', r; end if;
  end loop;
end;
$$;

-- 101
revoke all on table public.pos_devices, public.pos_device_enrollments, public.pos_auth_attempts, public.pos_device_events
  from service_role;
grant select, insert, update, delete on table public.pos_devices, public.pos_device_enrollments,
                                              public.pos_auth_attempts, public.pos_device_events to service_role;
revoke all on sequence public.pos_device_events_id_seq from service_role;
grant usage, select on sequence public.pos_device_events_id_seq to service_role;

-- 103
revoke all on table public.pos_menu_snapshots from service_role;
grant select, insert on table public.pos_menu_snapshots to service_role;

-- 104
revoke all on table public.pos_orders, public.pos_order_lines, public.pos_order_line_modifiers,
                    public.pos_payments, public.pos_order_submissions
  from service_role;
grant select, insert, update         on table public.pos_orders               to service_role;
grant select, insert, update, delete on table public.pos_order_lines          to service_role;
grant select, insert, update, delete on table public.pos_order_line_modifiers to service_role;
grant select, insert, update         on table public.pos_payments             to service_role;
grant select, insert                 on table public.pos_order_submissions    to service_role;
revoke all on sequence public.pos_order_number_seq from service_role;
grant usage, select on sequence public.pos_order_number_seq to service_role;

-- 105
revoke all on table public.pos_staff, public.pos_staff_settings, public.pos_staff_snapshots, public.pos_staff_events
  from service_role;
grant select, insert, update on table public.pos_staff           to service_role;
grant select, insert, update on table public.pos_staff_settings  to service_role;
grant select, insert         on table public.pos_staff_snapshots to service_role;
grant select, insert         on table public.pos_staff_events    to service_role;

-- 106
revoke all on table public.pos_shifts, public.pos_cash_movements, public.pos_refunds, public.pos_day_closes,
                    public.pos_entity_submissions, public.pos_post_z
  from service_role;
grant select, insert, update on table public.pos_shifts             to service_role;
grant select, insert         on table public.pos_cash_movements     to service_role;
grant select, insert         on table public.pos_refunds            to service_role;
grant select, insert         on table public.pos_day_closes         to service_role;
grant select, insert         on table public.pos_entity_submissions to service_role;
grant select                 on table public.pos_post_z             to service_role;

commit;
