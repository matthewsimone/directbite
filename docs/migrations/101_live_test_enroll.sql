-- 101_live_test_enroll.sql — CP5c live test, step 1. Run ONCE in the Supabase SQL editor (as postgres).
--
-- Creates ONE new-device enrollment for Test Pizza (slug 'test') with a throwaway code:
--     1BTG-GPJ60X   (lookup 1BTG + secret GPJ60X; single use, expires in 30 min, test restaurant only)
-- secret_hash = sha256 hex of the UTF-8 secret, exactly as _shared/pos-device/tokens.ts sha256Hex(secret)
-- (cross-checked: tokens.ts, `shasum -a 256` and the SQL below all give 7db7fa0b…).
-- created_by is a fixed dummy uuid (no admin session in the SQL editor).
--
-- Expected result: one row, ok = true, with the allocated prefix and the label 'Live test'.
-- If ok = false: reason 'lookup_taken' → ask Claude for a new code; 'unknown_restaurant' → slug 'test' missing.

select public.pos_create_enrollment(
  (select id from public.restaurants where slug = 'test'),   -- p_restaurant_id
  'Live test',                                               -- p_label
  null,                                                      -- p_target_device_id (new device)
  '1BTG',                                                    -- p_lookup_id
  encode(sha256(convert_to('GPJ60X', 'UTF8')), 'hex'),       -- p_secret_hash
  now() + interval '30 minutes',                             -- p_expires_at
  '00000000-0000-4000-8000-00000000c5c0'::uuid,              -- p_created_by (dummy)
  now()                                                      -- p_at
) as result;
