-- 103_pos_menu_snapshots.sql — POS menu snapshots (ordr-pos SYNC-CONTRACT §4; DIRECTBITE-HANDOFF item 1).
--
-- 1. restaurants.address_street / address_city / address_state / address_zip (nullable text): the
--    structured restaurant address the snapshot serves as restaurant.address (Matt, CP9). The existing
--    free-text restaurants.address is left untouched. Backfill is SEPARATE and reviewed first:
--    docs/migrations/103_address_parse_preview.sql (SELECT only) → docs/migrations/103_address_backfill.sql.
-- 2. pos_menu_snapshots: every snapshot pos-v1-menu-snapshot serves, keyed by its content hash,
--    immutable, never deleted while an order references it (no deletes are issued anywhere).
--    RLS on, no policies, revoked from anon / authenticated → service role only.
--
-- NOT APPLIED. Rollback: docs/migrations/103_rollback.sql. Smoke: 103_smoke.sql. Verify: 103_verify.sql.

begin;

alter table public.restaurants
  add column if not exists address_street text,
  add column if not exists address_city   text,
  add column if not exists address_state  text,
  add column if not exists address_zip    text;

comment on column public.restaurants.address_street is 'Structured address (103) — POS snapshot restaurant.address.street. restaurants.address stays the display string.';
comment on column public.restaurants.address_state  is 'Two-letter state (103).';
comment on column public.restaurants.address_zip    is 'ZIP / ZIP+4 (103).';

create table public.pos_menu_snapshots (
  hash            text primary key check (hash ~ '^[0-9a-f]{64}$'),
  restaurant_id   uuid not null references public.restaurants(id),
  body            jsonb not null,
  first_served_at timestamptz not null default now()
);
create index pos_menu_snapshots_restaurant on public.pos_menu_snapshots (restaurant_id, first_served_at desc);

alter table public.pos_menu_snapshots enable row level security;
-- Deliberately no policies.
revoke all on table public.pos_menu_snapshots from public, anon, authenticated;
grant select, insert on table public.pos_menu_snapshots to service_role;   -- immutable: no update / delete

comment on table public.pos_menu_snapshots is
  'Every POS menu snapshot served (SYNC-CONTRACT §4), keyed by content hash. Immutable; service-role only; never delete while an order references it.';

commit;
