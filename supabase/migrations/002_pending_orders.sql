-- ============================================================
-- Pending Orders (temporary storage for checkout data)
-- ============================================================

create table pending_orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  order_data jsonb not null,
  created_at timestamptz not null default now()
);

-- Auto-clean stale pending orders older than 24 hours
-- (can be run via pg_cron or a scheduled function)

-- RLS: allow anonymous inserts and service-role reads
alter table pending_orders enable row level security;

create policy "anon can insert pending orders"
  on pending_orders for insert
  to anon
  with check (true);

create policy "service role full access on pending orders"
  on pending_orders for all
  to service_role
  using (true)
  with check (true);
