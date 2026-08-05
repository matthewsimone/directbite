-- 067_otp_cooldown_index.sql
-- Closes the send-cooldown race: two concurrent 'send' calls for the same
-- phone can both pass the app-level 60s check before either inserts, which
-- would mean two paid SMS. This caps one OTP consent row per phone per
-- clock-minute at the database level.
--
-- date_trunc on a timestamptz is not IMMUTABLE (session timezone dependent),
-- so created_at is converted to a plain timestamp at UTC first.
--
-- The edge function's insert uses ON CONFLICT DO NOTHING, so a losing race
-- is silently absorbed rather than surfacing as an error after Twilio has
-- already sent the message.

begin;

create unique index if not exists idx_lt_consent_otp_cooldown
  on customer_consents (phone_e164, date_trunc('minute', created_at at time zone 'UTC'))
  where kind = 'otp_verification';

commit;