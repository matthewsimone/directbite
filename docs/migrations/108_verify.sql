-- 108_verify.sql — READ-ONLY checks after migration 108. One row per (relation, privilege); every `pass`
-- must be true. Checks service_role's privilege on every table privilege (SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER) for every pos_* table / view: the intended ones must be held, every other
-- one must be absent — table-level (has_table_privilege) AND, for SELECT / INSERT / UPDATE / REFERENCES,
-- column-level (has_any_column_privilege). Sequences: USAGE + SELECT held, UPDATE (setval) absent.
-- Then anon / authenticated still have nothing. Prints no data.

with intended(rel, privs) as (values
  ('pos_devices',              array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_device_enrollments',   array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_auth_attempts',        array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_device_events',        array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_menu_snapshots',       array['SELECT', 'INSERT']),
  ('pos_orders',               array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_order_lines',          array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_order_line_modifiers', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  ('pos_payments',             array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_order_submissions',    array['SELECT', 'INSERT']),
  ('pos_staff',                array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_staff_settings',       array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_staff_snapshots',      array['SELECT', 'INSERT']),
  ('pos_staff_events',         array['SELECT', 'INSERT']),
  ('pos_shifts',               array['SELECT', 'INSERT', 'UPDATE']),
  ('pos_cash_movements',       array['SELECT', 'INSERT']),
  ('pos_refunds',              array['SELECT', 'INSERT']),
  ('pos_day_closes',           array['SELECT', 'INSERT']),
  ('pos_entity_submissions',   array['SELECT', 'INSERT']),
  ('pos_post_z',               array['SELECT'])
),
priv(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
seqs(s) as (values ('pos_device_events_id_seq'), ('pos_order_number_seq')),
checks(check_name, pass) as (
  -- table-level, every privilege: held iff intended
  select 'service_role ' || case when p = any(privs) then 'HAS ' else 'NOT ' end || p || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else has_table_privilege('service_role', 'public.' || rel, p) = (p = any(privs)) end
  from intended cross join priv
  union all
  -- column-level: no forbidden SELECT / INSERT / UPDATE / REFERENCES on any column either
  select 'service_role no column ' || p || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not has_any_column_privilege('service_role', 'public.' || rel, p) end
  from intended cross join priv
  where p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and not (p = any(privs))
  union all
  -- sequences
  select 'service_role HAS USAGE + SELECT on ' || s,
         case when to_regclass('public.' || s) is null then false
              else has_sequence_privilege('service_role', 'public.' || s, 'USAGE') and has_sequence_privilege('service_role', 'public.' || s, 'SELECT') end
  from seqs
  union all
  select 'service_role NOT UPDATE (setval) on ' || s,
         case when to_regclass('public.' || s) is null then false
              else not has_sequence_privilege('service_role', 'public.' || s, 'UPDATE') end
  from seqs
  union all
  -- the API roles still have nothing
  select 'no privileges: ' || g || ' on ' || rel,
         case when to_regclass('public.' || rel) is null then false
              else not has_table_privilege(g, 'public.' || rel, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') end
  from intended cross join (values ('anon'), ('authenticated'), ('public')) r(g)
  union all
  select 'no privileges: ' || g || ' on ' || s,
         case when to_regclass('public.' || s) is null then false
              else not has_sequence_privilege(g, 'public.' || s, 'USAGE, SELECT, UPDATE') end
  from seqs cross join (values ('anon'), ('authenticated'), ('public')) r(g)
)
select check_name, pass from checks
union all
select '== ALL PASS ==', bool_and(pass) from checks
order by 2, 1;
