# Migration numbering

Migrations in `supabase/migrations/` are applied **by hand** in the Supabase SQL editor (in the order they were
written, not by the Supabase CLI). The numeric prefix is a convention, not a version the CLI tracks.

## Duplicate prefixes 101 and 102

Two branches numbered independently after `100_pricing_shadow_log.sql`, and both sets are applied live:

| Prefix | From `main` (web / app work) | From `pos-server` (POS track) |
|---|---|---|
| 101 | `101_claim_earned_earn_only.sql` (`59e968f`, loyalty: lifetime counts earned points only) | `101_pos_device_auth.sql` (device auth) |
| 102 | `102_push_tokens.sql` (`7948d2c`, push tokens) | `102_restaurants_tablet_guard.sql` (restaurants tablet column guard) |

The files have different names, so git keeps all four. Their contents don't touch the same objects. They are left
as-is: renaming an applied migration would misstate what ran when.

If anyone ever switches to `supabase db push` / `supabase migration list`, these two prefixes collide (the CLI reads
the prefix as the version) and must be resolved first.

## Taken numbers after 118

| Prefix | What | Where |
|---|---|---|
| 119 | `119_marketing_consents.sql` (Marketing: marketing_consents + marketing_consent_events, restaurants.legal_name / public_email) | `main` (`09da4a9`), applied live 2026-11-27 |
| 120 | `120_pos_orders_sales_day_index.sql` (Owner Reports v1: pos_orders (restaurant_id, sales_day)) | branch `owner-reports`, not applied |

## Next number

**121.** 103–118 POS track, 119 Marketing. Every new migration, on any branch, takes the next free number after the highest
in `supabase/migrations/` on `main` **and** the numbers reserved above (a number reserved on an unmerged branch is
taken).
