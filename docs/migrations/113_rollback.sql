-- 113_rollback.sql — undo migration 113: drop pos_online_action_finish + pos_online_adjustment_request, restore 111's
-- outcome CHECK and 111's pos_online_action_begin (no `since`). Run as postgres in the SQL editor. Leaves 111 / 112.
--
-- A PENDING cancel_refund row can't exist under 111's CHECK. If any exists the rollback STOPS (a refund may be in
-- flight — look at it first), unless you run, in the same session:   set pos.rollback_113_discard = 'yes';
-- which DELETES those pending rows only. Completed money rows (applied / noop / error) are valid 111 rows and stay.
-- The adjustment_requests rows the POS inserted are the web's own rows (admin approves / denies them) and stay.
-- Roll back only with pos-v1-online-order-action undeployed or redeployed without cancel_refund / adjustment_request.

begin;

do $$
begin
  if exists (select 1 from public.pos_online_actions where outcome is null and function = 'order_action') then
    if coalesce(current_setting('pos.rollback_113_discard', true), '') <> 'yes' then
      raise exception '113 rollback: a pending cancel_refund exists; check it, then set pos.rollback_113_discard = ''yes'' to delete it, or stop'
        using errcode = '55000';
    end if;
    delete from public.pos_online_actions where outcome is null and function = 'order_action';
  end if;
end;
$$;

drop function if exists public.pos_online_action_finish(uuid, uuid, text, int, text, text);
drop function if exists public.pos_online_adjustment_request(uuid, uuid, uuid, uuid, text, text, bigint, text, jsonb, text, uuid, timestamptz);

alter table public.pos_online_actions drop constraint pos_online_actions_outcome_check;
alter table public.pos_online_actions
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and function = 'print') or (outcome is not null and outcome in ('applied', 'noop', 'error')));

-- 111's begin, verbatim (111_pos_online_actions.sql :151-188)
create or replace function public.pos_online_action_begin(
  p_action_id uuid, p_function text, p_restaurant_id uuid, p_device_id uuid, p_order_channel text, p_order_id uuid,
  p_action text, p_request jsonb, p_actor text, p_approver uuid, p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a public.pos_online_actions;
  v_hash text;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_online_action_begin: request must be an object' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                         request, request_hash, actor_staff_id, approver_staff_id, device_time)
  values (p_action_id, p_function, p_restaurant_id, p_device_id, p_order_channel, p_order_id, p_action,
          p_request, v_hash, p_actor, p_approver, p_device_time)
  on conflict (action_id) do nothing
  returning * into a;
  if found then
    return jsonb_build_object('outcome', 'started');
  end if;
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if a.function <> p_function or a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id
     or a.order_channel is distinct from p_order_channel or a.order_id is distinct from p_order_id
     or a.action <> p_action or a.request_hash <> v_hash then
    return jsonb_build_object('outcome', 'action_id_reused');
  end if;
  if a.outcome is null then
    return jsonb_build_object('outcome', 'pending');
  end if;
  return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome, 'error_status', a.error_status,
                            'error_code', a.error_code, 'error_message', a.error_message, 'order_ids', to_jsonb(a.order_ids));
end;
$$;
revoke all on function public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz) to service_role;

commit;
