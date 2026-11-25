set lock_timeout = '3s';
-- 113_pos_online_money.sql — pos-v1-online-order-action MONEY actions (CP19; ordr-pos @ 4f729e4 SYNC-CONTRACT §3c
-- :608-610, :627-628, DIRECTBITE-HANDOFF item 11, src/dev/onlineActionRules.ts :159-170, :243-258) — Matt's final
-- decisions: extra charge / refund after Complete = the web's EXISTING adjustment request (an admin approves in
-- /admin, admin-approve-adjustment moves the money); Cancel & Refund = admin-refund's logic UNCHANGED (the glue runs
-- in TS: _shared/pos-online/adminRefundGlue.ts, its web source range pinned by hash).
--
-- pos_* ONLY. NO column / trigger / default / constraint on orders, adjustment_requests or any live-path table.
--
--   pos_online_actions  the outcome CHECK also allows a PENDING row for order_action / cancel_refund (the Stripe /
--                       Uber calls happen in TS between begin and finish — the pending row is what stops a
--                       concurrent or crashed resend from refunding twice). Nothing else changes.
--   pos_online_action_begin  same signature (111); a pending answer now also carries `since` (the row's
--                       created_at) so the caller can tell a crashed attempt (re-run, safe: see adminRefundGlue.ts)
--                       from one still in flight.
--   pos_online_action_finish(action_id, device, outcome, error_status, error_code, error_message)  NEW: completes a
--                       pending row with applied | noop | error (money errors ARE stored — §3c:608-610 "or the same
--                       error": the resend answers the stored error, never a second Stripe / Uber call).
--   pos_online_adjustment_request(…)  NEW, ONE transaction: idempotency + compare-and-set (status = expected AND
--                       status = complete) + the tablet's EXACT insert (OrdersTab.jsx :729-736: adjustment_requests
--                       {order_id, order_number, restaurant_id, type, amount (dollars), note}; status / id /
--                       created_at = the table's defaults) + the action row. A refused state (409 status_conflict,
--                       400 action_not_allowed) is stored as the action's error.
--
-- Access: EXECUTE to service_role only on the two new functions (+ 111's begin re-asserted); SECURITY INVOKER
-- (service_role's existing privileges on orders / adjustment_requests — 113_verify checks them, grants nothing on
-- live tables). pos_online_actions grants unchanged (select insert update).
--
-- NOT APPLIED. Needs 111. Rollback: docs/migrations/113_rollback.sql. Smoke: docs/migrations/113_smoke.sql.
-- Verify: docs/migrations/113_verify.sql.

begin;

do $$
begin
  if to_regprocedure('public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz)') is null then
    raise exception '113: migration 111 is not applied (pos_online_action_begin missing)' using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_online_actions: a pending cancel_refund
-- ---------------------------------------------------------------------------------------------

alter table public.pos_online_actions drop constraint pos_online_actions_outcome_check;
alter table public.pos_online_actions
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and (function = 'print' or (function = 'order_action' and action = 'cancel_refund')))
    or (outcome is not null and outcome in ('applied', 'noop', 'error')));

-- 111's begin, unchanged except: a pending answer carries `since`.
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
    return jsonb_build_object('outcome', 'pending', 'since', a.created_at);
  end if;
  return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome, 'error_status', a.error_status,
                            'error_code', a.error_code, 'error_message', a.error_message, 'order_ids', to_jsonb(a.order_ids));
end;
$$;

-- finish → completed | not_found | device_mismatch | already_completed {stored}. 22023 on a bad outcome / error.
create or replace function public.pos_online_action_finish(
  p_action_id uuid, p_device_id uuid, p_outcome text, p_error_status int, p_error_code text, p_error_message text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  if p_outcome is null or p_outcome not in ('applied', 'noop', 'error')
     or (p_outcome = 'error') <> (p_error_status is not null and p_error_code is not null) then
    raise exception 'pos_online_action_finish: outcome applied | noop | error (+ status and code)' using errcode = '22023';
  end if;
  select * into a from public.pos_online_actions where action_id = p_action_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if a.device_id <> p_device_id then
    return jsonb_build_object('outcome', 'device_mismatch');
  end if;
  if a.outcome is not null then
    return jsonb_build_object('outcome', 'already_completed', 'stored', a.outcome);
  end if;
  update public.pos_online_actions
     set outcome = p_outcome, completed_at = now(),
         error_status = case when p_outcome = 'error' then p_error_status end,
         error_code = case when p_outcome = 'error' then p_error_code end,
         error_message = case when p_outcome = 'error' then left(p_error_message, 500) end
   where action_id = p_action_id;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- adjustment_request (the tablet's ADJUST)
-- ---------------------------------------------------------------------------------------------
-- → device_not_allowed | action_id_reused | duplicate {stored, error_*} | unknown_order | restaurant_mismatch |
--   error {error_status, error_code, error_message} (stored: 409 status_conflict, 400 action_not_allowed) | applied.
-- The caller validated type / amount / note (+ the card-number guard); re-checked here (22023).
create or replace function public.pos_online_adjustment_request(
  p_action_id uuid, p_restaurant_id uuid, p_device_id uuid, p_order_id uuid, p_expected_status text,
  p_type text, p_amount_cents bigint, p_note text,
  p_request jsonb, p_actor text, p_approver uuid, p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a        public.pos_online_actions;
  v_hash   text;
  v_now    timestamptz := now();
  v_status text;
  v_num    bigint;
  v_rid    uuid;
  v_written timestamptz;
  v_es     int;
  v_ec     text;
  v_em     text;
begin
  if p_order_id is null or p_expected_status is null then
    raise exception 'pos_online_adjustment_request: order_id and expected_status are required' using errcode = '22023';
  end if;
  if p_type is null or p_type not in ('charge', 'refund') then
    raise exception 'pos_online_adjustment_request: type charge | refund' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'pos_online_adjustment_request: amount_cents > 0' using errcode = '22023';
  end if;
  if p_note is null or p_note <> btrim(p_note) or length(p_note) not between 1 and 200 then
    raise exception 'pos_online_adjustment_request: a trimmed note of 1–200 characters' using errcode = '22023';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_online_adjustment_request: request must be an object' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;

  v_hash := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('pos_online_action:' || p_action_id::text, 0));
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if found then
    if a.function <> 'order_action' or a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id
       or a.order_id is distinct from p_order_id or a.action <> 'adjustment_request' or a.request_hash <> v_hash then
      return jsonb_build_object('outcome', 'action_id_reused');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome, 'error_status', a.error_status,
                              'error_code', a.error_code, 'error_message', a.error_message, 'order_ids', to_jsonb(a.order_ids));
  end if;

  select o.status, o.order_number, o.restaurant_id, o.items_written_at into v_status, v_num, v_rid, v_written
    from public.orders o where o.id = p_order_id
     for update;
  if not found or v_written is null then
    return jsonb_build_object('outcome', 'unknown_order');
  end if;
  if v_rid <> p_restaurant_id then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;

  if v_status is distinct from p_expected_status then
    v_es := 409; v_ec := 'status_conflict'; v_em := 'the order is ' || v_status;
  elsif v_status <> 'complete' then
    v_es := 400; v_ec := 'action_not_allowed'; v_em := 'an adjustment is requested on a complete order';
  end if;
  if v_es is not null then
    insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                           request, request_hash, outcome, error_status, error_code, error_message,
                                           actor_staff_id, approver_staff_id, device_time, created_at, completed_at)
    values (p_action_id, 'order_action', p_restaurant_id, p_device_id, 'ordr', p_order_id, 'adjustment_request',
            p_request, v_hash, 'error', v_es, v_ec, v_em, p_actor, p_approver, p_device_time, v_now, v_now);
    return jsonb_build_object('outcome', 'error', 'error_status', v_es, 'error_code', v_ec, 'error_message', v_em);
  end if;

  -- OrdersTab.jsx submitAdjustment :729-736, verbatim columns; amount in DOLLARS (the tablet: parseFloat of the
  -- typed dollars) — exact from integer cents
  insert into public.adjustment_requests (order_id, order_number, restaurant_id, type, amount, note)
  values (p_order_id, v_num, p_restaurant_id, p_type, p_amount_cents::numeric / 100, p_note);

  insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                         request, request_hash, outcome, actor_staff_id, approver_staff_id, device_time,
                                         created_at, completed_at)
  values (p_action_id, 'order_action', p_restaurant_id, p_device_id, 'ordr', p_order_id, 'adjustment_request',
          p_request, v_hash, 'applied', p_actor, p_approver, p_device_time, v_now, v_now);
  return jsonb_build_object('outcome', 'applied');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz)',
    'public.pos_online_action_finish(uuid, uuid, text, int, text, text)',
    'public.pos_online_adjustment_request(uuid, uuid, uuid, uuid, text, text, bigint, text, jsonb, text, uuid, timestamptz)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

comment on function public.pos_online_adjustment_request(uuid, uuid, uuid, uuid, text, text, bigint, text, jsonb, text, uuid, timestamptz) is
  'pos-v1-online-order-action adjustment_request: the tablet''s exact adjustment_requests insert (complete orders, compare-and-set) + the action row, in one transaction.';
comment on function public.pos_online_action_finish(uuid, uuid, text, int, text, text) is
  'Completes a pending POS action (cancel_refund / print) with applied | noop | error — money errors are stored and replayed.';

commit;
