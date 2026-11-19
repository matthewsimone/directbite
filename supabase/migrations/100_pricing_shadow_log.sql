-- 100: pricing_shadow_log — pos-v1 shadow-mode comparisons (CP4).
--
-- One row per create-payment-intent success (create or update path) for a
-- restaurant listed in the POS_V1_SHADOW_RESTAURANTS function secret: what the
-- client charged vs what pos-v1 prices the same cart at, with the mismatch
-- classes and the full server breakdown. Written by the service role from a
-- background task; never read by the app.
--
-- Privacy: no customer PII. No name / phone / email / address / coordinates /
-- session token: ids (restaurant, payment intent, pending order, menu items),
-- cents, classes and the server breakdown only.
--
-- Access: RLS enabled with NO policies, and grants revoked from anon and
-- authenticated → service-role only (the service role bypasses RLS).
--
-- Retention: 90 days, deleted nightly by pg_cron (enabled in this project,
-- see 093). Shadow mode is temporary; drop the table once enforcement ships.

create table if not exists public.pricing_shadow_log (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  restaurant_id       uuid not null,
  payment_intent_id   text,
  pending_order_id    uuid,
  path                text not null,
  outcome             text not null,
  classes             text[] not null default '{}',
  client_amount_cents integer,
  server_total_cents  integer,
  delta_cents         integer,
  server_error_code   text,
  breakdown           jsonb,
  resolved            jsonb,
  detail              jsonb not null default '{}'::jsonb,
  pricing_module_hash text not null,
  source_commit       text not null,
  constraint psl_path_valid    check (path in ('create', 'update')),
  constraint psl_outcome_valid check (outcome in ('compared', 'server_rejected', 'untranslatable', 'no_coords'))
);

create index if not exists idx_psl_restaurant_created on public.pricing_shadow_log (restaurant_id, created_at desc);
create index if not exists idx_psl_created on public.pricing_shadow_log (created_at);
create index if not exists idx_psl_classes on public.pricing_shadow_log using gin (classes);

alter table public.pricing_shadow_log enable row level security;
-- Deliberately no policies.
revoke all on public.pricing_shadow_log from anon, authenticated;

comment on table public.pricing_shadow_log is
  'pos-v1 shadow pricing comparisons. Service-role only (RLS on, no policies). '
  'No customer PII. 90-day retention via pg_cron job pricing-shadow-log-retention.';

-- Retention. Idempotent: cron.schedule with an existing name updates the job.
-- To stop: select cron.unschedule('pricing-shadow-log-retention');
select cron.schedule(
  'pricing-shadow-log-retention',
  '17 4 * * *',
  $$ delete from public.pricing_shadow_log where created_at < now() - interval '90 days' $$
);
