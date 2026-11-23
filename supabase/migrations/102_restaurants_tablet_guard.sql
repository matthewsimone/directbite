-- 102_restaurants_tablet_guard.sql — N2: a tablet login may no longer change admin-only columns of
-- its restaurant (docs/POS-SERVER-STATUS.md N2; RLS tablet_update_own_restaurant, 001:253-256, has
-- no column limits).
--
-- A BEFORE UPDATE trigger on restaurants: when the caller is a signed-in non-admin
-- (current_user authenticated / anon AND NOT public.is_admin()), any change to a PROTECTED column
-- raises 'column % is admin-only' (SQLSTATE 42501 → PostgREST 403). Unchanged values pass, so the
-- tablet's `update(...).select()` of its own fields keeps working.
--
-- Bypassed: admins (is_admin(), 004:14-21), service_role (every edge function), postgres (SQL editor,
-- migrations). Columns are read through to_jsonb(NEW / OLD), so a protected name that doesn't exist
-- live is simply null on both sides — it can never break an UPDATE.
--
-- PROTECTED (none of these is written by any tablet code path today — CP8 §B1):
--   identity / routing : id, slug, name, phone, address, tablet_email, custom_domain,
--                        website_enabled, redirect_url, timezone, created_at,
--                        address_street / _city / _state / _zip (103; harmless before 103 exists)
--   location (fees)    : latitude, longitude
--   ordering on/off    : is_open (admin Pause today; the POS pause goes through a server function)
--   payments           : stripe_account_id, apple_pay_registered, recoup_enabled, recoup_rate,
--                        delivery_fee (legacy)
--   Uber billing / env : uber_billing_mode, uber_credentials_verified_at, uber_environment
--   DSP                : dsp_orders_enabled
--   loyalty money      : loyalty_enabled, loyalty_points_per_dollar, loyalty_earn_basis
-- NOT protected because the tablet writes them on purpose (Settings): tax_rate, delivery tiers /
-- radius / minimums, delivery_available, Uber mode / passthrough / schedule / credentials, printer,
-- hours schedules, estimates, notifications, website content (see CP8 §B1 for file:line).
--
-- NOT APPLIED. Rollback: docs/migrations/102_rollback.sql. Smoke: docs/migrations/102_smoke.sql.

begin;

create or replace function public.restaurants_tablet_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_protected constant text[] := array[
    'id', 'slug', 'name', 'phone', 'address', 'tablet_email', 'custom_domain', 'website_enabled',
    'redirect_url', 'timezone', 'created_at',
    'address_street', 'address_city', 'address_state', 'address_zip',
    'latitude', 'longitude',
    'is_open',
    'stripe_account_id', 'apple_pay_registered', 'recoup_enabled', 'recoup_rate', 'delivery_fee',
    'uber_billing_mode', 'uber_credentials_verified_at', 'uber_environment',
    'dsp_orders_enabled',
    'loyalty_enabled', 'loyalty_points_per_dollar', 'loyalty_earn_basis'
  ];
  v_old jsonb;
  v_new jsonb;
  v_col text;
begin
  -- Only API callers (PostgREST switches to these roles). service_role / postgres pass.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  foreach v_col in array v_protected loop
    if (v_new -> v_col) is distinct from (v_old -> v_col) then
      raise exception 'column % is admin-only', v_col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.restaurants_tablet_guard() from public, anon, authenticated;

drop trigger if exists trg_restaurants_tablet_guard on public.restaurants;
create trigger trg_restaurants_tablet_guard
  before update on public.restaurants
  for each row execute function public.restaurants_tablet_guard();

comment on function public.restaurants_tablet_guard() is
  'N2 (102): blocks non-admin API callers from changing admin-only restaurants columns. Admins, service_role and postgres bypass.';

commit;
