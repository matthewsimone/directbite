-- 082_order_items_nullable_menu_item.sql
-- A discount reward is a real order line with no menu item behind it.
-- loyalty_rewards enforces menu_item_id IS NULL for kind = 'discount'
-- (068:40), so the reward line reaches order_items with a null — and the
-- NOT NULL from 001:142 rejects the insert.
--
-- stripe-webhook's item loop logs and continues on a failed insert, so the
-- line vanished silently while the money stayed correct. Worse, the
-- idempotency check compares the written item count to the payload length,
-- which can then never match: a webhook retry takes the partial-write
-- branch and deletes the order to re-insert it.
--
-- The foreign key is unchanged — a wrong id is still rejected. Only absence
-- becomes legal, matching item_size_id, nullable since 001.
--
-- Nothing reads the column in a way a null breaks. Its one consumer,
-- src/lib/reorder.js:78, uses it as a Map key and routes an unresolvable id
-- to the same dropped-line branch it already uses for deleted menu items.

alter table order_items alter column menu_item_id drop not null;
