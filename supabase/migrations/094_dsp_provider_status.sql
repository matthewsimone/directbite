-- 094_dsp_provider_status.sql
-- Per-restaurant, per-provider DSP status (online / connection) from
-- KitchenHub's IntegrationAccount and IntegrationAccountOnlineStatus webhooks.
-- Written only by kh-webhook (service role). The tablet reads its own rows to
-- show the provider-offline banner. Idempotent.

create table if not exists public.dsp_provider_status (
  restaurant_id     uuid not null references public.restaurants(id),
  provider_id       text not null,
  account_id        text,
  online_status     text,
  connection_status text,
  reason            text,
  pause_until       timestamptz,
  last_event_at     timestamptz not null default now(),
  raw               jsonb,
  primary key (restaurant_id, provider_id)
);

alter table public.dsp_provider_status enable row level security;

revoke all on public.dsp_provider_status from anon;
revoke select, insert, update, delete, truncate, trigger, references
  on public.dsp_provider_status from authenticated;
-- Column-level: the tablet never sees `raw` (full provider payload, including
-- dashboard_url). The tablet query selects only these columns.
grant select (restaurant_id, provider_id, account_id, online_status, connection_status, reason, pause_until, last_event_at)
  on public.dsp_provider_status to authenticated;

drop policy if exists "tablet_read_own_dsp_provider_status" on public.dsp_provider_status;
create policy "tablet_read_own_dsp_provider_status"
  on public.dsp_provider_status for select
  using (restaurant_id in (
    select id from public.restaurants where tablet_email = auth.jwt() ->> 'email'
  ));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dsp_provider_status'
  ) then
    alter publication supabase_realtime add table public.dsp_provider_status;
  end if;
end $$;
