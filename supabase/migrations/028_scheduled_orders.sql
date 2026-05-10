-- Scheduled ordering Stage 1 — schema additions.
-- Adds scheduled_for + accepted_at columns to orders, expands the status
-- enum to include 'scheduled', adds notification_email to restaurants,
-- and indexes scheduled orders for efficient tablet polling.

-- Nullable: null = ASAP order, non-null = future order.
alter table orders add column if not exists scheduled_for timestamptz;

-- Set when the restaurant taps Accept on a scheduled order.
alter table orders add column if not exists accepted_at timestamptz;

-- Status enum gains 'scheduled'. Drop-then-add is the only way to update
-- a CHECK constraint in Postgres; idempotent because both sides use IF
-- EXISTS / IF NOT EXISTS-style guards (drop is idempotent via IF EXISTS;
-- the add has no IF NOT EXISTS but is safe to re-run because the prior
-- DROP removed any prior copy).
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('new', 'in_progress', 'scheduled', 'complete', 'cancelled'));

-- Restaurant-side email recipient for new-order notifications. Distinct
-- from tablet_email (which is the auth login).
alter table restaurants add column if not exists notification_email text;

-- Composite index for the future "Scheduled" tab on the tablet —
-- queries filter by (restaurant_id, status, scheduled_for) and want
-- chronological order. Partial-where excludes ASAP rows so the index
-- stays compact.
create index if not exists idx_orders_scheduled_for
  on orders(restaurant_id, status, scheduled_for)
  where scheduled_for is not null;
