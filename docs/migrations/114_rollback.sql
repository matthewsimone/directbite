set lock_timeout = '3s';
-- 114_rollback.sql — undo migration 114: drop pos_online_action_release + the delete guard, restore 113's outcome
-- CHECK and 113's grants on pos_online_actions (select insert update — no delete). Run as postgres in the SQL editor.
--
-- A PENDING dispatch_delivery / self_deliver row can't exist under 113's CHECK. If any exists the rollback STOPS (an
-- Uber call may be in flight — look at it first), unless you run, in the same session:
--   set pos.rollback_114_discard = 'yes';
-- which DELETES those pending rows only. Completed Uber rows (applied / noop / error) are valid 113 rows and stay.
-- Roll back only with pos-v1-online-order-action undeployed or redeployed without dispatch_delivery / self_deliver.

begin;

do $$
begin
  if exists (select 1 from public.pos_online_actions
              where outcome is null and function = 'order_action' and action in ('dispatch_delivery', 'self_deliver')) then
    if coalesce(current_setting('pos.rollback_114_discard', true), '') <> 'yes' then
      raise exception '114 rollback: a pending dispatch_delivery / self_deliver exists; check it, then set pos.rollback_114_discard = ''yes'' to delete it, or stop'
        using errcode = '55000';
    end if;
    -- runs as postgres; the delete guard allows exactly these rows
    delete from public.pos_online_actions
     where outcome is null and function = 'order_action' and action in ('dispatch_delivery', 'self_deliver');
  end if;
end;
$$;

drop function if exists public.pos_online_action_release(uuid, uuid);
drop trigger if exists trg_pos_online_actions_release_guard on public.pos_online_actions;
drop function if exists public.pos_online_actions_release_guard();

alter table public.pos_online_actions drop constraint pos_online_actions_outcome_check;
alter table public.pos_online_actions
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and (function = 'print' or (function = 'order_action' and action = 'cancel_refund')))
    or (outcome is not null and outcome in ('applied', 'noop', 'error')));

-- 113's grants, exactly (no delete)
revoke all on table public.pos_online_actions from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_online_actions to service_role;

commit;
