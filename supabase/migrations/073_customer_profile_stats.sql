-- 073_customer_profile_stats.sql
-- The rewards page greets a customer by name and states how many times they
-- have ordered. Both were previously unavailable: display_name was never
-- populated, and an order count required a live aggregate.
--
-- Both are maintained by the accrual trigger, which already runs once per
-- order at the point items finish writing.

begin;

alter table restaurant_customers add column if not exists order_count integer not null default 0;

-- Backfill from existing history.
update restaurant_customers rc
   set order_count = sub.cnt,
       display_name = coalesce(nullif(rc.display_name, ''), sub.latest_name)
  from (
    select o.customer_id,
           o.restaurant_id,
           count(*) as cnt,
           (array_agg(o.customer_name order by o.created_at desc))[1] as latest_name
      from orders o
     where o.customer_id is not null
     group by o.customer_id, o.restaurant_id
  ) sub
 where rc.customer_id = sub.customer_id
   and rc.restaurant_id = sub.restaurant_id;

commit;