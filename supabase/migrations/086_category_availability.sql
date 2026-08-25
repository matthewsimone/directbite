-- 086_category_availability.sql
-- Already applied live via the Supabase SQL Editor; committed idempotent so the
-- repo matches the database.

alter table menu_categories
  add column if not exists availability jsonb;

alter table menu_categories
  drop constraint if exists menu_categories_availability_is_object;

alter table menu_categories
  add constraint menu_categories_availability_is_object
  check (availability is null or jsonb_typeof(availability) = 'object');

comment on column menu_categories.availability is
  'NULL = always available. Otherwise a per-day map keyed by day_of_week as a '
  'string ("0"=Sunday .. "6"=Saturday), same shape as restaurants.uber_schedule: '
  '{"2":{"enabled":true,"start":"11:00","end":"15:00"}}. A day absent or '
  'enabled=false is unavailable that day. enabled=true with null/absent start+end '
  'means all day. Overnight windows (start > end) are NOT supported. '
  'Consumers fail OPEN: malformed value = always available.';
