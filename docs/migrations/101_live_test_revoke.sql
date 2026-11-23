-- 101_live_test_revoke.sql — CP5c live test, step 3. Run ONCE in the Supabase SQL editor (as postgres).
-- Revokes the live-test register on Test Pizza. Expected result: 'revoked'.
-- Afterwards pos-v1-device-check with that register's token must answer 401 device_revoked.
-- The device can only come back through an admin-issued re-enroll code (DEVICE-AUTH §4.1).

select public.pos_revoke_device(
  '471401b9-1b6b-4c22-827c-89e9e7dc87c2'::uuid,               -- p_device_id (live test register, prefix A)
  (select id from public.restaurants where slug = 'test'),    -- p_restaurant_id (Test Pizza)
  'live test done',                                           -- p_reason
  'matt',                                                     -- p_actor
  now()                                                       -- p_at
) as result;
