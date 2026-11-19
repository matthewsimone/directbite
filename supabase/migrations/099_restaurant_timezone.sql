-- 099: restaurants.timezone — the restaurant's IANA time zone.
--
-- Used by the pos-v1 pricing function to resolve the active promotion by the
-- restaurant's LOCAL date (Ordr OPEN-QUESTIONS #10 / PRICING-SPEC D14). The web
-- today picks promos by the UTC date, so a promo starts and ends at ~7-8 pm
-- Eastern instead of local midnight.
--
-- Every current restaurant is in New Jersey / New York, hence the default.
--
-- No CHECK against pg_timezone_names: that is a catalog view, and a CHECK must
-- be immutable. The pricing loader validates the value with Intl instead; an
-- invalid zone fails pricing with `pricing_config_invalid` rather than
-- guessing a zone.
--
-- Additive, with a constant default: Postgres 11+ adds it without rewriting
-- the table. Existing SELECTs are unaffected. The anon read policy on
-- restaurants (001 `anon_read_restaurants`) also exposes this column, which is
-- harmless (a time zone is public information).

alter table restaurants
  add column if not exists timezone text not null default 'America/New_York';

comment on column restaurants.timezone is
  'IANA time zone (e.g. America/New_York). Promotions are resolved by the '
  'restaurant-local date in this zone. Validated by the pos-v1 pricing loader.';
