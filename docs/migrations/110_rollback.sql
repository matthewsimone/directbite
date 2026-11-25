-- 110_rollback.sql — undo migration 110: back to exactly the 109 shape (tables, CHECKs, guard, functions, grants).
-- Run as postgres in the SQL editor. Leaves 109 in place (its own rollback: 109_rollback.sql).
--
-- The 110 print rows (claims / stations / log) can't be expressed in the 109 shape. If any exist the rollback
-- STOPS, unless you first run, in the same session:   set pos.rollback_110_discard = 'yes';
-- which DELETES every row of pos_online_print_stations / _claims / _log (POS-only data; the tablet's own
-- print_logs / print_status / print_attempts on orders are not touched). pos_restaurant_settings keeps its rows;
-- only the three 110 flag columns are dropped.

begin;

do $$
begin
  if exists (select 1 from public.pos_online_print_claims) or exists (select 1 from public.pos_online_print_log)
     or exists (select 1 from public.pos_online_print_stations) then
    if coalesce(current_setting('pos.rollback_110_discard', true), '') <> 'yes' then
      raise exception '110 rollback: POS print rows exist; set pos.rollback_110_discard = ''yes'' to delete them, or stop'
        using errcode = '55000';
    end if;
    delete from public.pos_online_print_log;
    delete from public.pos_online_print_claims;
  end if;
end;
$$;

drop function if exists public.pos_claim_online_print(uuid, text, uuid, uuid, jsonb, boolean);
drop function if exists public.pos_record_online_print(uuid, text, uuid, uuid, uuid, text, text, jsonb, text, timestamptz);
drop function if exists public.pos_online_print_state(uuid, uuid[]);
drop table if exists public.pos_online_print_stations;   -- its guard trigger goes with it
drop function if exists public.pos_online_print_stations_guard();
drop trigger if exists trg_pos_online_print_claims_guard on public.pos_online_print_claims;

alter table public.pos_restaurant_settings
  drop column if exists pos_online_orders_enabled,
  drop column if exists online_auto_print_enabled,
  drop column if exists kitchenhub_auto_print_enabled;

-- claims → 109
drop index if exists public.pos_online_print_claims_order;
alter table public.pos_online_print_claims
  drop constraint if exists pos_online_print_claims_pkey,
  drop constraint if exists pos_online_print_claims_channel_check,
  drop constraint if exists pos_online_print_claims_result_check,
  drop constraint if exists pos_online_print_claims_printed_at_check;
alter table public.pos_online_print_claims
  drop column order_channel,
  drop column printed_at,
  alter column result set not null,
  add column attempt int not null check (attempt between 1 and 100),
  add column finished_at timestamptz;
alter table public.pos_online_print_claims
  add primary key (order_id),
  add check (result in ('claimed', 'printed', 'failed')),
  add check ((result = 'claimed') = (finished_at is null));

-- log → 109
alter table public.pos_online_print_log
  drop constraint if exists pos_online_print_log_channel_check,
  drop constraint if exists pos_online_print_log_variant_check,
  drop constraint if exists pos_online_print_log_result_check,
  drop constraint if exists pos_online_print_log_station_check,
  drop constraint if exists pos_online_print_log_error_check,
  drop constraint if exists pos_online_print_log_detail_check,
  drop constraint if exists pos_online_print_log_action_id_key;
alter table public.pos_online_print_log
  drop column order_channel,
  drop column action_id,
  drop column variant,
  drop column station,
  drop column error,
  drop column device_time,
  add column attempt int not null check (attempt between 1 and 100);
alter table public.pos_online_print_log
  add check (result in ('claimed', 'printed', 'failed')),
  add check (jsonb_typeof(detail) = 'object');

-- 109's guard + functions, verbatim (109_pos_online.sql:114-128, :187-292)
create or replace function public.pos_online_print_claims_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.result = 'printed' or new.order_id <> old.order_id or new.restaurant_id <> old.restaurant_id then
    raise exception 'pos_online_print_claims: a printed claim (and order / restaurant) is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trg_pos_online_print_claims_guard before update on public.pos_online_print_claims
  for each row execute function public.pos_online_print_claims_guard();

create or replace function public.pos_claim_online_print(p_restaurant_id uuid, p_order_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  c_lease constant interval := interval '60 seconds';
  c_max_attempts constant int := 3;
  v_now timestamptz := now();
  v_register uuid;
  c public.pos_online_print_claims;
  v_takeover boolean;
begin
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;
  select s.print_register_device_id into v_register from public.pos_restaurant_settings s where s.restaurant_id = p_restaurant_id;
  if v_register is null or v_register <> p_device_id then
    return jsonb_build_object('outcome', 'not_print_register', 'print_register_device_id', v_register);
  end if;

  insert into public.pos_online_print_claims (order_id, restaurant_id, device_id, result, attempt, claimed_at)
  values (p_order_id, p_restaurant_id, p_device_id, 'claimed', 1, v_now)
  on conflict (order_id) do nothing
  returning * into c;
  if found then
    insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
    values (p_order_id, p_restaurant_id, p_device_id, 'claimed', 1, v_now, '{}'::jsonb);
    return jsonb_build_object('outcome', 'claimed', 'attempt', 1, 'lease_expires_at', v_now + c_lease, 'takeover', false);
  end if;

  select * into c from public.pos_online_print_claims where order_id = p_order_id for update;
  if c.restaurant_id <> p_restaurant_id then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;
  if c.result = 'printed' then
    return jsonb_build_object('outcome', 'already_printed', 'device_id', c.device_id, 'attempt', c.attempt);
  end if;
  if c.result = 'claimed' and c.claimed_at + c_lease > v_now then
    if c.device_id = p_device_id then
      return jsonb_build_object('outcome', 'claimed', 'attempt', c.attempt, 'lease_expires_at', c.claimed_at + c_lease, 'takeover', false);
    end if;
    return jsonb_build_object('outcome', 'held', 'device_id', c.device_id, 'lease_expires_at', c.claimed_at + c_lease);
  end if;
  if c.attempt >= c_max_attempts then
    return jsonb_build_object('outcome', 'attempts_exhausted', 'attempt', c.attempt);
  end if;

  v_takeover := c.result = 'claimed';
  update public.pos_online_print_claims
     set device_id = p_device_id, result = 'claimed', attempt = c.attempt + 1, claimed_at = v_now, finished_at = null
   where order_id = p_order_id;
  insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
  values (p_order_id, p_restaurant_id, p_device_id, 'claimed', c.attempt + 1, v_now,
          jsonb_build_object('takeover', v_takeover, 'previous_device_id', c.device_id, 'previous_result', c.result));
  return jsonb_build_object('outcome', 'claimed', 'attempt', c.attempt + 1, 'lease_expires_at', v_now + c_lease, 'takeover', v_takeover);
end;
$$;

create or replace function public.pos_finish_online_print(p_restaurant_id uuid, p_order_id uuid, p_device_id uuid,
                                                          p_attempt int, p_result text, p_detail jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  c public.pos_online_print_claims;
begin
  if p_result is null or p_result not in ('printed', 'failed') then
    raise exception 'pos_finish_online_print: result must be printed or failed' using errcode = '22023';
  end if;
  if jsonb_typeof(v_detail) <> 'object' then
    raise exception 'pos_finish_online_print: detail must be an object' using errcode = '22023';
  end if;
  select * into c from public.pos_online_print_claims where order_id = p_order_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_claimed');
  end if;
  if c.restaurant_id <> p_restaurant_id then
    return jsonb_build_object('outcome', 'restaurant_mismatch');
  end if;
  if c.device_id = p_device_id and c.attempt = p_attempt and c.result = p_result then
    return jsonb_build_object('outcome', 'duplicate', 'result', c.result, 'attempt', c.attempt);
  end if;
  if c.device_id = p_device_id and c.attempt = p_attempt and c.result = 'claimed' then
    update public.pos_online_print_claims set result = p_result, finished_at = v_now where order_id = p_order_id;
    insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
    values (p_order_id, p_restaurant_id, p_device_id, p_result, p_attempt, v_now, v_detail);
    return jsonb_build_object('outcome', 'recorded', 'result', p_result, 'attempt', p_attempt);
  end if;
  insert into public.pos_online_print_log (order_id, restaurant_id, device_id, result, attempt, at, detail)
  values (p_order_id, p_restaurant_id, p_device_id, p_result, greatest(1, least(coalesce(p_attempt, 1), 100)), v_now,
          v_detail || jsonb_build_object('lease_lost', true));
  return jsonb_build_object('outcome', 'lease_lost', 'device_id', c.device_id, 'attempt', c.attempt, 'result', c.result);
end;
$$;

-- 109's grants, exactly
revoke all on table public.pos_restaurant_settings, public.pos_online_print_claims, public.pos_online_print_log
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.pos_restaurant_settings to service_role;
grant select, insert, update on table public.pos_online_print_claims to service_role;
grant select, insert         on table public.pos_online_print_log    to service_role;
revoke all on function public.pos_claim_online_print(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pos_claim_online_print(uuid, uuid, uuid) to service_role;
revoke all on function public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb) to service_role;
revoke all on function public.pos_online_print_claims_guard() from public, anon, authenticated;

comment on table public.pos_online_print_claims is 'Exactly-once POS auto-print of an online order: one claim per order, 60 s lease, max 3 attempts. order_id has no FK by design.';
comment on table public.pos_online_print_log is 'Append-only history of POS online-print claims and results.';

commit;
