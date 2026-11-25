set lock_timeout = '3s';
-- 117_pos_kitchenhub.sql — KitchenHub (DoorDash / Grubhub / Uber Eats) orders on the POS (CP21; ordr-pos
-- SYNC-CONTRACT §3c :569-577, :633-636; src/dev/onlineActionRules.ts :54-56, :171-194).
--
-- pos_* ONLY. NO column / trigger / default / constraint / FK on external_orders, kitchenhub_stores, menu_items,
-- menu_categories, restaurants or any live-path table. kh-order-action / kh-webhook / kh-backstop / kh-admin unchanged.
--
--   pos_online_actions        the outcome CHECK also allows a PENDING order_action row for ext_ack / ext_accept /
--                             ext_ready / ext_cancel (the KitchenHub call happens in TS between begin and finish, 113);
--                             the release guard + pos_online_action_release also release a pending ext_* row (a read
--                             failed before anything was sent to KitchenHub; a failed ack write — the ack is idempotent).
--   pos_restaurant_settings   + kitchenhub_fallback_category_id uuid NULL (no FK): the category an UNMAPPED marketplace
--                             line routes as; NULL = the counter ticket only (UNMAPPED).
--                             + kitchenhub_maps_rev bigint NOT NULL DEFAULT 0: bumped by the function below in the SAME
--                             transaction as every applied map set / clear — the feed's mapping-cache version key (the
--                             feed reads this row every poll, so a change shows on the next poll at no extra query).
--   pos_kitchenhub_item_maps  staff-confirmed maps: (restaurant, marketplace or '*', item_id | name, key) → menu item XOR
--                             category. A name key is stored NORMALIZED by the TS (khItems.ts normalizeItemName). No FK
--                             to menu_items / menu_categories (would block the web admin's deletes): a map whose target
--                             is gone is skipped at serve time — the line falls through to the fallback / UNMAPPED.
--   pos_kitchenhub_menu_pulls the cached marketplace menu pull (GET /v2/stores/{id}/menu/pull) per restaurant: names /
--                             ids only, ≥ 5 min (60 s after a failure) — read-only toward KitchenHub.
--   pos_kitchenhub_item_map_change(…)  ONE transaction: idempotency by action_id (pos_online_actions, function
--                             'settings', action kitchenhub_item_map | kitchenhub_fallback_category) + the map upsert /
--                             delete or the fallback write + the action row → device_not_allowed | action_id_reused |
--                             duplicate {stored} | item_not_found | category_not_found | applied | noop.
--
-- Access (the 108 pattern): each table `revoke all … from service_role`, then exactly:
--   pos_kitchenhub_item_maps   select insert update delete   (written by the function; delete = clear)
--   pos_kitchenhub_menu_pulls  select insert update          (the cache upsert)
--   pos_online_actions         select insert update delete   (unchanged, 114 — re-asserted)
--   pos_restaurant_settings    select insert update          (unchanged — re-asserted)
-- EXECUTE on the function to service_role only; SECURITY INVOKER (service_role's existing SELECT on menu_items /
-- menu_categories — 117_verify checks it, grants nothing on live tables). RLS on, no policies.
--
-- NOT APPLIED. Needs 114–116. Rollback: docs/migrations/117_rollback.sql. Smoke: docs/migrations/117_smoke.sql.
-- Verify: docs/migrations/117_verify.sql.

begin;

do $$
begin
  if to_regprocedure('public.pos_online_action_release(uuid, uuid)') is null
     or to_regprocedure('public.pos_online_actions_release_guard()') is null then
    raise exception '117: needs 114 (pos_online_action_release)' using errcode = '55000';
  end if;
  if to_regclass('public.pos_deliveries') is null then
    raise exception '117: needs 115 (pos_deliveries)' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pos_deliveries' and column_name = 'canceled_by') then
    raise exception '117: needs 116 (pos_deliveries.canceled_by)' using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pos_online_actions: pending ext_* + their release
-- ---------------------------------------------------------------------------------------------

alter table public.pos_online_actions drop constraint pos_online_actions_outcome_check;
alter table public.pos_online_actions
  add constraint pos_online_actions_outcome_check check (
    (outcome is null and (function = 'print'
                          or (function = 'order_action' and action in ('cancel_refund', 'dispatch_delivery', 'self_deliver',
                                                                       'ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel'))))
    or (outcome is not null and outcome in ('applied', 'noop', 'error')));

create or replace function public.pos_online_actions_release_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.outcome is not null or old.function <> 'order_action'
     or old.action not in ('dispatch_delivery', 'self_deliver', 'ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel') then
    raise exception 'pos_online_actions: only a pending dispatch_delivery / self_deliver / ext_* may be released' using errcode = '42501';
  end if;
  return old;
end;
$$;

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
  if a.outcome is not null or a.function <> 'order_action'
     or a.action not in ('dispatch_delivery', 'self_deliver', 'ext_ack', 'ext_accept', 'ext_ready', 'ext_cancel') then
    return jsonb_build_object('outcome', 'not_pending');
  end if;
  delete from public.pos_online_actions where action_id = p_action_id;
  return jsonb_build_object('outcome', 'released');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- the fallback category + the maps + the menu pull cache
-- ---------------------------------------------------------------------------------------------

alter table public.pos_restaurant_settings
  add column kitchenhub_fallback_category_id uuid,                        -- menu_categories.id of the restaurant; NO FK (live table)
  add column kitchenhub_maps_rev bigint not null default 0 check (kitchenhub_maps_rev >= 0);  -- the mapping cache key

create table public.pos_kitchenhub_item_maps (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants(id),
  provider             text not null check (provider = '*' or provider ~ '^[a-z0-9_]{1,40}$'),
  match_kind           text not null check (match_kind in ('item_id', 'name')),
  match_key            text not null check (length(match_key) between 1 and 200 and match_key = btrim(match_key)),
  menu_item_id         uuid,                                   -- menu_items.id; NO FK
  category_id          uuid,                                   -- menu_categories.id; NO FK
  label                text check (length(label) <= 200),
  updated_by_device_id uuid not null references public.pos_devices(id),
  actor_staff_id       text check (actor_staff_id is null or actor_staff_id = 'register'
                                   or actor_staff_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((menu_item_id is null) <> (category_id is null)),
  unique (restaurant_id, provider, match_kind, match_key)
);

create table public.pos_kitchenhub_menu_pulls (
  restaurant_id uuid primary key references public.restaurants(id),
  pulled_at     timestamptz not null,
  ok            boolean not null,
  providers     jsonb not null check (jsonb_typeof(providers) = 'array')
);

-- → device_not_allowed | action_id_reused | duplicate {stored} | item_not_found | category_not_found | applied | noop.
create or replace function public.pos_kitchenhub_item_map_change(
  p_action_id uuid, p_restaurant_id uuid, p_device_id uuid, p_op text, p_kind text, p_provider text, p_key text,
  p_menu_item_id uuid, p_category_id uuid, p_label text, p_request jsonb, p_actor text, p_approver uuid,
  p_device_time timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  a        public.pos_online_actions;
  m        public.pos_kitchenhub_item_maps;
  v_hash   text;
  v_now    timestamptz := now();
  v_action text;
  v_out    text := 'noop';
  v_cur    uuid;
  v_next   uuid;
begin
  if p_op is null or p_op not in ('set', 'clear') or p_kind is null or p_kind not in ('item_id', 'name', 'fallback') then
    raise exception 'pos_kitchenhub_item_map_change: op set | clear, kind item_id | name | fallback' using errcode = '22023';
  end if;
  if p_kind <> 'fallback' and (p_provider is null or p_key is null) then
    raise exception 'pos_kitchenhub_item_map_change: provider and key are required' using errcode = '22023';
  end if;
  if p_op = 'set' and (case when p_kind = 'fallback' then p_category_id is null or p_menu_item_id is not null
                            else (p_menu_item_id is null) = (p_category_id is null) end) then
    raise exception 'pos_kitchenhub_item_map_change: a map targets a menu item XOR a category; the fallback a category' using errcode = '22023';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'pos_kitchenhub_item_map_change: request must be an object' using errcode = '22023';
  end if;
  if not exists (select 1 from public.pos_devices d
                  where d.id = p_device_id and d.restaurant_id = p_restaurant_id and d.status = 'active') then
    return jsonb_build_object('outcome', 'device_not_allowed');
  end if;

  v_action := case when p_kind = 'fallback' then 'kitchenhub_fallback_category' else 'kitchenhub_item_map' end;
  v_hash := encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('pos_online_action:' || p_action_id::text, 0));
  select * into a from public.pos_online_actions where action_id = p_action_id;
  if found then
    if a.function <> 'settings' or a.restaurant_id <> p_restaurant_id or a.device_id <> p_device_id
       or a.action <> v_action or a.request_hash <> v_hash then
      return jsonb_build_object('outcome', 'action_id_reused');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'stored', a.outcome);
  end if;

  -- the restaurant's CURRENT menu (_shared/pos-sync/menuSnapshot.ts reads the same tables)
  if p_op = 'set' and p_menu_item_id is not null
     and not exists (select 1 from public.menu_items i where i.id = p_menu_item_id and i.restaurant_id = p_restaurant_id) then
    return jsonb_build_object('outcome', 'item_not_found');
  end if;
  if p_op = 'set' and p_category_id is not null
     and not exists (select 1 from public.menu_categories c where c.id = p_category_id and c.restaurant_id = p_restaurant_id) then
    return jsonb_build_object('outcome', 'category_not_found');
  end if;

  if p_kind = 'fallback' then
    perform pg_advisory_xact_lock(hashtextextended('pos_restaurant_settings:' || p_restaurant_id::text, 0));
    select s.kitchenhub_fallback_category_id into v_cur from public.pos_restaurant_settings s where s.restaurant_id = p_restaurant_id;
    v_next := case when p_op = 'set' then p_category_id end;
    if v_cur is distinct from v_next then
      insert into public.pos_restaurant_settings (restaurant_id, kitchenhub_fallback_category_id, updated_at, updated_by)
      values (p_restaurant_id, v_next, v_now, coalesce(p_actor, 'register'))
      on conflict (restaurant_id) do update
        set kitchenhub_fallback_category_id = excluded.kitchenhub_fallback_category_id, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by;
      v_out := 'applied';
    end if;
  elsif p_op = 'clear' then
    delete from public.pos_kitchenhub_item_maps
     where restaurant_id = p_restaurant_id and provider = p_provider and match_kind = p_kind and match_key = p_key;
    if found then v_out := 'applied'; end if;
  else
    select * into m from public.pos_kitchenhub_item_maps
     where restaurant_id = p_restaurant_id and provider = p_provider and match_kind = p_kind and match_key = p_key for update;
    if not found then
      insert into public.pos_kitchenhub_item_maps (restaurant_id, provider, match_kind, match_key, menu_item_id, category_id, label,
                                                   updated_by_device_id, actor_staff_id, created_at, updated_at)
      values (p_restaurant_id, p_provider, p_kind, p_key, p_menu_item_id, p_category_id, p_label, p_device_id, p_actor, v_now, v_now);
      v_out := 'applied';
    elsif (m.menu_item_id, m.category_id, m.label) is distinct from (p_menu_item_id, p_category_id, p_label) then
      update public.pos_kitchenhub_item_maps
         set menu_item_id = p_menu_item_id, category_id = p_category_id, label = p_label, updated_by_device_id = p_device_id,
             actor_staff_id = p_actor, updated_at = v_now
       where id = m.id;
      v_out := 'applied';
    end if;
  end if;

  -- a map changed → the maps revision moves (the feed's mapping cache key), same transaction
  if v_out = 'applied' and p_kind <> 'fallback' then
    perform pg_advisory_xact_lock(hashtextextended('pos_restaurant_settings:' || p_restaurant_id::text, 0));
    insert into public.pos_restaurant_settings (restaurant_id, kitchenhub_maps_rev, updated_at, updated_by)
    values (p_restaurant_id, 1, v_now, coalesce(p_actor, 'register'))
    on conflict (restaurant_id) do update
      set kitchenhub_maps_rev = public.pos_restaurant_settings.kitchenhub_maps_rev + 1;
  end if;

  insert into public.pos_online_actions (action_id, function, restaurant_id, device_id, order_channel, order_id, action,
                                         request, request_hash, outcome, actor_staff_id, approver_staff_id, device_time,
                                         created_at, completed_at)
  values (p_action_id, 'settings', p_restaurant_id, p_device_id, null, null, v_action, p_request, v_hash, v_out,
          p_actor, p_approver, p_device_time, v_now, v_now);
  return jsonb_build_object('outcome', v_out);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- access (108 pattern)
-- ---------------------------------------------------------------------------------------------

alter table public.pos_kitchenhub_item_maps  enable row level security;
alter table public.pos_kitchenhub_menu_pulls enable row level security;
-- Deliberately no policies.

revoke all on table public.pos_kitchenhub_item_maps, public.pos_kitchenhub_menu_pulls, public.pos_online_actions,
                    public.pos_restaurant_settings
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pos_kitchenhub_item_maps  to service_role;  -- delete = clear
grant select, insert, update         on table public.pos_kitchenhub_menu_pulls to service_role;  -- the cache upsert
grant select, insert, update, delete on table public.pos_online_actions        to service_role;  -- unchanged (114)
grant select, insert, update         on table public.pos_restaurant_settings   to service_role;  -- unchanged (109)

revoke all on function public.pos_kitchenhub_item_map_change(uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.pos_kitchenhub_item_map_change(uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb, text, uuid, timestamptz)
  to service_role;
revoke all on function public.pos_online_action_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pos_online_action_release(uuid, uuid) to service_role;
revoke all on function public.pos_online_actions_release_guard() from public, anon, authenticated;

comment on table public.pos_kitchenhub_item_maps is 'POS: staff-confirmed marketplace item → Ordr menu item / category maps (KitchenHub line routing). No FK to the menu: a gone target is skipped.';
comment on table public.pos_kitchenhub_menu_pulls is 'POS: cached KitchenHub marketplace menu pull per restaurant (names / ids only; ≥ 5 min).';
comment on column public.pos_restaurant_settings.kitchenhub_fallback_category_id is 'The category an unmapped KitchenHub line routes as (NULL = the counter ticket only).';
comment on column public.pos_restaurant_settings.kitchenhub_maps_rev is 'Bumped with every applied KitchenHub map set / clear (pos_kitchenhub_item_map_change): the feed''s mapping-cache version key.';
comment on function public.pos_kitchenhub_item_map_change(uuid, uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb, text, uuid, timestamptz) is
  'pos-v1-kitchenhub-items set / clear: the map (or the fallback category) + the action row, in one transaction.';

commit;
