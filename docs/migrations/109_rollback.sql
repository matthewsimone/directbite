-- Rollback for supabase/migrations/109_pos_online.sql. Drops 109's functions, triggers and tables (and their
-- data: print claims / log / actions / settings). Touches nothing else: 109 created no column, trigger,
-- default or FK on any live-path table, so no online-ordering object is involved.

begin;

drop function if exists public.pos_online_action_complete(uuid, uuid, jsonb, int);
drop function if exists public.pos_online_action_begin(uuid, uuid, uuid, uuid, uuid, text, jsonb);
drop function if exists public.pos_finish_online_print(uuid, uuid, uuid, int, text, jsonb);
drop function if exists public.pos_claim_online_print(uuid, uuid, uuid);
drop function if exists public.pos_set_print_register(uuid, uuid, text);

drop table if exists public.pos_online_actions;       -- drops trg_pos_online_actions_guard
drop table if exists public.pos_online_print_log;
drop table if exists public.pos_online_print_claims;  -- drops trg_pos_online_print_claims_guard
drop table if exists public.pos_restaurant_settings;  -- drops trg_pos_restaurant_settings_guard

drop function if exists public.pos_online_actions_guard();
drop function if exists public.pos_online_print_claims_guard();
drop function if exists public.pos_restaurant_settings_guard();

commit;
