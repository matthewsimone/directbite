-- 069_loyalty_page_config.sql
-- Presentation config for the customer rewards page. Additive only.

begin;

-- Decorative food emoji scattered in the tier card headers, greyscale at
-- low opacity. A short string like '🍕🧄🥤'; the page scatters whatever
-- characters are present. Empty means no decoration, just the color block.
alter table restaurants add column if not exists loyalty_emoji text not null default '';

-- The warm line shown above a signed-in customer's point balance. Per
-- restaurant so the voice matches the shop. Falls back to a neutral default
-- in the UI when empty.
alter table restaurants add column if not exists loyalty_welcome_message text not null default '';

commit;