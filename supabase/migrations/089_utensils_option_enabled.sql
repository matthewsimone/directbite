alter table restaurants
  add column if not exists utensils_option_enabled boolean not null default true;
