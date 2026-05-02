-- ============================================================
-- Logo frame shape (Phase 4 — website logo display options)
-- Adds a per-restaurant choice of frame around the hero logo.
-- ============================================================

alter table restaurants
  add column if not exists logo_frame_shape text not null default 'none';

-- CHECK constraint wrapped in DO block so re-runs are safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurants_logo_frame_shape_check'
  ) then
    alter table restaurants add constraint restaurants_logo_frame_shape_check
      check (logo_frame_shape in ('none', 'circle', 'pill_horizontal', 'pill_vertical', 'hexagon'));
  end if;
end$$;
