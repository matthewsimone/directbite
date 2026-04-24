-- SMS alert columns on restaurants
alter table restaurants add column sms_enabled boolean not null default false;
alter table restaurants add column sms_phone text;

-- SMS logs table
create table sms_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  to_phone text not null,
  message text not null,
  status text not null default 'sent',
  twilio_sid text,
  error text,
  sent_at timestamptz not null default now(),
  constraint sms_logs_status_check check (status in ('sent', 'failed'))
);

create index idx_sms_logs_order on sms_logs(order_id);

alter table sms_logs enable row level security;

-- Tablet can read own SMS logs
create policy "tablet_read_own_sms_logs" on sms_logs
  for select using (restaurant_id in (
    select id from restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

-- Admin full access
create policy "admin_all_sms_logs" on sms_logs
  for all using (is_admin()) with check (is_admin());
