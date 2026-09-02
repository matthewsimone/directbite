-- 087_ready_time_confirmation.sql
-- Additive only. Applied manually in the Supabase SQL Editor on 2026-09-02.
-- Nothing reads these columns until the tablet action bar ships.

alter table orders
  add column if not exists quoted_for timestamptz;

alter table orders
  add column if not exists ready_email_sent_at timestamptz;

alter table restaurants
  add column if not exists ready_time_confirmation_enabled boolean not null default false;

comment on column orders.quoted_for is
  'Operator-confirmed promise time. Pickup = ready at counter. Delivery = at customer door. Null until confirmed. Never set for uber_direct or scheduled orders.';

comment on column orders.ready_email_sent_at is
  'Idempotency guard for send-ready-email. Non-null means the ready email was sent; never send twice.';

comment on column restaurants.ready_time_confirmation_enabled is
  'Per-restaurant flag. When false the tablet renders the pre-existing action bar and no ready email is sent.';
