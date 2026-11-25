-- 112_rollback.sql — undo migration 112: drop pos_online_tablet_setting_change. Run as postgres in the SQL editor.
-- Leaves 111 in place. The settings rows it wrote in pos_online_actions (function 'settings', action estimates /
-- delivery_available / item_availability) stay — they are valid 111 rows (audit). The restaurants / menu_items
-- values it wrote are the web's own columns and are NOT reverted (the tablet / admin set them again as usual).
-- Roll back only with pos-v1-online-settings undeployed or redeployed without the three kinds (else they fail 500).

begin;
drop function if exists public.pos_online_tablet_setting_change(uuid, uuid, uuid, text, int, int, boolean, uuid, jsonb, text, uuid, timestamptz);
commit;
