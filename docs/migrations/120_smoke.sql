-- 120_smoke.sql — one-time smoke test of migration 120, run by Matt in the SQL editor AFTER 120 is applied, as
-- postgres. Everything after the lookup runs AS service_role (set local role) — the role pos-reports reads with.
-- NOTHING PERSISTS (BEGIN … ROLLBACK; it only reads). Failure → 'SMOKE FAIL: <what>'. Success → 'SMOKE OK (all N checks)'.
-- Prints no row data. Uses Test Pizza (slug test); works with zero POS orders.

begin;

do $$
declare
  n      int := 0;
  v_r    uuid;
  v_plan text := '';
  v_line text;
  v_cnt  bigint;
  t      text;
begin
  select id into v_r from public.restaurants where slug = 'test';
  if v_r is null then raise exception 'SMOKE FAIL: Test Pizza (slug test) not found'; end if;

  set local role service_role;
  if current_user <> 'service_role' then raise exception 'SMOKE FAIL: not running as service_role'; end if;

  -- 1. the report's day read can use the new index (seq scans off for this transaction only: on a small table the
  --    planner would otherwise rightly prefer a scan)
  set local enable_seqscan = off;
  for v_line in execute format(
      'explain select order_id from public.pos_orders where restaurant_id = %L and sales_day between %L and %L',
      v_r, (current_date - 7)::text, current_date::text) loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  if position('pos_orders_restaurant_sales_day' in v_plan) = 0 then
    raise exception 'SMOKE FAIL: 1 the sales_day read does not use pos_orders_restaurant_sales_day:%', E'\n' || v_plan;
  end if;
  reset enable_seqscan;
  n := n + 1;

  -- 2. the read itself runs as service_role, with the delivery read narrowed to two keys (store.ts ORDER_COLUMNS)
  select count(*) into v_cnt from (
    select order_id, provisional_pricing, flags, delivery -> 'overrides' as o, delivery -> 'delivery_unverified' as u
      from public.pos_orders where restaurant_id = v_r and sales_day between current_date - 93 and current_date) q;
  n := n + 1;

  -- 3. service_role can read every table pos-reports reads (no RLS policy needed: service_role bypasses RLS)
  foreach t in array array['pos_devices', 'pos_staff', 'pos_day_closes', 'pos_orders', 'pos_payments', 'pos_order_lines',
                           'pos_order_line_modifiers', 'pos_refunds', 'pos_shifts', 'pos_cash_movements',
                           'orders', 'order_items', 'order_item_toppings', 'menu_items', 'adjustment_requests', 'external_orders'] loop
    if not has_table_privilege('service_role', 'public.' || t, 'SELECT') then
      raise exception 'SMOKE FAIL: 3 service_role cannot SELECT %', t;
    end if;
    execute format('select count(*) from (select 1 from public.%I limit 1) q', t) into v_cnt;
  end loop;
  n := n + 1;

  -- 4. still no write path for the reader's role beyond what it had: pos_orders is not deletable
  begin
    execute 'delete from public.pos_orders where false';
    raise exception 'SMOKE FAIL: 4 service_role can DELETE pos_orders';
  exception when insufficient_privilege then null;
  end;
  n := n + 1;

  reset role;
  raise notice 'SMOKE OK (all % checks)', n;
end;
$$;

rollback;
