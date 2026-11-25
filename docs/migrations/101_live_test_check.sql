-- 101_live_test_check.sql — CP5c live test, step 2h. READ-ONLY. Run in the Supabase SQL editor.
-- Shows what the live test wrote: registration attempts (IP masked to /24 or /48), the Test Pizza
-- registers (no hashes), and the event trail of the live-test device 471401b9-1b6b-4c22-827c-89e9e7dc87c2.
--
-- How to read the IP: the test ran from a machine whose public IPv4 is in 69.114.134.0/24 (it also has
-- IPv6). If the attempt rows show 69.114.134.0/24 (or that machine's IPv6 /48), the function saw the real
-- client IP (via cf-connecting-ip / x-real-ip / x-forwarded-for — the exact header is the `ip_source` field
-- in the pos-v1-register-device function logs). If they show 0.0.0.0 or a Supabase / Cloudflare address,
-- every register would share one rate-limit bucket → fix before go-live.

-- 1. registration attempts in the last 2 hours
select
  case when family(ip) = 4 then set_masklen(ip, 24)::cidr::text
       else set_masklen(ip, 48)::cidr::text end as ip_masked,
  success,
  at
from public.pos_auth_attempts
where at > now() - interval '2 hours'
order by at;

-- 2. Test Pizza registers (no token hashes)
select d.id, d.prefix, d.label, d.status, d.hardware_model, d.last_app_version, d.last_seen_at,
       d.created_at, d.revoked_at, d.revoked_reason
from public.pos_devices d
where d.restaurant_id = (select id from public.restaurants where slug = 'test')
order by d.prefix;

-- 3. the live-test device's event trail (+ unattributed auth_failed / enrollment_failed in the window)
select e.at, e.type, e.actor, e.detail
from public.pos_device_events e
where e.device_id = '471401b9-1b6b-4c22-827c-89e9e7dc87c2'
   or (e.device_id is null and e.type in ('auth_failed', 'enrollment_failed') and e.at > now() - interval '2 hours')
order by e.at;

-- 4. the enrollment used (lookup 1BTG): state only
select lookup_id, prefix, label, failed_attempts, locked_at, used_at, used_device_id, expires_at
from public.pos_device_enrollments
where lookup_id = '1BTG'
order by created_at;
