set lock_timeout = '3s';
-- 114_pos_online_uber.sql — pos-v1-online-order-action UBER actions (CP20; ordr-pos @ 4f729e4 SYNC-CONTRACT §3c
-- :629-630, src/dev/onlineActionRules.ts :195-227). dispatch_delivery = uber-create-delivery (the shared core
-- _shared/uberCreateDelivery.ts imported unchanged); self_deliver = uber-self-deliver (_shared/uberCancel.ts +
-- _shared/refundUberAppFee.ts imported unchanged). The Uber calls and the orders writes happen in TS between a
-- PENDING pos_online_actions row and its finish (113's functions).
--
-- pos_* ONLY. NO column / trigger / default / constraint on orders, uber_quotes or any live-path table.
--
--   pos_online_actions  the outcome CHECK also allows a PENDING order_action row for dispatch_delivery / self_deliver
--                       (with 113's cancel_refund and print).
--                       DELETE is granted to service_role, guarded: ONLY a pending dispatch_delivery / self_deliver
--                       row may be deleted (trg_pos_online_actions_release_guard) — the release of an attempt that
--                       provably booked nothing (Uber answered rate_limited) so the resend starts fresh (CP20
--                       decision 3: 503 + Retry-After, NOT stored). Every other row stays immutable / undeletable.
--   pos_online_action_release(action_id, device)  NEW → released | not_found | device_mismatch | not_pending.
--
-- Access (the 108 pattern): pos_online_actions `revoke all … from service_role`, then exactly select insert update
-- delete; EXECUTE on the release function to service_role only; SECURITY INVOKER.
--
-- NOT APPLIED. Needs 113. Rollback: docs/migrations/114_rollback.sql. Smoke: docs/migrations/114_smoke.sql.
-- Verify: docs/migrations/114_verify.sql.

begin;

do $$
begin
  if to_regprocedure('public.pos_online_action_finish(uuid, uuid, text, int, text, text)') is null then
    raise exception '114: migration 113 is not applied (pos_online_action_finish missing)' using errcode = '55000';
  end if;
end;
$$;

alter table public.pos_online_actions drop constraint pos_online_actions_outcome_check;
alter table public.pos_online_actions
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and (function = 'print'
                          or (function = 'order_action' and action in ('cancel_refund', 'dispatch_delivery', 'self_deliver'))))
    or (outcome is not null and outcome in ('applied', 'noop', 'error')));

-- Only a pending dispatch_delivery / self_deliver row may be deleted (the release); everything else: refused.
create or replace function public.pos_online_actions_release_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.outcome is not null or old.function <> 'order_action' or old.action not in ('dispatch_delivery', 'self_deliver') then
    raise exception 'pos_online_actions: only a pending dispatch_delivery / self_deliver may be released' using errcode = '42501';
  end if;
  return old;
end;
$$;
create trigger trg_pos_online_actions_release_guard before delete on public.pos_online_actions
  for each row execute function public.pos_online_actions_release_guard();

-- release → released | not_found | device_mismatch | not_pending (completed, or not a dispatch / self-deliver).
create or replace function public.pos_online_action_release(p_action_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  select * into a from public.pos_online_actions where action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if a.device_id <> p_device_id then
    return jsonb_build_object('outcome', 'device_mismatch');
  end if;
  if a.outcome is not null or a.function <> 'order_action' or a.action not in ('dispatch_delivery', 'self_deliver') then
    return jsonb_build_object('outcome', 'not_pending');
  end if;
  delete from public.pos_online_actions where action_id = p_action_id;
  return jsonb_build_object('outcome', 'released');
end;
$$;

-- access (108 pattern)
revoke all on table public.pos_online_actions from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pos_online_actions to service_role;  -- delete: the release only (trigger)
revoke all on function public.pos_online_action_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pos_online_action_release(uuid, uuid) to service_role;
revoke all on function public.pos_online_actions_release_guard() from public, anon, authenticated;

comment on function public.pos_online_action_release(uuid, uuid) is
  'Deletes a PENDING dispatch_delivery / self_deliver action that provably did nothing (Uber rate_limited) so its resend starts fresh.';

commit;
