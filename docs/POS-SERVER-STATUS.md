# POS server status — Ordr POS server work vs. the DirectBite handoff (READ-ONLY AUDIT v4)

## 1. Header

| | |
|---|---|
| Date | 2026-11-23 (America/New_York) |
| directbite `main` HEAD | `5f85378e8d2227aca2643fc9ab3803c5d291b63f` (2026-11-21 15:22 -0500) |
| Worktree | `~/Desktop/directbite-pos-server`, branch `pos-server`, based on `5f85378` (= main). **The worktree and branch already existed when this audit started**, so `git worktree add` was skipped (it would have failed); nothing was recreated. |
| Main checkout (not touched) | `~/Desktop/directbite` on `feat/native-tab-bar` @ `5f85378`, with uncommitted work (`src/lib/domainMap.js`, untracked `supabase/functions/stripe-settlement-probe/`, scripts, a CSV). **None of it is in this worktree, and none of it was audited.** |
| ordr-pos HEAD (read-only) | `a21846090e92ae270110f465777e19c8f8ce244f` on `main`. Untracked: `src/sync/onlineContract.ts` (work in progress, see §7). |
| ONLINE-ORDERS.md | last commit `60947b77790b600fc32c6b52b50f7ada5bd229fb` (2026-11-21 14:03 -0500, "ONLINE ORDERS CP0 …"); file mtime 2026-11-21 13:59. **Today's update is not on disk yet.** This audit uses the committed CP0 text and flags where the brief / `onlineContract.ts` go further. |
| Vendored-file sha256 (ordr-pos `src/core`) | `availability.ts` `712510742cb45e694fc3bce8d3bd0219d741ec554704133438b5824a0b51e8c4` · `cardData.ts` `8419ea0a6bc9f21b907a86842fb39532f37e2dc3ae90b95c79cd7eaad0727cff` · `drawer.ts` `eceac5b6572a4b63bfb8e3a503da44c09460810d383ad9bfbbc5e32a2e4aafb7` · `eod.ts` `3e352d71614d7ee92e846237bd358db50de2123e4e81ef58f474bf3b7ec2f0e5` |
| `pricing_module_hash` | Recomputed from directbite `_shared/ordr-core` (6 files, `sha256sum` manifest) = `11d8ec068c48e128e051c223304313f64e93741447e2834e30e1c32b3c79a7a5`. This matches `ordrCoreInfo.generated.ts:6`, the handoff's `11d8ec06…a7a5`, and ordr-pos `src/core` (all 6 sha256s are byte-identical to `VENDORED.json`). |
| `supabase functions list` | **Skipped.** The worktree isn't linked (no `supabase/.temp`), and linking is forbidden. |

**Caveat: REPO vs LIVE.** Migrations 024–100 were applied by hand and their history is not recorded. Numbers 014, 029, 047 and 048 are missing from `supabase/migrations/`. Columns used in code have no migration: `uber_extends_delivery`, `uber_max_radius_miles`, `website_links`. Every DB finding below is tagged:
- **REPO**: what the migration files say.
- **LIVE-UNVERIFIED**: production may differ. §5 has the SELECT-only SQL to check.

Nothing here claims live state.

---

## 2. Table A — Web holes (P1–P7, W1–W7) + new findings

Severity: **Crit** = money or credentials exposed to anonymous callers today · **High** · **Med** · **Low**.

| ID | Issue | Status | Evidence (file:line / migration / fn) | Gap | Severity | Change type | Fix group | Blocks POS item? |
|---|---|---|---|---|---|---|---|---|
| **P1** | In-house delivery fee is client-supplied | **OPEN** (REPO) | `create-payment-intent/index.ts:158`: `amount` and `order_data` come from the body. The in-house branch `:529-549` never recomputes the fee; the comment at `:582-586` says so. The PI is created with the client's `amount` at `:780-782` and updated at `:621-624`. `stripe-webhook/index.ts:116,209,215` stores `delivery_fee` / `total_amount` from `order_data` and never compares them with the PI amount (read only, note only). The client computes the fee at `CheckoutPage.jsx:1359-1365` / `:1768` (`calculateDeliveryFeeCents`). | No server fee. **Wider than P1 (NEW, see N1):** on every non-Uber path (pickup and in-house) the server trusts the whole `amount`. The only total check is in the Uber branch (`:481-496`), and it is still built from client `subtotal` / `tax_amount`. pos-v1 pricing runs in **shadow only** (`:6-8`, `shadowGuard.ts:1-12`: "never changes the charge"). | **Crit** | fn deploy (+ Vercel if the request shape changes) | **G1** | Item 5: share the fee + geocode code with `pos-v1-quote-delivery` |
| **P2** | `delivery_available` not enforced server-side | **OPEN** (REPO) | No server read of `delivery_available`. grep across `create-payment-intent`, `stripe-webhook`, `uber-quote`, `uber-create-delivery`, `_shared/uberCreateDelivery.ts`, `pos-v1-price-order` and `_shared/pos-v1/*` finds nothing. The CPI restaurant select `:173-183` doesn't include it. Browser only: `CheckoutPage.jsx:1130,1132,1639,2491`. | Server paths that accept a delivery order: **`create-payment-intent`** (the only one that creates the charge). `uber-quote` quotes for any restaurant with no check. `stripe-webhook` writes whatever `pending_orders` holds. `uber-create-delivery` dispatches. `pos-v1-price-order` prices delivery without the flag. | Med | fn deploy | G1 (+ G2 for uber-quote) | Item 11 (settings `delivery_available` must be authoritative); item 5 (`restaurant.delivery.enabled` in the snapshot) |
| **P3** | `uber-quote` unauthenticated | **OPEN** (REPO) | `config.toml:144-145` `verify_jwt = false`. The handler `uber-quote/index.ts:65-95` has no auth (the header comment `:12` says the client sends the anon key). | An anonymous caller with any `restaurant_id` can: mint or refresh an Uber OAuth token on **that restaurant's creds or the platform account** (`:143`, `_shared/uberToken.ts:11-14,88,108`); call Uber `delivery_quotes` (`:198-205`) on our account, with no rate limit beyond Uber's 429 (`:224-232`); write `uber_quotes` rows (`:316-333`) and delete stale ones (`:306-310`). It doesn't check `is_open`, `delivery_available` or the radius (the radius is only checked later in CPI). | Med | fn deploy | **G2** | Item 11 (Uber dispatch moves server-side; same creds) |
| **P4** | Browser coordinates trusted | **OPEN** (REPO) | Coordinates come from the browser (Places), `CheckoutPage.jsx:1518-1519` (`dropoff_lat/lng` into `order_data`), distance at `:1764-1768`. Used by CPI's distance guard `:558-581` (skipped when coords are missing, `:582-591`), the `uber-quote` payload `:181-182`, the `uber_quotes` cache `:331-332`, and `stripe-webhook:233-234` → `orders.dropoff_lat/lng` → `uber-create-delivery` re-quote. | No server geocode on the order path. **Reusable:** `admin-create-restaurant/index.ts:79-90` `geocodeAddress()` (Google Geocoding; secret `GOOGLE_MAPS_API_KEY` = ****) → move to `_shared`. | High (it feeds P1) | fn deploy (+ secret already present, LIVE-UNVERIFIED) | G1 | Item 5 (`pos-v1-quote-delivery` needs the same geocoder) |
| **P5** | `tablet_update_own_orders`: no column limits | **OPEN** (REPO); live definition LIVE-UNVERIFIED | `migrations/001_initial_schema.sql:377-381`: `create policy "tablet_update_own_orders" on orders for update using (restaurant_id in (select id from restaurants where tablet_email = auth.jwt() ->> 'email'));`. No later migration alters it: the only other orders policies are `004:55` `admin_all_orders`, `010` / `044` (anon select, dropped) and `043` (anon insert, dropped). No `GRANT` / `REVOKE` on `orders` in any migration. | **Precise effect:** with no `WITH CHECK`, Postgres reuses `USING` as the check, so a tablet **can't move** an order to another restaurant. It **can write every column** of its own restaurant's orders: `status`, `refund_status` / `refund_amount` / `refunded_at` (fires `trg_orders_reverse_loyalty`, `081:108-116`), `total_amount` / `subtotal` / `tax_amount` / `tip_amount` / `delivery_fee`, `stripe_payment_intent_id` / `stripe_charge_id`, `items_written_at` (fires loyalty accrual, `063:241-244`), `uber_*`, `customer_*`. **What the tablet actually writes:** `status`, `accepted_at`, `quoted_for` (`OrdersTab.jsx:566-573,707`); `acknowledged_at` (`:1732-1734`); `stuck_acknowledged_at` (`:1745-1747`); `print_status`, `print_attempts` (`:657-660`, `:1788-1791`, `useOrderPolling.js:254-257`); `status='in_progress'` wake-up (`useOrderPolling.js:536-540`); bulk `status='complete'` (`SettingsTab.jsx:491-494`). Refund and cancel go through `admin-refund` (service role). Fix shape: `REVOKE UPDATE ON orders FROM authenticated; GRANT UPDATE (status, accepted_at, quoted_for, acknowledged_at, stuck_acknowledged_at, print_status, print_attempts) ON orders TO authenticated;` plus a `WITH CHECK` (or trigger) limiting status moves. Precedent: `090:92-95` does exactly this for `external_orders`. | High | migration | **G3** | Item 11 (server-side CAS actions replace these writes; the column grant must keep the web tablet working until `pos_online_orders_enabled`) |
| **P6** | `is_open` / hours / `delivery_available` / `tax_rate` checked only in the browser | **OPEN** (REPO) | `is_open`: `useRestaurant.js:129-130,160`. Hours: `useRestaurant.js:160-174`. `delivery_available`: P2. `tax_rate`: `CheckoutPage.jsx:1394,1403` computes tax; CPI stores the client's `tax_amount` (Uber branch `:484` only sums it). | Enforcement belongs in `create-payment-intent` (reject when closed or outside the service window per `pickup_schedule` / `delivery_schedule` / `hours` in `restaurants.timezone`; recompute tax from `restaurants.tax_rate`). The pos-v1 loader already rejects `tax_rate ∉ [0,1)` (`_shared/pos-v1/loader.ts:283-286`) and resolves the timezone (`:317`), but not open/hours. Scheduled orders: `scheduled_for` is not checked against hours anywhere server-side. | Med | fn deploy | G1 | Item 11 (Q-M5 "Pause online orders" needs server enforcement first) |
| **P7** | Partial refund cancels the Uber delivery | **OPEN** (REPO) | `admin-refund/index.ts:166`: `if (order.delivery_fulfillment_method === "uber_direct")` → `cancelUberDelivery` with **no `type` check**. The partial amount is applied only at `:188-190`. Full vs partial is distinguished only for `refund_status` / `status` (`:218-232`). `refundUberAppFee` also runs on partial (`:249-254`). | Related edge cases at the same call site: (a) `type:'partial'` with no or zero `amount` → Stripe **full** refund recorded as `refund_status='partial'` with no cancel (`:188-221`); (b) `type` missing → full refund, `refund_status='completed'`, status **not** cancelled (`:226`); (c) `refund_amount` is **overwritten** per refund, not cumulative (`:222`); (d) `status='complete'` orders are refused outright (`:125`), so no partial refunds after completion. **Callers:** tablet `OrdersTab.jsx:522-531` (`type:'full'` only); admin `pages/admin/OrdersTab.jsx:138` (full) and `:148-152` (**partial**, the only partial caller). | Med–High (customer loses the delivery on a partial refund) | fn deploy | **G4** | **Item 11** POS partial refunds (`onlineContract.ts` gates them on `capabilities.partial_refund`, "D17: only once P7 is fixed") |
| **W1** | Uber secrets readable by anon | **OPEN** (REPO); live column privileges LIVE-UNVERIFIED | Credential columns: `restaurants.uber_client_id`, `uber_client_secret` (`031:59-62`, "D1 plaintext, RLS-protected"), `uber_webhook_signing_secret` (`036:52`). RLS: `001:409-412` `anon_read_restaurants … to anon using (true)`. **No `GRANT` / `REVOKE` on `restaurants` in any migration**, so anon (Supabase default grants) can SELECT every column of every restaurant. Client `select('*')` as **anon on every customer page**: `useRestaurant.js:77`, `CustomDomainShell.jsx:58`. As **authenticated** (tablet, own row): `useTabletAuth.js:40-44`, `TabletPage.jsx:133-137`, and every `update(…).select()` in `SettingsTab.jsx` (e.g. `:382,393,1761,1826`), `WebsiteLinksEditor.jsx:159`, admin `RestaurantsTab.jsx:20,26,252`. Server code that needs the creds (all service role): `_shared/uberToken.ts:88`, `_shared/uberCreds.ts:72-90,154-166`, `uber-webhook/index.ts:232,275`. The tablet **writes** them: `SettingsTab.jsx:555-557`. | Anon also sees `tablet_email`, `stripe_account_id`, `sms_phone`, `notification_email`, `printer_ip` (NEW detail). **Fix shape (recommended):** move the 3 secrets to a private table `restaurant_secrets` (RLS on, no policies, `REVOKE ALL FROM anon, authenticated`), read only by service role, and written through an edge function (the tablet setup wizard). Alternative: column `REVOKE SELECT` from anon/authenticated + `GRANT SELECT (safe cols)`. That breaks every `select('*')` and `update().select()` listed above (PostgREST errors on `*` without full column privilege), so the clients would have to be changed to explicit column lists first (Vercel), then the migration. A view doesn't stop direct table reads unless the table grant is revoked too. **Rotation** (after the read path is closed): new Uber client secret + webhook signing secret per restaurant in Uber's dashboard → store via the new path → clear the `uber_oauth_tokens` cache → verify `uber-quote` / `uber-webhook` on Test Pizza. Platform creds live in secrets (names only: see `uberToken.ts` `platform_creds_not_configured`), so rotate those if they were ever in a row. **What breaks on a REVOKE:** the anon `select('*')` calls (menu page, custom domains = total customer outage), tablet `select('*')`, and every `.update().select()`. | **Crit** | migration + Vercel + **secret rotation** | **G3** (+ G7 rotation) | Item 11 (server-side Uber dispatch reads creds; build it on the new private read path) |
| **W2** | Backup tables in public | **NOT IN REPO** | No `create table` with a backup-like name in any migration. Full repo table list in §5.3. | Any such table exists only live (manual SQL). RLS, grants and sensitive columns are unknown. §5.3 lists every public table **not** in the repo. | Unknown → treat as High until checked | migration (drop or lock down) | G3 | — |
| **W3** | `create-payment-intent` 500s | **OPEN** (REPO); causes ranked, LIVE-UNVERIFIED | One catch-all `:887-893` returns **500 + the raw `err.message`** for everything. Unhandled throws: `req.json()` on a bad body (`:158`); `throw new Error("Failed to create pending order")` (`:684-686`); `stripe.paymentIntents.retrieve/update` (`:599-602,621-635`; a foreign or expired PI id, wrong account); `stripe.paymentIntents.create` (`:780-797`). Validation gaps: `amount` is only checked as truthy (`:165`); no integer / ≥ 50¢ / number-type check; `idempotency_key` is passed straight to Stripe (`:795`). | Likely causes, ranked: **1)** Stripe `paymentIntents.create` rejections (amount < 50¢ / non-integer / string; `idempotency_key` reused with different params → Stripe idempotency error), all surfaced as 500; **2)** update path `retrieve` on a PI the account can't see (stale `payment_intent_id` after a restaurant switch or swap); **3)** `pending_orders` insert failure (`:678-686`); **4)** malformed JSON. Stripe `type` isn't mapped to 4xx. Confirm with function logs (not accessible here). | Med | fn deploy | G1 | — |
| **W4** | PI created before the promo loads | **OPEN** (REPO) | `usePromotion.js:4-33`: `promotion` starts `null` with **no loading state** (null = no promo and = not loaded yet). `CheckoutPage.jsx:1111,1305,1318` → `total`. The create effect `:2009-2099` fires as soon as `restaurant && items.length` (`:2032`), with `amount: Math.round(total*100)` (`:2051`). The debounced update `:2164-2180` fails **silently** (`:2179-2180`). Pay: `flushOrderData` `:2189-2196` (5 s cap), then `:671-672` **"continuing"** even when the flush failed or timed out → `stripe.confirmPayment` (`:677`). | **Yes, charged ≠ displayed is possible:** promo resolves after create → screen shows the discounted total; if the update / flush fails or times out, the PI keeps the pre-promo amount (overcharge). The order row comes from `pending_orders` (the last successful push), so the order record can also disagree with the charge. The server never recomputes (shadow only). Also `usePromotion.js:11` uses the **UTC** date. | Med | Vercel (+ G1 server recompute fixes the class) | G1 + Vercel | — |
| **W5** | Admin `tax_rate` field has no ÷100 | **OPEN** (REPO); affected rows LIVE-UNVERIFIED | Admin edit: `pages/admin/RestaurantsTab.jsx:172` `field('Tax Rate','tax_rate','number')` shows the raw decimal; save `:63` `parseFloat(data.tax_rate)` → `admin-create-restaurant/index.ts:118` stores it with **no range check**. Onboarding: `OnboardingTab.jsx:134,283` (percent ÷ 100). Tablet: `SettingsTab.jsx:184` (×100 display), `:516` (÷100 save). | Stored = whatever the admin types. Intended = a fraction (0.06625). An unchanged value round-trips correctly. Typing a percent (6.625) stores 662.5 %: the checkout taxes it (`CheckoutPage.jsx:1403`) and `pos-v1` would 500 that restaurant (`loader.ts:284-285`, `pricing_config_invalid`), which blocks its menu snapshot. Count: §5.6 SQL (`tax_rate >= 1`). | Low–Med | Vercel + fn deploy (range check) | **G5** | Item 1 (a bad `tax_rate` makes `pos-v1-menu-snapshot` fail for that restaurant) |
| **W6** | `check-failed-prints` has no schedule | **CONFIRMED** (REPO); cron LIVE-UNVERIFIED | `config.toml:117-118` `verify_jwt = false`; no `schedule`; no `cron.schedule` for it in any migration (the only ones: `093:16` kh-backstop, `100:55` shadow-log retention). What it does (`check-failed-prints/index.ts:21-26,50-59`): selects `orders` with `print_status='failed'` and `print_attempts < 3`, then POSTs each to `retry-print` with the service key. **No auth at all**: anyone can trigger the sweep. `retry-print` is the **legacy PrintNode** path (`retry-print/index.ts:237`, `printnode_printer_id`); tablets print via Epson ePOS. | Decide: **retire** (the POS print claim replaces it) or schedule via pg_cron + a cron-secret header (the kh-backstop pattern, `093`, `kh-backstop/index.ts:67-73`). Scheduling as-is would re-send Epson failures to PrintNode (likely no-op or wrong printer). | Low | migration (cron) + fn deploy (auth) or retire | **G6** | Item 11 (print semantics: `pos_print_result` must keep `print_status` truthful) |
| **W7** | `orders` not in the realtime publication | **CONFIRMED** (REPO); live LIVE-UNVERIFIED | Only `external_orders` (`090:118-121`) and `dsp_provider_status` (`094:40-43`) are added to `supabase_realtime`. The tablet subscribes to `orders` changes at `useOrderPolling.js:669-678`. | If live matches the repo, the tablet's realtime does nothing and the 10 s poll does all the work. The POS feed does **not** depend on realtime (ONLINE-ORDERS D1: device-authed cursor poll; devices have no Supabase session). Adding `orders` exposes row changes to every `authenticated` subscriber that passes RLS. Check P5 / RLS first. | Low | migration | G3 | No (D1 is a poll) |
| **N1** (NEW) | Whole checkout total trusted on non-Uber paths | **OPEN** (REPO) | See P1: `create-payment-intent/index.ts:780-782` ("already in cents from frontend"); no total check outside `:481-496`. | A crafted request can pay any amount ≥ Stripe's minimum for any cart; the restaurant sees real items. The fix is enforcing the pos-v1 pricing (already shadowed in prod for allow-listed restaurants, `:23-26`). | **Crit** | fn deploy | G1 | — |
| **N2** (NEW) | `tablet_update_own_restaurant` has no column limits | **OPEN** (REPO) | `001:253-256` (same shape as P5). No later migration alters it. | A tablet login can write any column of its own restaurant, including `stripe_account_id` (payouts), `tax_rate`, `uber_billing_mode` (`platform` makes DirectBite front Uber fees), `recoup_*`, `is_open`, `tablet_email`, `slug`, `custom_domain`. Admin-only columns per ONLINE-ORDERS A1 (`is_open`, `recoup_*`, lat/lng) are only admin-only in the UI. | High | migration (column grants) | G3 | Item 11 (`pos-v1-online-settings` allow-list should become the tablet's allow-list too) |
| **N3** (NEW) | Anonymous side-effect functions keyed only by id | Note | `send-ready-email` (`config.toml:99-100`; guards `:143-183`, once via `ready_email_sent_at`), `send-confirmation-email`, `send-order-sms`, `send-order-restaurant-email`, `retry-print`, `get-order-by-pi`: `verify_jwt=false`, no caller check. | Bounded by unguessable UUIDs / PI ids. `send-ready-email` is idempotent. `retry-print` / `send-order-*` can re-send. Fold the ready email into the item 11 `accept` action (service-side) and drop the public entry point later. | Low | fn deploy | — | Item 11 |

### Fix groups (same file / function)

| Group | Touches | Items | Ships as |
|---|---|---|---|
| **G1** | `supabase/functions/create-payment-intent/index.ts` (+ `_shared` geocoder from `admin-create-restaurant:79-90`, + pos-v1 loader in enforce mode) | **P1, N1, P2, P4, P6, W3**, server half of **W4** | fn deploy (behind a per-restaurant enforce allow-list, Test Pizza first), then Vercel for any request-shape change |
| **G2** | `supabase/functions/uber-quote/index.ts` | **P3** (+ P2 / P6 / radius checks) | fn deploy (keep `verify_jwt=false`; add an origin + per-IP/restaurant rate limit or a signed checkout token) |
| **G3** | one migration: `orders` / `restaurants` grants + policies, private secrets table, publication, backup tables | **W1, P5, N2, W2, W7** | Vercel first (explicit column lists), then the migration |
| **G4** | `supabase/functions/admin-refund/index.ts` | **P7** + edge cases (a)–(d) | fn deploy |
| **G5** | `src/pages/admin/RestaurantsTab.jsx` + `admin-create-restaurant` range check | **W5** | Vercel + fn deploy |
| **G6** | `check-failed-prints` (+ cron migration or delete) | **W6** | fn deploy + migration, or retire |
| **G7** | Uber dashboard + the new secrets path | **W1 rotation** | secret rotation, after G3 |

---

## 3. Table B — Handoff items 0–11

Status values: **MISSING** (nothing in the repo) · **PARTIAL** · **DONE**.

| Item | Requirement (1 line) | Status | Evidence | Gaps vs DEVICE-AUTH / SYNC-CONTRACT / ONLINE-ORDERS / reference | Depends on |
|---|---|---|---|---|---|
| **0** | "Device auth first — hard blocker. Build DEVICE-AUTH.md (opaque hashed `odt_` device token, one-time enrollment code with per-code + per-IP lockout, device principal drives restaurant / writer device / in-person pricing, revoke)." | **MISSING** | No `pos_*` tables in any migration. No `pos-v1-*` function except `pos-v1-price-order`. | Everything below. | — |
| 0.a | Tables (DEVICE-AUTH §2): `pos_devices`, `pos_device_enrollments` (+ partial unique `pos_enrollments_live_lookup`), `pos_auth_attempts`, `pos_device_events`. RLS on, no policies. | MISSING | — | Include `pending_token_hash` / `pending_token_issued_at` now (§12.1). Event types: §2 lists 8 (incl. `rotation_offered` / `rotated`); the reference uses 6. Keep all 8 in the CHECK. Prefix `^[A-Z]{1,2}$`, `unique (restaurant_id, prefix)`, never reused (reference `nextPrefix` `fakeDeviceAuth.ts:142-148`, which also counts unused new-device enrollments). | migration |
| 0.b | `pos-v1-register-device` (§4.1): IP gate → replay → usable enrollment → `400 enrollment_invalid`. | MISSING | — | Reference `fakeDeviceAuth.ts:223-284`. Order: **IP gate first** (`:224-225`; the gate writes no attempt row). Code normalized (`:78-80`) and must match `^[0-9A-HJKMNP-TV-Z]{10}$` plus a non-empty nonce, else invalid with **no** per-code count (`:242`). **Replay**: newest **used** enrollment for the lookup, same nonce, < 10 min, right secret → **fresh** token for `used_device_id`, not an attempt (`:248-254`). Then a live enrollment (unused and unlocked). Wrong secret → count. **Expired** with the right secret also counts (`:258-259`; secret is checked before expiry). New-device code + `existing_device_id` → invalid + count (`:263`). Re-enroll only when `existing_device_id === target_device_id` (`:269`); it reactivates (clears `revoked_*`). Per-code lock at 5 (`:230-235`, event `enrollment_locked`). **Per-IP:** only FAILED attempts count; 5 / 15 min → 429 with `Retry-After` = until the oldest of the last 5 ages out; 50 / 24 h hard cap (`:210-219`). Successes write a `success=true` row (`:282`) but never count. Every failure is the same body `{error:{code:'enrollment_invalid',message:'Code invalid or expired'}}` (`:237`). Real server: `Retry-After` header in **seconds** (reference returns ms internally). Caller IP from the gateway (`x-forwarded-for` first hop): verify in the build. | 0.a |
| 0.c | Middleware on every device function, exact codes. | MISSING | — | Reference `fakeDeviceAuth.ts:292-312`. No token → `401 device_unregistered`; unknown hash → `401 device_unregistered`; revoked → **`401 device_revoked` (the only lock)**; `x-ordr-device-id` ≠ `device.id` **incl. missing** → `403 device_mismatch`; else principal `{device_id, restaurant_id, prefix}`. `last_seen_at` + `last_app_version` (from `x-ordr-client: ordr-pos/<v>`) only when older than 60 s (`:306-310`). `auth_failed` events capped at 10/min (`:315-319`). `429 rate_limited` + `Retry-After` per SYNC §3.3 (no per-device limit in v1, DEVICE-AUTH §5). Also: `x-ordr-api-version` ≠ 1 → **426 `upgrade_required`** (SYNC §6; the existing pos-v1 code returns **400** `unsupported_api_version`, `errors.ts:13`, so don't reuse it for device functions). `pos-v1-menu-snapshot` must answer the If-None-Match probe cheaply (pause recovery, DEVICE-AUTH §7.2 amendment). | 0.a |
| 0.d | Identity rules (SYNC §1a) incl. the ticket-prefix rule. | MISSING | — | Reference `fakeServer.ts:232-253` (`orderIdentity` / `entityIdentity`), run **before** the content-hash check. Order: body `restaurant_id` ≠ principal → `400 restaurant_mismatch`; body `device_id` ≠ → `403 device_mismatch`; existing order of another restaurant → `400 restaurant_mismatch`; prefix rule (below); `channel` ∉ {counter, phone, dine_in} → `400 invalid_payload`. Writer device = principal (`:416`, `handle(p, pr.device_id)`). In-person pricing from the principal: service fee 0, recoup 0 (`:1020-1030`). Snapshots: body `restaurant_id` ≠ → 400 (`:195-204`). quote-delivery: pinned snapshot of another restaurant → 400 (`:221-225`). **Approved rule, quoted exactly (handoff item 0):** "**Ticket prefix rule (APPROVED Matt, 2026-11-21; DEVICE-AUTH §4.3):** a **new** order's `ticket.prefix` must be the principal's prefix; an order the server **already has** keeps its stored ticket prefix — the request's prefix must equal it (another register of the restaurant may write the order under SYNC-CONTRACT §3.1, but can never change its ticket). Either violation → `400 prefix_mismatch`. Reference: `orderIdentity` in `test/support/fakeServer.ts`." | 0.c |
| 0.e | Admin UI: add / re-enroll / revoke (DEVICE-AUTH §6). | MISSING | No device UI in `src/pages/admin/*`. | List devices (label, prefix, status, model, app version, last seen, token age); Add register → `XXXX-XXXXXX` + QR `ordrpos://enroll?code=…`, 30 min; Re-enroll bound to the device; Revoke with a required reason (`fakeDeviceAuth.ts:150-158`); locked IPs from `pos_auth_attempts`. All through an admin-JWT edge function (`admin_users` check, as `admin-refund:50-54`), never table access from the browser. | 0.a |
| 0.f | Deno tests per §12. | MISSING | Existing pos-v1 tests: `_shared/pos-v1/tests/*` (pricing only). | Every error code; replay; re-enroll right / wrong device; revoke + reactivate; per-code lockout; per-IP lockout (15 min + 50 / day); cross-restaurant rejection; in-person pricing from the principal. Port the cases in `ordr-pos test/sync/deviceAuth.test.ts:43-170,254-326`. | 0.b–0.d |
| 0.g | Gateway passthrough of `x-ordr-device-token`. | UNVERIFIED | `config.toml:29-33`: an unlisted function may default to `verify_jwt = true`, so **every new `pos-v1-*` needs a `[functions.…] verify_jwt = false` entry**. `_shared/pos-v1/cors.ts:17` allow-list lacks `x-ordr-device-id` / `x-ordr-device-token` / `x-ordr-client` (irrelevant to the native app, but add them if any browser tool calls these). | Test on Test Pizza after deploy: a request with `apikey` + `x-ordr-device-token` and **no** `Authorization` reaches the handler with the header intact (DEVICE-AUTH §4). | 0.c |
| **1** | `pos-v1-menu-snapshot`: snapshot fields (SYNC §4), all present and hashed, persisted. | **MISSING** (function); data sources exist | Loader reads restaurant + menu (`_shared/pos-v1/loader.ts`, `db.ts`); `dollarsToCents` vendored (`ordr-core/money.ts:199`). | Field by field (REPO source → status): `restaurant.name` ← `restaurants.name` (001:8) ✔ source; `restaurant.timezone` ← `099:21` ✔ (LIVE-UNVERIFIED applied); `business_day_cutoff` → **no column**, default `"04:00"`; `restaurant.address{street,city,state,zip,phone}` → **only a free-text `address` (001:11) + `phone` (001:10)**, needs parsing or new columns, phone to E.164; `tax_rate` decimal string ← `001:13` (W5); `recoup_rate` → in-person `"0"` per principal (the snapshot shows the restaurant's value: confirm which, see §7 Q4); `delivery{max_radius_miles,tier1_max_miles,tier1_fee_cents,tier2_fee_cents}` ← `021:4-7`; `minimum_in_house_cents` / `minimum_uber_direct_cents` ← dollar columns (`031`) via `dollarsToCents`; `offline_fee_cents` = `tier2 ?? tier1 ?? 0`; `enabled` ← `delivery_available` (001:14); `fulfillment` ← `delivery_fulfillment` (031:52-53, CHECK lacks `both`; 032 per ONLINE-ORDERS A1, LIVE-UNVERIFIED); `loyalty{…}` ← `loyalty_*` (063 / 069 / 071 / 072 / 075); `promotion` (restaurant-local date, deterministic); `categories[].discount_exempt` ← `052:5-6`; `categories[].availability` ← `086:6` normalized via vendored `availability.ts` (item 4); `items[].description`, `sort_order`; `item_topping_groups[].sort_order`; `topping_groups.selection_type/required/max_selections`; `toppings.is_default/sort_order`; `size_prices` (095) with invalid entries dropped; distances as decimal strings. **Canonical JSON + §7.1 vector: no implementation or test in directbite** (no `88812ec3` anywhere). **Persistence:** `pos_menu_snapshots(hash PK, restaurant_id, body jsonb, first_served_at)`, never deleted while referenced. Must answer If-None-Match cheaply (pause probe). | 0, 4 |
| **2** | submit-order fields `note` / `ready_at` / `void_reason` (always present, hashed, stored). | **MISSING** | — | Store per SYNC §3.2 (`note` ≤ 500 trimmed; `ready_at` ISO ms). Payments carry `status` + `void_reason`. | 0 |
| **3** | `availability_flag`: judged at `device_time` against the pinned snapshot; applied + flagged, never 400. | **MISSING** | — | Reference `fakeServer.ts:990-1007`: active lines only; unknown item skipped (the 400 for unknown ids comes from pricing); `is_available=false`, a closed category window at `device_time` in the snapshot timezone, or a topping `is_available=false` → flag. `item_unavailable` must **not** be a submit-order error (the web `pos-v1-price-order` keeps it as 409, `errors.ts:36`). | 0, 1, 4 |
| **4** | Vendor `availability.ts` byte-identical; replace `_shared/pos-v1/categoryWindow.ts`. | **MISSING** | `_shared/ordr-core/` holds only `money.ts` + `order/*` (`VENDORED.json`, sourceCommit `72d5544`). `availability.ts` / `cardData.ts` absent. | Not in the drift manifest. `scripts/check-ordr-core.mjs:17,73` covers money + order only and **fails on any unexpected file** in `ordr-core/`, so vendoring needs a manifest + script change that keeps them **out of** `pricing_module_hash`. Remaining `categoryWindow.ts` uses: `_shared/pos-v1/loader.ts:39` (import `isCategoryAvailableAt`), used for diagnostics at `:115,320,398`, surfaced in `shadow.ts:321,338`. Target sha256 = header values. | — |
| **5** | Delivery: `pos-v1-quote-delivery`, submit-order `delivery` + fee-source validation + 9 flags, snapshot additions. | **MISSING** | Haversine exists (`create-payment-intent:62-81`, R = 3958.8, same as the reference `fakeServer.ts:1145-1152`); geocoder exists (`admin-create-restaurant:79-90`). | `pos_delivery_quotes` (24 h). Quote body per reference `fakeServer.ts:728-772` (`dq_` id, `normalized_address`, `needs_confirmation`, `lat` / `lng` to 6 dp strings, `distance_miles` to 2 dp, `in_radius`, `tier`, `fee_cents`, `max_radius_miles`). Unknown address → `400 address_not_found`. Fee per source, never device cents (`:779-857`); no delivery rule ever 400s. Shares G1's geocoder / fee code. | 0, 1, P1 / P4 fix |
| **6** | External card tender + card-data guard. | **MISSING** | — | Vendor `cardData.ts` (sha above). `paymentShapeError` rules; payments insert-only, captured → voided only (`fakeServer.ts:910-925`). Guard runs on the payload minus `provisional_pricing` (`:870-875`). | 0, 4-style vendoring |
| **7** | EOD: `pos-v1-submit-shift` / `-refund` / `-day-close`, tables, flags. | **MISSING** | — | Reference envelope `fakeServer.ts:537-566`: hash → card guard → idempotency `(type,id,version)` (dup → original response with `result:'duplicate'`; different hash → 409). Refund `:643-661` (`409 unknown_payment` retryable; method equality; `refund_exceeds_payment` flag). Day close `:664-678` (`409 day_close_sequence_taken`; `supplemental == sequence > 1`). `post_z` `:681-708`; drawer re-verify `:636-639`. Vendor `drawer.ts` (+ `eod.ts`). | 0 |
| **8** | Staff: `pos_staff`, `pos_staff_settings`, `pos-v1-staff-snapshot`, `pos-v1-submit-staff-events`, actor flags, `scripts/pos-staff.ts`. | **MISSING** | — | scrypt default `{n:8192,r:7,p:1,dk_len:32}`; check the test vector before first use; script never committed with creds. | 0 |
| **9** | `pos-v1-price-order` unchanged (camelCase `pricingModuleHash`). | **DONE** (unchanged) | `pos-v1-price-order/index.ts:11`; `handler.ts:20,82`; `config.toml:239-240`. | Keep its flat `{code,message}` errors and 400 version error. Don't copy them into device functions (§7 Q3). | — |
| **10** | Later: KitchenHub menu sync (UNMAPPED lines print raw). | Not started (by design) | — | — | — |
| **11** | Online orders on the POS (ONLINE-ORDERS §B2 / §D). | **MISSING** (server) | See sub-rows. | The committed doc is CP0 "pending Matt's review". The wire shapes in untracked `onlineContract.ts` already differ (§7 Q1). | 0 |
| 11.a | Inbound feed `pos-v1-online-orders` (cursor = `orders.pos_change_seq`). | MISSING | Build on: `stripe-webhook` stamps `items_written_at` last (`stripe-webhook/index.ts:437-449`); the tablet's poll query (`useOrderPolling.js:395-400`). | No `pos_change_seq` column / sequence / trigger. `orders` has no `updated_at`. Written orders only; money → cents server-side; settings + hash. | 0 |
| 11.b | Ack / status updates `pos-v1-online-order-action`. | MISSING | Today's writes: P5 list. CAS precedent: `useOrderPolling.js:536-540` (`.eq('status','scheduled')`); `kh-order-action` (tablet JWT + CAS). | Idempotency by `action_id` needs a table (none). `409 status_conflict` + order. | 0, P5 |
| 11.c | Exactly-once print claim `pos-v1-online-print`. | MISSING | Today: `print_status` / `print_attempts` only (`001:128-130,135`), written **after** printing (`OrdersTab.jsx:657-660`, `useOrderPolling.js:254-257`). No claim. | `orders.pos_print_claimed_by` / `_at` / `pos_print_result`; `restaurants.online_print_device_id`. CAS `claimed_by IS NULL` (auto); takeover "unclaimed OR (failed AND claimed_at < now − 60 s)". `result` also writes `print_status` / `print_attempts`. | 0, W6 decision |
| 11.d | POS-readable online-ordering settings (`OnlineSettingsWire` + hash; `pos-v1-online-settings` allow-listed, audited). | MISSING | Source columns exist: `is_open` (001:19), `hours`, `pickup_schedule` / `delivery_schedule` (097:8-9), `timezone` (099), `estimated_*` (001:17-18), `ready_time_confirmation_enabled` (087:12), `delivery_available`, `print_trigger` (060:8), `auto_print_copies` (051:10), `receipt_font` (059), `dsp_orders_enabled` (091). | `pos_settings_changes` audit table. The `onlineContract.ts` version adds `business_day_cutoff`, normalized `service_windows`, `delivery_providers[]`, `capabilities.partial_refund`. | 0, N2 |
| 11.e | Per-restaurant tablet-off flag `restaurants.pos_online_orders_enabled` (Q-M1). | MISSING | — | The web tablet must read it and stop ack / print / chime ("Online orders are on the register"). That's a Vercel change in `useOrderPolling.js` + `OrdersTab.jsx`. It's also the rollback switch. | 0 |
| 11.f | Delivery-provider abstraction (Uber Direct now, OrderOut later). | MISSING server-side; **not in committed ONLINE-ORDERS.md** | Uber code: `_shared/uberMode.ts`, `uberCreateDelivery.ts`, `uberCancel.ts`, `uber-webhook`. | Only `onlineContract.ts` (untracked, D16 "Matt 2026-11-23") defines `delivery.provider` / normalized `status` / `provider_status`. Needs a server mapping `uber_status` → normalized status, and a provider interface in `_shared`. | 11.a |
| 11.g | POS full + partial refunds (`cancel_refund`). | MISSING; partial **blocked by P7** | `admin-refund` full path (`:155-237`) is the logic to reuse. | Full: Uber cancel first, Stripe refund; Stripe failure → `refund.status='failed'`, not cancelled. **Partial: needs G4** (no Uber cancel on partial; cumulative `refunded_cents`; allow after `complete`). Committed doc Q-M3 proposes **full only**; `onlineContract.ts` gates partial on `capabilities.partial_refund`. Manager gate `online_refund` on the device. | G4 |
| 11.h | Ready-time email server-side (inside `accept`). | MISSING (exists as a tablet-fired fn) | `send-ready-email/index.ts:138-183` guards (flag, not uber_direct, not scheduled, has `quoted_for`, once via `ready_email_sent_at` from 087:9, has email); stamp after send `:223-234`. Fired by the tablet `OrdersTab.jsx:707-718` (anon key, fire-and-forget). | Call the same logic from `accept` with service role. Note: it hard-codes America/New_York (`:16-41`), not `restaurants.timezone`. | 11.b |
| 11.i | Uber dispatch server-side (inside `accept` / `schedule`). | MISSING (exists as a tablet-fired fn) | `uber-create-delivery` (tablet JWT, `:199-205`) → `_shared/uberCreateDelivery.ts`; called by `OrdersTab.jsx:774`. | Reuse `_shared/uberCreateDelivery.ts` with the device principal instead of the tablet JWT. `502 uber_failed` (nothing changed). W1's secret move must land first or together. | 11.b, W1 |
| 11.j | Scheduled Uber wake-up as a server job (D9). | MISSING | Today: tablet poll `useOrderPolling.js:520-544` (CAS on `status='scheduled'`, lead = `estimated_pickup_minutes`). pg_cron precedent `093:16` (+ secret header). | New cron or do it inside the poll function. Remove the tablet's copy once `pos_online_orders_enabled` is on, or keep both (the CAS makes it safe). | 11.a |
| 11.k | Tablet parity gaps. | — | ONLINE-ORDERS A1–A6 inventory. | Server-only today: none of the alerts. `quoted_for` never shown or printed (ONLINE-ORDERS A5). Stuck-stage escalation is client-only. No feed-down alarm. KitchenHub stays on the tablet until CP6. | — |

---

## 4. Contract diff

All functions in SYNC-CONTRACT §2, plus register-device and the item 11 functions. "Device auth" = the item 0 middleware. Today **only `pos-v1-price-order` exists**, and it isn't part of the contract.

| Function | Exists? | Shape | Device auth | Idempotency | Error codes exact? |
|---|---|---|---|---|---|
| `pos-v1-register-device` | **No** | — | n/a (unauthenticated, IP-gated) | replay by `(lookup, nonce)` < 10 min | must be `400 enrollment_invalid`, `429 rate_limited` + `Retry-After` |
| `pos-v1-submit-order` | **No** | — | No | `(order_id, version)` + `content_hash` | must be `{error:{code,message,field}}`: 400 `invalid_payload` / `unknown_menu_item` / `unknown_topping` / `redemption_not_allowed` / `pricing_error:<code>` / `restaurant_mismatch` / `prefix_mismatch` / `card_data_rejected`; 409 `version_conflict` (+ `server_version`, `server_writer_device_id`) / `idempotency_key_reuse`; 401 / 403 auth; 426; 429 |
| `pos-v1-menu-snapshot` | **No** | — | No | content hash; If-None-Match | 400 `restaurant_mismatch`; auth codes |
| `pos-v1-staff-snapshot` | **No** | — | No | version + hash; If-None-Match | same |
| `pos-v1-submit-staff-events` | **No** | — | No | `(type,id,version)` | 400 / 403 identity; `card_data_rejected`; 409 reuse |
| `pos-v1-submit-shift` | **No** | — | No | `(type,id,version)`; lower = `stale_ignored` | 409 `shift_closed`, `idempotency_key_reuse` |
| `pos-v1-submit-refund` | **No** | — | No | `(type,id,1)` | 409 `unknown_payment` (retryable); 400 method mismatch |
| `pos-v1-submit-day-close` | **No** | — | No | `(type,id,1)` | 409 `day_close_sequence_taken`; 400 supplemental rule |
| `pos-v1-quote-delivery` | **No** | — | No | none (not queued) | 400 `address_not_found`, `restaurant_mismatch`, `invalid_payload` |
| `pos-v1-online-orders` | **No** | — | No | cursor (idempotent re-poll) | 400 `invalid_cursor` |
| `pos-v1-online-order-action` | **No** | — | No | `action_id` + `expected_status` CAS | 409 `status_conflict`; 400 `action_not_allowed`; 502 `uber_failed`; 400 `card_data_rejected` |
| `pos-v1-online-print` | **No** | — | No | `action_id`; CAS claim | (per B2) |
| `pos-v1-online-settings` | **No** | — | No | `action_id` + `expected_hash` | 409 `settings_conflict`; 400 `invalid_setting` |
| `pos-v1-price-order` (not contract) | Yes | camelCase `{apiVersion, pricingModuleHash, sourceCommit, breakdown, resolved}` | No (web; ignores device token ✔ per DEVICE-AUTH §4.5) | — | flat `{code,message}`, version → 400: **correct for the web, wrong for device functions** |

Shared infrastructure missing for all of them: canonical JSON + SHA-256 with the §7.1 test vector (`88812ec3c1667653a89a0a571233f91a594a1922449d03383952c359826f1a12`, 502 bytes); a `{error:{…}}` envelope; a 426 version gate; `verify_jwt=false` config entries.

**Reference handler inventory** (`test/support/fakeServer.ts` + `fakeDeviceAuth.ts`, pinned by `test/sync/deviceAuth.test.ts`):
- `invoke` `:179-229`: register path; unknown fn → 404 `unknown_function`; middleware; identity; dispatch.
- `doGetMenuSnapshot` `:392-401`: not_modified on hash match; no current snapshot → 400 `restaurant_mismatch`.
- `doSubmitOrder` / `handle` `:403-422`, `:865-951`, with checks in this order: hash → redemption keys (`provisional_pricing` excluded) → card guard → payment shape → idempotency → version rules → price (`PricingError` → `pricing_error:<code>`) → payments insert-only / captured → voided only → store → `stale_price` / `availability_flag` / delivery flags / `post_z` / actor flags.
- `response` `:953-983`: `diff` only for differing money fields; `pricing_module_hash`.
- `price` `:1010-1038`: pinned snapshot, else current + `unknown_snapshot`, none → 400.
- Delivery `quoteDelivery` `:728-772`, `deliveryPricing` `:779-857`.
- EOD `entity` `:537-566`, `applyShift` `:577+`, `verifyDrawer` `:609+`, `applyRefund` `:643-661`, `applyDayClose` `:664-678`, `postZ` `:711-717`.
- Staff snapshot / events (`:428+`).
- Auth: `register` `:223-284`, `authenticate` `:292-312`, `createEnrollment` `:105-139`, `revoke` `:150-158`.
- Test-only (not server behavior): `provision`, `breakToken`, fault injection, `autoProvision`.
- `src/dev/devAuthServer.ts` exists and is **not** a reference.
- **No online-orders handlers** in the FakeServer yet (ONLINE-ORDERS B5 = CP1).

---

## 5. LIVE VERIFICATION SQL (SELECT only — for Matt to run by hand in the SQL editor)

None of these return credential values. Don't add `select *` or `command` from `cron.job` (kh-backstop's command embeds a secret header).

**5.1 Column privileges on `restaurants` (W1, N2)**
```sql
select r.role, c.col,
       has_column_privilege(r.role, 'public.restaurants', c.col, 'SELECT') as can_select,
       has_column_privilege(r.role, 'public.restaurants', c.col, 'UPDATE') as can_update
from (values ('anon'),('authenticated')) r(role)
cross join (values ('uber_client_id'),('uber_client_secret'),('uber_webhook_signing_secret'),
                   ('uber_customer_id'),('stripe_account_id'),('tablet_email'),('tax_rate'),
                   ('uber_billing_mode'),('is_open')) c(col)
order by 1,2;

select grantee, privilege_type, count(*) as columns
from information_schema.column_privileges
where table_schema='public' and table_name='restaurants' and grantee in ('anon','authenticated')
group by 1,2 order by 1,2;

select grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('restaurants','orders') and grantee in ('anon','authenticated')
order by 1,2;
```

**5.2 RLS + policies (P5, N2, W1)**
```sql
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename in ('restaurants','orders','pending_orders','uber_quotes','uber_oauth_tokens');

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname='public' and tablename in ('restaurants','orders')
order by tablename, policyname;
-- expect from REPO: tablet_update_own_orders (qual = restaurant_id IN (...tablet_email...), with_check = NULL),
-- tablet_update_own_restaurant (with_check = NULL), anon_read_restaurants (roles {anon}, qual true)
```

**5.3 Backup / unknown tables (W2)**
```sql
select t.tablename, t.rowsecurity,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=t.tablename) as policies,
       has_table_privilege('anon', 'public.'||quote_ident(t.tablename), 'SELECT') as anon_select,
       has_table_privilege('authenticated', 'public.'||quote_ident(t.tablename), 'SELECT') as auth_select
from pg_tables t
where t.schemaname='public' and t.tablename not in (
 'restaurants','hours','menu_categories','menu_items','item_sizes','topping_groups','toppings','item_topping_groups',
 'orders','order_items','order_item_toppings','print_logs','promotions','adjustment_requests','pending_orders',
 'admin_users','delivery_zip_codes','sms_logs','scans','seo_pages','uber_oauth_tokens','uber_quotes',
 'uber_webhook_events','customer_identities','customer_sessions','restaurant_customers','customer_consents',
 'loyalty_transactions','restaurant_loyalty_tiers','loyalty_rewards','loyalty_redemptions',
 'external_orders','external_order_events','kitchenhub_stores','kitchenhub_tokens','dsp_provider_status',
 'pricing_shadow_log')
order by 1;

-- sensitive-looking column NAMES (no data) in those tables:
select table_name, column_name from information_schema.columns
where table_schema='public'
  and table_name ~* '(backup|bak|old|copy|tmp|temp|_20[0-9]{2})'
  and column_name ~* '(secret|token|key|password|email|phone|stripe|card|address)'
order by 1,2;
```

**5.4 Realtime publication (W7)**
```sql
select schemaname, tablename from pg_publication_tables where pubname='supabase_realtime' order by 2;
```

**5.5 pg_cron (W6)**
```sql
select extname, extversion from pg_extension where extname in ('pg_cron','pg_net');
select jobid, jobname, schedule, active from cron.job order by jobid;              -- no `command` column
select jobid, jobname, schedule, active from cron.job where command ilike '%check-failed-prints%';
```

**5.6 tax_rate distribution (W5)**
```sql
select tax_rate, count(*) as restaurants from restaurants group by 1 order by 1;
select count(*) filter (where tax_rate >= 1) as percent_typed_as_fraction,
       count(*) filter (where tax_rate < 0)  as negative,
       count(*) filter (where tax_rate = 0)  as zero
from restaurants;
```

**5.7 pos_* tables and the 086 / 099 / untracked columns (items 0, 1, 4)**
```sql
select tablename from pg_tables where schemaname='public' and tablename like 'pos\_%' order by 1;

select table_name, column_name, data_type, column_default
from information_schema.columns
where table_schema='public' and (table_name, column_name) in (
  ('menu_categories','availability'), ('menu_categories','discount_exempt'), ('restaurants','timezone'),
  ('restaurants','uber_extends_delivery'), ('restaurants','uber_max_radius_miles'), ('restaurants','website_links'),
  ('restaurants','delivery_fulfillment'), ('orders','ready_email_sent_at'), ('orders','quoted_for'),
  ('orders','pos_change_seq'), ('orders','pos_print_claimed_by'),
  ('restaurants','online_print_device_id'), ('restaurants','pos_online_orders_enabled'))
order by 1,2;

select timezone, count(*) from restaurants group by 1;

select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.restaurants'::regclass and conname ilike '%fulfillment%';
```

---

## 6. Test Pizza (slug `test`) verification plan, per Table A fix

Run each **after** its fix is deployed to Test Pizza only. Use Stripe test mode where the account allows it. No production restaurant is touched.

| Fix | Test on Test Pizza |
|---|---|
| G1 (P1 / N1 / P4 / P6 / W3 / W4-server) | 1) Normal pickup + in-house delivery checkouts still succeed; the charge equals the server total. 2) A crafted `create-payment-intent` with `amount` −$1, a tampered `delivery_fee`, or tampered `tax_amount` → 4xx, no PI. 3) Delivery with coords moved inside the radius but an address outside it → the server geocode wins (fee / tier from the address). 4) `is_open=false` (admin Pause) → 4xx for ASAP; a scheduled slot outside hours → 4xx. 5) `delivery_available=false` → a delivery request gets 4xx. 6) Malformed JSON / `amount:"abc"` / `amount:10` → 400, never 500. 7) The `pricing_shadow_log` row for each test order shows `compared` with zero diff. |
| G2 (P3) | Anonymous POST without the new proof → 401/403; normal checkout quote still works; burst of 20 → 429; no `uber_quotes` rows from rejected calls. |
| G3 (W1 / P5 / N2 / W2 / W7) | Re-run §5.1 / §5.2 → anon `can_select=false` on the 3 secret columns; customer menu `/test` and custom domain still load; tablet login, Settings save, printer save, Uber setup wizard still work; as the Test Pizza tablet, a direct REST `update` of `orders.total_amount` / `refund_status` and `restaurants.stripe_account_id` → permission denied; `acknowledged_at` / status / print writes still work. §5.4 shows the intended publication. Then G7: rotate Test Pizza Uber creds, clear `uber_oauth_tokens` for it, get a quote, run an Uber sandbox delivery + webhook. |
| G4 (P7) | Uber sandbox order on Test Pizza: partial refund → Stripe partial refund, **Uber delivery still active**, `refund_status='partial'`, cumulative amount; full refund → Uber cancelled first then refunded; `type:'partial'` with no amount → 400; missing `type` → 400. |
| G5 (W5) | Admin edit of Test Pizza shows a percent; save 6.625 → stored 0.06625; save 150 → rejected; the tablet shows the same value. |
| G6 (W6) | If scheduled: §5.5 shows the job; an unauthenticated call → 401; a Test Pizza order forced to `print_status='failed'` is retried ≤ 3 times. If retired: the function returns 410 or is removed, and the cron query is empty. |

---

## 7. Open questions / doc-vs-code conflicts (new only; 8a not re-raised)

1. **ONLINE-ORDERS.md vs today's direction.** The committed CP0 (`60947b7`) has `uber{…}` and `refund{status,amount_cents,reason}` on `OnlineOrderWire`, items with `base_price_cents`, **full-only** refunds (Q-M3), and no provider abstraction or OrderOut. Untracked ordr-pos `src/sync/onlineContract.ts` (D16/D17, "Matt 2026-11-23") has `delivery{provider,status,provider_status,…}`, `refund{status ∈ none|pending|partial|completed|failed, refunded_cents (cumulative), last_error}`, `line_total_cents`, and settings with `service_windows` / `delivery_providers` / `capabilities.partial_refund`. **Don't build item 11 until the doc is reconciled and committed.**
2. **Cumulative refunds.** `onlineContract.ts` expects cumulative `refunded_cents`; `admin-refund:222` overwrites `refund_amount` per refund, and `refund_status` has no `pending` value anywhere in the repo. A server change (or a refunds ledger) is needed: part of G4.
3. **Error envelope.** The SYNC-CONTRACT §3.3 body is `{error:{code,message,field}}` with a 426 version gate. The existing pos-v1 `ApiError.toBody()` is flat `{code,message}` with a 400 version error (`errors.ts:13,77-81`). Device functions need their own envelope. Item 9 says leave `pos-v1-price-order` as is.
4. **Snapshot `recoup_rate`.** SYNC §4 puts `restaurant.recoup_rate` in the hashed snapshot, while DEVICE-AUTH §4.3 says in-person recoup is 0 from the principal. The reference ignores the snapshot value for pricing (`fakeServer.ts:1030`). Should the snapshot carry the restaurant's real `recoup_rate` (informational) or `"0"`? It affects the hash, so both sides must agree.
5. **IP daily cap wording.** DEVICE-AUTH §5 says "a hard cap of 50 attempts per IP per day". The handoff and the reference count **failed** attempts only (`fakeDeviceAuth.ts:14-16,212-217`). Building to the reference (failed only).
6. **`restaurant.address` has no structured source.** SYNC §4 wants `street/city/state/zip/phone(E.164)`; `restaurants` has a free-text `address` (001:11) and `phone`. Parse at snapshot time (fragile, but hashed) or add columns + an admin edit?
7. **`delivery_fulfillment` CHECK.** `031:52-53` allows only `in_house | uber_direct`; code and SYNC §4 use `both` (ONLINE-ORDERS cites `mig/032:44-56`). Confirm live with §5.7.
8. **`business_day_cutoff`.** No column exists; the snapshot needs one (default `04:00`) or a constant. Decide before item 1 (it is hashed).
9. **`check-failed-prints` is PrintNode-era.** Scheduling it would retry Epson-printed orders through PrintNode. Recommend retiring it in favour of the item 11 print claim (W6 / G6).
10. **Tablet restaurant RLS (N2)** isn't in the handoff, but has the same shape as P5 and touches payouts (`stripe_account_id`). Add it to the priority list?
11. **The handoff's "no `WITH CHECK`" (P5) is precise but incomplete.** Postgres reuses `USING` as the check, so cross-restaurant moves are already blocked. The real gap is column scope (the P5 row).
12. **send-ready-email timezone.** It hard-codes America/New_York (`send-ready-email/index.ts:16-41`); `usePromotion.js:11` uses the UTC date. Both disagree with `restaurants.timezone` (099). They're harmless while all restaurants are in NJ. The server `accept` should use the restaurant timezone.
