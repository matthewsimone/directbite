-- 093_kh_backstop_cron.sql
-- Schedules the kh-backstop edge function every 2 minutes (re-delivers
-- KitchenHub orders the webhook missed).
--
-- Requires, BEFORE running this file:
--   - pg_cron and pg_net extensions enabled (Dashboard → Database → Extensions).
--   - Vault secrets 'project_url' (https://<project-ref>.supabase.co) and
--     'kh_backstop_secret' (same value as the KH_BACKSTOP_SECRET function
--     secret). Both are created manually in the SQL Editor and are never
--     committed; this job reads them from vault.decrypted_secrets at run time,
--     so the job text carries no secret.
--
-- Idempotent: cron.schedule with an existing job name updates that job.
-- To stop it: select cron.unschedule('kh-backstop');

select cron.schedule(
  'kh-backstop',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/kh-backstop',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ordr-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'kh_backstop_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
