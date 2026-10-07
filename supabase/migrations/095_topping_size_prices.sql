-- 095_topping_size_prices.sql
-- Size-dependent topping prices. Already applied live; this file is the record.
-- Idempotent.
--
-- toppings.size_prices (jsonb, nullable):
--   NULL = legacy behavior: whole = toppings.price, half = toppings.price_half
--          (or price / 2 when price_half is NULL). Every existing row is NULL,
--          so nothing changes until a restaurant sets per-size prices.
--   Shape:
--     { "<size name, trimmed + lowercased>": { "price": number, "half": number|null } }
--   e.g. { "large": { "price": 2.5, "half": 1.5 }, "small": { "price": 1.5, "half": null } }
--
-- Keys match item_sizes.name after trim + lowercase + inner-whitespace
-- collapse (src/utils/toppingPrice.js normalizeSizeKey). A size with no key
-- falls back to the legacy prices. src/utils/toppingPrice.js is the single
-- source of truth for how these resolve.

alter table public.toppings
  add column if not exists size_prices jsonb;
