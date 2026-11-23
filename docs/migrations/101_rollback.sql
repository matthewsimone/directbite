-- Rollback for supabase/migrations/101_pos_device_auth.sql.
-- DESTRUCTIVE: drops every register, enrollment, attempt row and device event. Every enrolled
-- register will answer 401 device_unregistered afterwards (the POS pauses sync; it does not lock —
-- DEVICE-AUTH §7.2) and must be re-enrolled after 101 is re-applied.

select cron.unschedule('pos-auth-attempts-prune')
where exists (select 1 from cron.job where jobname = 'pos-auth-attempts-prune');

begin;

drop function if exists public.pos_revoke_device(uuid, uuid, text, text, timestamptz);
drop function if exists public.pos_record_auth_failed(uuid, uuid, text, timestamptz, int);
drop function if exists public.pos_replay_enrollment(uuid, uuid, text, bigint, timestamptz);
drop function if exists public.pos_consume_enrollment(uuid, uuid, text, uuid, text, text, inet, timestamptz, int);
drop function if exists public.pos_record_enrollment_failure(inet, uuid, timestamptz, int);
drop function if exists public.pos_create_enrollment(uuid, text, uuid, text, text, timestamptz, uuid, timestamptz);
drop function if exists public.pos_next_prefix(uuid);

drop table if exists public.pos_device_events;
drop table if exists public.pos_auth_attempts;
drop table if exists public.pos_device_enrollments;
drop table if exists public.pos_devices;

commit;
