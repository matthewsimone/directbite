-- 102_push_tokens.sql
-- FCM registration tokens for native app push (Phase 3). One row per device
-- token; a token belongs to one signed-in identity at one restaurant app.
-- Written only by customer-auth (register_push / unregister_push / logout /
-- delete_account) and read by send-push, both service role. RLS on, no
-- policies. Identity or restaurant delete cascades.
begin;

create table if not exists push_tokens (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,
  customer_id   uuid not null references customer_identities(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  platform      text not null,
  app_id        text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_error    text,
  disabled_at   timestamptz,
  constraint push_tokens_platform_valid check (platform in ('ios', 'android')),
  constraint push_tokens_token_len check (length(token) between 20 and 4096)
);

create index if not exists idx_push_tokens_restaurant_active
  on push_tokens (restaurant_id) where disabled_at is null;
create index if not exists idx_push_tokens_customer
  on push_tokens (customer_id);

alter table push_tokens enable row level security;

commit;
