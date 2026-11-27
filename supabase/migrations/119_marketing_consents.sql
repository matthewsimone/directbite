-- 119: marketing consents (Marketing chat). Additive only.
alter table restaurants add column if not exists legal_name   text;
alter table restaurants add column if not exists public_email text;

create table if not exists marketing_consents (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id) on delete cascade,
  channel          text not null check (channel in ('sms','email')),
  address          text not null,
  status           text not null check (status in ('subscribed','unsubscribed')),
  customer_id      uuid references customer_identities(id) on delete set null,
  subscribed_at    timestamptz,
  unsubscribed_at  timestamptz,
  updated_at       timestamptz not null default now(),
  unique (restaurant_id, channel, address)
);
create index if not exists idx_mc_send
  on marketing_consents (restaurant_id, channel) where status = 'subscribed';

create table if not exists marketing_consent_events (
  id              uuid primary key default gen_random_uuid(),
  consent_id      uuid not null references marketing_consents(id) on delete cascade,
  action          text not null check (action in ('opt_in','opt_out')),
  source          text not null,
  text_shown      text,
  policy_version  text,
  order_ref       text,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_mce_consent
  on marketing_consent_events (consent_id, created_at desc);

alter table marketing_consents       enable row level security;
alter table marketing_consent_events enable row level security;
