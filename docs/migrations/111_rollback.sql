-- 111_rollback.sql — undo migration 111: pos_online_actions back to exactly the 109 shape (columns, CHECKs, index,
-- guard, begin / complete functions, grants). Run as postgres in the SQL editor. Leaves 110 / 109 in place.
--
-- The 111 action rows (order_action / print / settings) can't be expressed in the 109 shape (109 had no settings or
-- bulk rows, no outcome). If any exist the rollback STOPS, unless you first run, in the same session:
--   set pos.rollback_111_discard = 'yes';
-- which DELETES every pos_online_actions row (POS-only audit / idempotency; the orders / pos_restaurant_settings
-- writes those actions made are NOT undone — they are the web's own columns / the POS settings).
-- NOTE: the pos-v1-online-print function deployed against 110 + 111 calls 111's begin / complete signatures; roll
-- back only with pos-v1-online-print / -order-action / -settings undeployed.

begin;

do $$
begin
  if exists (select 1 from public.pos_online_actions) then
    if coalesce(current_setting('pos.rollback_111_discard', true), '') <> 'yes' then
      raise exception '111 rollback: pos_online_actions rows exist; set pos.rollback_111_discard = ''yes'' to delete them, or stop'
        using errcode = '55000';
    end if;
    -- the guard is BEFORE UPDATE only and service_role has no DELETE; this runs as postgres
    delete from public.pos_online_actions;
  end if;
end;
$$;

drop function if exists public.pos_online_order_action(uuid, uuid, uuid, uuid, text, text, int, jsonb, text, uuid, timestamptz);
drop function if exists public.pos_online_settings_change(uuid, uuid, uuid, text, uuid, boolean, jsonb, text, uuid, timestamptz);
drop function if exists public.pos_online_action_begin(uuid, text, uuid, uuid, text, uuid, text, jsonb, text, uuid, timestamptz);
drop function if exists public.pos_online_action_complete(uuid, uuid, text);
drop trigger if exists trg_pos_online_actions_guard on public.pos_online_actions;

drop index if exists public.pos_online_actions_ready_email_once;
drop index if exists public.pos_online_actions_order_idx;
drop index if exists public.pos_online_actions_restaurant_idx;
do $$
declare r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'public.pos_online_actions'::regclass and contype = 'c' loop
    execute format('alter table public.pos_online_actions drop constraint %I', r.conname);
  end loop;
end;
$$;
alter table public.pos_online_actions
  drop column function,
  drop column order_channel,
  drop column request_hash,
  drop column outcome,
  drop column error_status,
  drop column error_code,
  drop column error_message,
  drop column order_ids,
  drop column ready_email_sent,
  drop column actor_staff_id,
  drop column approver_staff_id,
  drop column device_time,
  alter column order_id set not null,
  add column staff_id    uuid references public.pos_staff(id),
  add column result      jsonb check (result is null or jsonb_typeof(result) = 'object'),
  add column http_status int check (http_status between 100 and 599);
alter table public.pos_online_actions
  add constraint pos_online_actions_action_check check (action ~ '^[a-z][a-z0-9_]{0,39}$'),
  add constraint pos_online_actions_request_check check (jsonb_typeof(request) = 'object'),
  add constraint pos_online_actions_check check ((result is null) = (http_status is null) and (result is null) = (completed_at is null));
create index pos_online_actions_order on public.pos_online_actions (restaurant_id, order_id, action);

-- 109's guard + functions, verbatim (109_pos_online.sql:131-146, :297-350)
create or replace function public.pos_online_actions_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.result is not null
     or (to_jsonb(new) - 'result' - 'http_status' - 'completed_at') is distinct from (to_jsonb(old) - 'result' - 'http_status' - 'completed_at') then
    raise exception 'pos_online_actions: only a pending action may be completed, once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_actions_guard before update on public.pos_online_actions
  for each row execute function public.pos_online_actions_guard();

create or replace function public.pos_online_action_begin(p_action_id uuid, p_restaurant_id uuid, p_device_id uuid,
                                                          p_staff_id uuid, p_order_id uuid, p_action text, p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare a public.pos_online_actions;
begin
  insert into public.pos_online_actions (action_id, restaurant_id, device_id, staff_id, order_id, action, request)
  values (p_action_id, p_restaurant_id, p_device_id, p_staff_id, p_order_id, p_action, p_request)
  on conflict (action_id) do nothing
  returning * into a;
  if found then
    return jsonb_build_object('outcome', 'started');
  end if;
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id or a.staff_id is distinct from p_staff_id
     or a.order_id <> p_order_id or a.action <> p_action or a.request <> p_request then
    return jsonb_build_object('outcome', 'action_id_reused');
  end if;
  if a.result is null then
    return jsonb_build_object('outcome', 'pending');
  end if;
  return jsonb_build_object('outcome', 'duplicate', 'result', a.result, 'http_status', a.http_status);
end;
$$;

create or replace function public.pos_online_action_complete(p_action_id uuid, p_device_id uuid, p_result jsonb, p_http_status int)
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
  if a.result is not null then
    return jsonb_build_object('outcome', 'already_completed', 'result', a.result, 'http_status', a.http_status);
  end if;
  update public.pos_online_actions set result = p_result, http_status = p_http_status, completed_at = now()
   where action_id = p_action_id;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

-- 109's grants, exactly
revoke all on table public.pos_online_actions from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_online_actions to service_role;
do $$
declare f text;
begin
  foreach f in array array[
    'public.pos_online_action_begin(uuid, uuid, uuid, uuid, uuid, text, jsonb)',
    'public.pos_online_action_complete(uuid, uuid, jsonb, int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.pos_online_actions_guard() from public, anon, authenticated;
comment on table public.pos_online_actions is 'POS online-order actions by device action_id: idempotency, audit, email-once. order_id has no FK by design.';

commit;
