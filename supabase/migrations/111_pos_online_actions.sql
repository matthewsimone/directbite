-- 111_pos_online_actions.sql — POS online ORDER ACTIONS + SETTINGS (CP18; ordr-pos @ 86c558d SYNC-CONTRACT §3c
-- `pos-v1-online-order-action` / `pos-v1-online-settings`, DIRECTBITE-HANDOFF item 11 DDL (pos_online_actions),
-- src/dev/onlineActionRules.ts, src/dev/onlineSettingsRules.ts).
--
-- What changes (pos_* only — NO column / trigger / default / sequence / FK on orders, order_items, external_orders,
-- restaurants, print_logs or any live-path table):
--
--   pos_online_actions   RESHAPED to the handoff DDL: function (order_action | print | settings), order_channel,
--                        order_id NULLABLE (complete_all_in_progress / settings), request_hash (SHA-256 of the
--                        request minus device_time), outcome (applied | noop | error; NULL = a print action still
--                        pending), error_status / error_code / error_message, order_ids (complete_all_in_progress),
--                        ready_email_sent (+ unique per order), actor_staff_id, approver_staff_id, device_time.
--                        109's staff_id / result / http_status are gone. `request` (jsonb) is KEPT for the audit.
--
-- Functions (SECURITY INVOKER, service_role only):
--   pos_online_action_begin / pos_online_action_complete   109's names, NEW signatures (the print function's
--                        idempotency: begin = a pending row, complete = its outcome — 109's versions are dropped).
--   pos_online_order_action(…)  ONE transaction: idempotency by action_id + the Ordr order's compare-and-set write +
--                        the action row. The write is EXACTLY the web tablet's (src/pages/tablet/OrdersTab.jsx,
--                        SettingsTab.jsx, src/hooks/useOrderPolling.js):
--                          ack              acknowledged_at = now   (only while null — else noop)    OrdersTab :1728-1734
--                          stuck_ack        stuck_acknowledged_at = now                               OrdersTab :1741-1747
--                          accept           status in_progress + accepted_at (+ quoted_for = now + N) OrdersTab :563-573, :702-707
--                          schedule         status scheduled + accepted_at                            OrdersTab :563-573
--                          complete         status complete                                           OrdersTab :566-573
--                          complete_all_in_progress  status complete WHERE restaurant + status in_progress   SettingsTab :490-494
--                          wake_scheduled   status in_progress WHERE status scheduled (accepted_at untouched) useOrderPolling :526-544
--                        accepted_at = coalesce(accepted_at, now) (the contract's "if null"; the tablet stamps it on the
--                        move out of `new`, where it is always null). The ready email: the FIRST applied accept with a
--                        quoted time per order sets ready_email_sent (unique index) → the caller calls send-ready-email.
--   pos_online_settings_change(…)  ONE transaction: idempotency + the pos_restaurant_settings write
--                        (online_print_device → print_register_device_id; online_auto_print; kitchenhub_auto_print).
--
-- Reads / writes of live tables, all inside the two functions above and all the web's own writes: orders (SELECT …
-- FOR UPDATE of the one order; UPDATE of the columns above), restaurants (SELECT estimated_pickup_minutes).
--
-- PRECONDITION: 110 applied; pos_online_actions EMPTY (nothing deployed writes it). Else this stops before changing
-- anything.
--
-- Access: LESSON FROM 108 — pos_online_actions is `revoke all … from service_role`, then granted exactly
-- (select insert update; no delete). EXECUTE on the four functions to service_role only.
--
-- NOT APPLIED. Needs 110. Rollback: docs/migrations/111_rollback.sql. Smoke: docs/migrations/111_smoke.sql.
-- Verify: docs/migrations/111_verify.sql.

begin;

do $$
begin
  if to_regclass('public.pos_online_print_stations') is null then
    raise exception '111: migration 110 is not applied (pos_online_print_stations missing)' using errcode = '55000';
  end if;
  if exists (select 1 from public.pos_online_actions) then
    raise exception '111: pos_online_actions is not empty — 111 reshapes it; stop and check' using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 109 functions / trigger this replaces
-- ---------------------------------------------------------------------------------------------

drop function public.pos_online_action_begin(uuid, uuid, uuid, uuid, uuid, text, jsonb);
drop function public.pos_online_action_complete(uuid, uuid, jsonb, int);
drop trigger trg_pos_online_actions_guard on public.pos_online_actions;

-- ---------------------------------------------------------------------------------------------
-- pos_online_actions: reshape (empty — checked above)
-- ---------------------------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.pos_online_actions'::regclass and contype = 'c' loop
    execute format('alter table public.pos_online_actions drop constraint %I', r.conname);
  end loop;
end;
$$;
drop index public.pos_online_actions_order;
alter table public.pos_online_actions
  drop column staff_id,
  drop column result,
  drop column http_status,
  alter column order_id drop not null,
  add column function          text not null,
  add column order_channel     text,
  add column request_hash      text not null,
  add column outcome           text,
  add column error_status      int,
  add column error_code        text,
  add column error_message     text,
  add column order_ids         uuid[] not null default '{}',
  add column ready_email_sent  boolean not null default false,
  add column actor_staff_id    text,                 -- staff uuid or 'register' (as sent; not an FK — an audit value)
  add column approver_staff_id uuid,                 -- as sent; not an FK
  add column device_time       timestamptz;
alter table public.pos_online_actions
  add constraint pos_online_actions_function_check check (function in ('order_action', 'print', 'settings')),
  add constraint pos_online_actions_channel_check check (order_channel is null or order_channel in ('ordr', 'kitchenhub')),
  add constraint pos_online_actions_order_check check (
    (order_id is null) = (order_channel is null)
    and (order_id is null) = (function = 'settings' or action = 'complete_all_in_progress')),
  add constraint pos_online_actions_action_check check (action ~ '^[a-z][a-z0-9_]{0,39}$'),
  add constraint pos_online_actions_request_check check (jsonb_typeof(request) = 'object'),
  add constraint pos_online_actions_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and function = 'print') or (outcome is not null and outcome in ('applied', 'noop', 'error'))),
  add constraint pos_online_actions_completed_check check ((outcome is null) = (completed_at is null)),
  add constraint pos_online_actions_error_check check (
    (outcome is not distinct from 'error') = (error_status is not null)
    and (error_status is null) = (error_code is null)
    and (error_status is null or error_status between 400 and 599)
    and (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,59}$')
    and (error_message is null or length(error_message) <= 500)),
  add constraint pos_online_actions_order_ids_check check (
    cardinality(order_ids) <= 10000 and (cardinality(order_ids) = 0 or action = 'complete_all_in_progress')),
  add constraint pos_online_actions_ready_email_check check (
    not ready_email_sent or (function = 'order_action' and action = 'accept' and outcome = 'applied' and order_id is not null)),
  add constraint pos_online_actions_actor_check check (
    actor_staff_id is null or actor_staff_id = 'register'
    or actor_staff_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

create unique index pos_online_actions_ready_email_once on public.pos_online_actions (order_id) where ready_email_sent;
create index pos_online_actions_order_idx on public.pos_online_actions (order_channel, order_id, created_at);
create index pos_online_actions_restaurant_idx on public.pos_online_actions (restaurant_id, created_at);

-- The only update: a PENDING (print) action gets its outcome, once. Everything else is immutable.
create or replace function public.pos_online_actions_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.outcome is not null
     or (to_jsonb(new) - 'outcome' - 'completed_at' - 'error_status' - 'error_code' - 'error_message')
        is distinct from (to_jsonb(old) - 'outcome' - 'completed_at' - 'error_status' - 'error_code' - 'error_message') then
    raise exception 'pos_online_actions: only a pending action may be completed, once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_actions_guard before update on public.pos_online_actions
  for each row execute function public.pos_online_actions_guard();

-- ---------------------------------------------------------------------------------------------
-- print idempotency (pos-v1-online-print): begin → pending row; complete → its outcome
-- ---------------------------------------------------------------------------------------------
-- begin → started | pending (same request, no outcome yet) | duplicate {outcome, error_*} | action_id_reused.
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

-- complete → completed | not_found | device_mismatch | already_completed {stored}.
create or replace function public.pos_online_action_complete(p_action_id uuid, p_device_id uuid, p_outcome text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  if p_outcome is null or p_outcome not in ('applied', 'noop') then
    raise exception 'pos_online_action_complete: outcome applied | noop' using errcode = '22023';
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
  update public.pos_online_actions set outcome = p_outcome, completed_at = now() where action_id = p_action_id;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos-v1-online-order-action (Ordr; CP18 actions)
-- ---------------------------------------------------------------------------------------------
-- → device_not_allowed | action_id_reused | duplicate {order_ids, stored, error_*} | unknown_order |
--   restaurant_mismatch | status_conflict {status} | not_allowed {message} | invalid {message} |
--   applied / noop {ready_email, order_ids}.
-- Errors write NOTHING (the reference stores an error only when the attempt changed the order — none of these do),
-- so a resend of the same action_id is evaluated again. The caller has validated the shape; 22023 = bad input.
create or replace function public.pos_online_order_action(
  p_action_id uuid, p_restaurant_id uuid, p_device_id uuid, p_order_id uuid, p_action text, p_expected_status text,
  p_quoted_ready_minutes int, p_request jsonb, p_actor text, p_approver uuid, p_device_time timestamptz)
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
  v_sched  timestamptz;
  v_type   text;
  v_method text;
  v_uber   text;
  v_ready  timestamptz;
  v_acked  timestamptz;
  v_rid    uuid;
  v_written timestamptz;
  v_lead   int;
  v_ids    uuid[] := '{}';
  v_out    text;
  v_email  boolean := false;
begin
  if p_action is null or p_action not in ('ack', 'stuck_ack', 'accept', 'schedule', 'complete', 'complete_all_in_progress', 'wake_scheduled') then
    raise exception 'pos_online_order_action: unknown action %', p_action using errcode = '22023';
  end if;
  if (p_order_id is null) <> (p_action = 'complete_all_in_progress') then
    raise exception 'pos_online_order_action: order_id is null only for complete_all_in_progress' using errcode = '22023';
  end if;
  if p_action not in ('ack', 'stuck_ack', 'complete_all_in_progress') and p_expected_status is null then
    raise exception 'pos_online_order_action: expected_status is required' using errcode = '22023';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_online_order_action: request must be an object' using errcode = '22023';
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
       or a.order_id is distinct from p_order_id or a.action <> p_action or a.request_hash <> v_hash then
      return jsonb_build_object('outcome', 'action_id_reused');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome, 'error_status', a.error_status,
                              'error_code', a.error_code, 'error_message', a.error_message, 'order_ids', to_jsonb(a.order_ids));
  end if;

  if p_action = 'complete_all_in_progress' then
    -- SettingsTab.jsx handleBulkComplete :490-494, verbatim
    with u as (
      update public.orders set status = 'complete'
       where restaurant_id = p_restaurant_id and status = 'in_progress'
      returning id)
    select coalesce(array_agg(id order by id), '{}') into v_ids from u;
    v_out := case when cardinality(v_ids) > 0 then 'applied' else 'noop' end;
  else
    select o.status, o.scheduled_for, o.order_type, o.delivery_fulfillment_method, o.uber_delivery_id,
           o.uber_pickup_ready_dt, o.acknowledged_at, o.restaurant_id, o.items_written_at
      into v_status, v_sched, v_type, v_method, v_uber, v_ready, v_acked, v_rid, v_written
      from public.orders o where o.id = p_order_id
       for update;
    if not found or v_written is null then
      return jsonb_build_object('outcome', 'unknown_order');
    end if;
    if v_rid <> p_restaurant_id then
      return jsonb_build_object('outcome', 'restaurant_mismatch');
    end if;

    if p_action = 'ack' then
      if v_acked is not null then
        v_out := 'noop';
      else
        update public.orders set acknowledged_at = v_now where id = p_order_id;
        v_out := 'applied';
      end if;
    elsif p_action = 'stuck_ack' then
      update public.orders set stuck_acknowledged_at = v_now where id = p_order_id;
      v_out := 'applied';
    else
      -- compare-and-set on expected_status (the row is locked: it cannot move under us)
      if v_status is distinct from p_expected_status then
        return jsonb_build_object('outcome', 'status_conflict', 'status', v_status);
      end if;
      if p_action = 'accept' then
        if v_status <> 'new' then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'accept from ' || v_status);
        end if;
        if v_sched is not null then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'a scheduled order is accepted with schedule');
        end if;
        if v_type = 'delivery' and v_method = 'uber_direct' then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'an Uber delivery is accepted by dispatching it');
        end if;
        if p_quoted_ready_minutes is not null and p_quoted_ready_minutes not between 1 and 240 then
          return jsonb_build_object('outcome', 'invalid', 'message', 'quoted_ready_minutes must be 1–240 or null');
        end if;
        if p_quoted_ready_minutes is null then
          -- Mark In Progress: OrdersTab updateStatus('in_progress') :566-573
          update public.orders set status = 'in_progress', accepted_at = coalesce(accepted_at, v_now)
           where id = p_order_id;
        else
          -- Confirm N min: OrdersTab confirmReadyTime :705-707 (status + quoted_for in one update)
          update public.orders set status = 'in_progress', accepted_at = coalesce(accepted_at, v_now),
                                   quoted_for = v_now + make_interval(mins => p_quoted_ready_minutes)
           where id = p_order_id;
          -- the ready email: once per order (the first applied accept with a quoted time)
          v_email := not exists (select 1 from public.pos_online_actions x where x.order_id = p_order_id and x.ready_email_sent);
        end if;
        v_out := 'applied';
      elsif p_action = 'schedule' then
        if v_status <> 'new' then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'schedule from ' || v_status);
        end if;
        if v_sched is null then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'not a scheduled order');
        end if;
        if v_type = 'delivery' and v_method = 'uber_direct' and v_uber is null then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'an Uber delivery is scheduled by booking it');
        end if;
        update public.orders set status = 'scheduled', accepted_at = coalesce(accepted_at, v_now) where id = p_order_id;
        v_out := 'applied';
      elsif p_action = 'complete' then
        if v_status not in ('in_progress', 'scheduled', 'self_delivering') then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'complete from ' || v_status);
        end if;
        update public.orders set status = 'complete' where id = p_order_id;
        v_out := 'applied';
      elsif p_action = 'wake_scheduled' then
        -- useOrderPolling.js :526-544: status scheduled, uber_direct, uber_delivery_id set, scheduled_for set,
        -- now >= (uber_pickup_ready_dt ?? scheduled_for) − (estimated_pickup_minutes || 30) min
        if v_status <> 'scheduled' or v_method is distinct from 'uber_direct' or v_uber is null or v_sched is null then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'not a booked scheduled Uber order');
        end if;
        select coalesce(nullif(r.estimated_pickup_minutes, 0), 30) into v_lead from public.restaurants r where r.id = p_restaurant_id;
        if v_now < coalesce(v_ready, v_sched) - make_interval(mins => coalesce(v_lead, 30)) then
          return jsonb_build_object('outcome', 'not_allowed', 'message', 'not due yet');
        end if;
        update public.orders set status = 'in_progress' where id = p_order_id and status = 'scheduled';
        v_out := 'applied';
      end if;
    end if;
  end if;

  insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                         request, request_hash, outcome, order_ids, ready_email_sent, actor_staff_id,
                                         approver_staff_id, device_time, created_at, completed_at)
  values (p_action_id, 'order_action', p_restaurant_id, p_device_id, case when p_order_id is null then null else 'ordr' end,
          p_order_id, p_action, p_request, v_hash, v_out, v_ids, v_email, p_actor, p_approver, p_device_time, v_now, v_now);
  return jsonb_build_object('outcome', v_out, 'ready_email', v_email, 'order_ids', to_jsonb(v_ids));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos-v1-online-settings (the POS-only settings: print register + the two auto-print flags)
-- ---------------------------------------------------------------------------------------------
-- → device_not_allowed | action_id_reused | duplicate {stored} | invalid_print_register | applied | noop.
-- Absolute values: the same change again → noop (no write). updated_by = the actor ('register' when none).
create or replace function public.pos_online_settings_change(
  p_action_id uuid, p_restaurant_id uuid, p_device_id uuid, p_kind text, p_print_device_id uuid, p_on boolean,
  p_request jsonb, p_actor text, p_approver uuid, p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a       public.pos_online_actions;
  s       public.pos_restaurant_settings;
  v_hash  text;
  v_now   timestamptz := now();
  v_by    text := coalesce(p_actor, 'register');
  v_out   text;
begin
  if p_kind is null or p_kind not in ('online_print_device', 'online_auto_print', 'kitchenhub_auto_print') then
    raise exception 'pos_online_settings_change: unknown kind %', p_kind using errcode = '22023';
  end if;
  if p_kind <> 'online_print_device' and p_on is null then
    raise exception 'pos_online_settings_change: on is required' using errcode = '22023';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_online_settings_change: request must be an object' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;

  v_hash := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('pos_online_action:' || p_action_id::text, 0));
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if found then
    if a.function <> 'settings' or a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id
       or a.action <> p_kind or a.request_hash <> v_hash then
      return jsonb_build_object('outcome', 'action_id_reused');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pos_restaurant_settings:' || p_restaurant_id::text, 0));
  select * into s from public.pos_restaurant_settings where restaurant_id = p_restaurant_id;
  -- no row = every default (NULL register, flags false)
  if p_kind = 'online_print_device' then
    if p_print_device_id is not null and not exists (
         select 1 from public.pos_devices d
          where d.id = p_print_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
      return jsonb_build_object('outcome', 'invalid_print_register');
    end if;
    if (s.restaurant_id is not null and s.print_register_device_id is not distinct from p_print_device_id)
       or (s.restaurant_id is null and p_print_device_id is null) then
      v_out := 'noop';
    else
      insert into public.pos_restaurant_settings (restaurant_id, print_register_device_id, updated_at, updated_by)
      values (p_restaurant_id, p_print_device_id, v_now, v_by)
      on conflict (restaurant_id) do update
        set print_register_device_id = excluded.print_register_device_id, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by;
      v_out := 'applied';
    end if;
  elsif p_kind = 'online_auto_print' then
    if coalesce(s.online_auto_print_enabled, false) = p_on then
      v_out := 'noop';
    else
      insert into public.pos_restaurant_settings (restaurant_id, online_auto_print_enabled, updated_at, updated_by)
      values (p_restaurant_id, p_on, v_now, v_by)
      on conflict (restaurant_id) do update
        set online_auto_print_enabled = excluded.online_auto_print_enabled, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by;
      v_out := 'applied';
    end if;
  else
    if coalesce(s.kitchenhub_auto_print_enabled, false) = p_on then
      v_out := 'noop';
    else
      insert into public.pos_restaurant_settings (restaurant_id, kitchenhub_auto_print_enabled, updated_at, updated_by)
      values (p_restaurant_id, p_on, v_now, v_by)
      on conflict (restaurant_id) do update
        set kitchenhub_auto_print_enabled = excluded.kitchenhub_auto_print_enabled, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by;
      v_out := 'applied';
    end if;
  end if;

  insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                         request, request_hash, outcome, actor_staff_id, approver_staff_id, device_time,
                                         created_at, completed_at)
  values (p_action_id, 'settings', p_restaurant_id, p_device_id, null, null, p_kind, p_request, v_hash, v_out,
          p_actor, p_approver, p_device_time, v_now, v_now);
  return jsonb_build_object('outcome', v_out);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------

alter table public.pos_online_actions enable row level security;   -- (already on since 109) no policies

revoke all on table public.pos_online_actions from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_online_actions to service_role;  -- no delete; completed = immutable (trigger)

do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz)',
    'public.pos_online_action_complete(uuid, uuid, text)',
    'public.pos_online_order_action(uuid, uuid, uuid, uuid, text, text, int, jsonb, text, uuid, timestamptz)',
    'public.pos_online_settings_change(uuid, uuid, uuid, text, uuid, boolean, jsonb, text, uuid, timestamptz)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.pos_online_actions_guard() from public, anon, authenticated;

comment on table public.pos_online_actions is
  'POS online actions by device action_id (order_action | print | settings): idempotency (request_hash), audit (actor / approver), ready-email-once. order_id has no FK by design.';
comment on function public.pos_online_order_action(uuid, uuid, uuid, uuid, text, text, int, jsonb, text, uuid, timestamptz) is
  'pos-v1-online-order-action (Ordr): the web tablet''s exact write, compare-and-set on expected_status, + the action row, in one transaction.';
comment on function public.pos_online_settings_change(uuid, uuid, uuid, text, uuid, boolean, jsonb, text, uuid, timestamptz) is
  'pos-v1-online-settings: print register / online_auto_print / kitchenhub_auto_print on pos_restaurant_settings + the action row, in one transaction.';

commit;
