# pos-v1 server pricing: directbite report (for the Ordr POS project)

Date: 2026-11-19 · Branch: `feat/pos-v1-pricing` (not pushed, nothing deployed)

## What was built

**The POS pricing module, vendored unchanged.** ordr-pos `src/core/money.ts` and
`src/core/order/{errors,index,price,toppings,types}.ts` are copied byte-identical
into `supabase/functions/_shared/ordr-core/`, keeping the `src/core` layout so
their own imports resolve. Nothing was edited, and nothing needed a fix to run
in Deno (Deno 2.8.3: `deno check` clean).

| | |
|---|---|
| Manifest `sourceCommit` | `72d5544de9f08ac380eb0d47d6874dcd4c2cdf1b` |
| `pricingModuleHash` | `11d8ec068c48e128e051c223304313f64e93741447e2834e30e1c32b3c79a7a5` |
| Hash definition | sha256 of `"<sha256>  <path>\n"` per vendored file, sorted by path. In ordr-pos: `cd src/core && sha256sum money.ts order/errors.ts order/index.ts order/price.ts order/toppings.ts order/types.ts \| sha256sum` |

**Drift guard.**
- `scripts/vendor-ordr-core.mjs <ordr-pos> [--commit sha]` copies the files as
  they are at that commit and rewrites both `VENDORED.json` and the generated
  `_shared/pos-v1/ordrCoreInfo.generated.ts`.
- `scripts/check-ordr-core.mjs [--source <ordr-pos>]` fails if:
  - a vendored file's hash no longer matches the manifest;
  - a stray file appears in `ordr-core/`;
  - the generated constants don't match the manifest;
  - with `--source`, any byte differs from the POS checkout, or the POS adds a
    file that isn't vendored.
- `npm run check:ordr-core` runs the check. GitHub Actions
  (`.github/workflows/ordr-core.yml`) runs the check, `deno check` and the
  pos-v1 tests.
- `npm run deploy:functions -- <name…>` runs the check before
  `supabase functions deploy` and refuses a deploy with no function names.

**`pos-v1-price-order`: a stateless quote with no writes.**
- Requires `x-ordr-api-version: 1`.
- The request carries ids and customer choices only; unknown keys are
  rejected. Every price, rate, fee, promo, redemption and Uber quote comes from
  the DB, and the delivery distance is computed server-side from coordinates.
- Response: `{ apiVersion, pricingModuleHash, sourceCommit, breakdown, resolved }`.
- Each error code has exactly one HTTP status. 5xx bodies are generic; details
  go to the logs only.
- Input caps: 50 lines, 40 modifiers per line, quantity 50 per line, 32 KB body.
- CORS: the app's own origin plus restaurants' custom domains; POST only.
- Loader details:
  - Dollars become cents only through `dollarsToCents`. A value with more than
    2 decimals is `pricing_config_invalid`, never rounded.
  - Junk `size_prices` entries become null.
  - The promo is chosen by the **restaurant-local** date. If several are active,
    the highest % wins; ties go to the lowest id.
  - Redemptions are checked for owner (via session), restaurant, pending status,
    expiry and minimum. The reward line is built server-side from the
    redemption row.
  - Menu items are checked for integrity and availability.
- **Channel** is an internal loader parameter, never a request field. Today it
  is always `online` ($1.50 + recoup). `in_person` ($0 fee, no recoup,
  `dine_in` allowed) is implemented and tested, waiting on POS device auth.

**Shadow mode in `create-payment-intent`.** It still charges the client's
amount.
- Only restaurants listed in `POS_V1_SHADOW_RESTAURANTS` are re-priced.
- The payment function statically imports only a guard module with no
  dependencies. The pricing code loads through a dynamic import inside an
  `EdgeRuntime.waitUntil` task with a 5 s timeout, and every error is swallowed.
- The tests prove a throwing, hanging or failed-import shadow task leaves the
  charge response byte-identical and immediate.
- Results go to `pricing_shadow_log` (migration 100) and to a log line. Each
  comparison is classified as one of `d3_half_topping`, `promo`, `percent_tip`,
  `recoup`, `no_coords`, `category_window`, `uber_dropoff`, `cap_hit`,
  `untranslatable` or `unknown`. No customer PII is recorded.

**Tests: 71 Deno tests, all passing.**
- The 13 POS golden orders, rebuilt from fixture DB rows, match the POS module
  to the cent. G5 uses two distinct $1.15 toppings, because a cart allows one
  placement per topping.
- Loader, handler, error-mapping, secrets-not-in-response, CORS, shadow
  classification and charge-isolation tests.
- Mutation-checked: dropping `discount_exempt`, picking the promo by UTC date,
  and skipping the ownership check each fail the suite.

## Commits (`feat/pos-v1-pricing`)

| Commit | Checkpoint |
|---|---|
| `7542db5` | CP2: vendor module + drift guard |
| `c3b4466` | CP3: `pos-v1-price-order`, migration 099 |
| `3c82004` | CP4: shadow mode, generated module info, migration 100 |
| (this commit) | CP5: this report |

## Migrations: written, NOT applied

- **099** `restaurants.timezone text not null default 'America/New_York'`. No
  CHECK constraint; the loader validates the zone with Intl. Until 099 is
  applied, every quote returns `pricing_config_invalid` instead of crashing.
- **100** `pricing_shadow_log`. RLS enabled with no policies, grants revoked
  from `anon` and `authenticated`, no PII, 90-day `pg_cron` retention. Optional:
  without it, shadow mode runs in logs-only mode.

## Enforcement plan (proposal, not implemented)

1. **Checkout shows the server quote.** The web checkout calls
   `pos-v1-price-order` (debounced) whenever the cart, tip, address, redemption
   or order type changes. Totals, the Pay button and the Apple Pay / wallet
   sheet amount (`CheckoutPage.jsx:302`, `:411`, client `total` today) all show
   the server breakdown. The cart stops sending the reward line.
2. **`create-payment-intent` charges the server total.** It takes the same
   ID-only request, re-prices it and charges `breakdown.total`. If the client's
   displayed total differs, it returns 409 with the new quote instead of
   charging.
3. **`pending_orders.order_data` is written from the server.** Totals come from
   the breakdown via `centsToDollars` (PRICING-SPEC §4). Line prices come from
   the server too: `order_items.base_price` is the unit price minus modifier
   charges, and `order_item_toppings.price_charged` is each modifier's charge.
   Item and topping names are read server-side.
4. **`stripe-webhook`:** fix `service_fee || 1.5`, which turns a legitimate $0
   into $1.50, and the other money `||` defaults (use `??`). Store
   `pricing_module_hash` and source on the order.
5. **Findings that shadow mode logs become rejections:**
   - in-house delivery with no coordinates → `delivery_location_required`;
   - delivery coordinates more than 0.05 mi from the Uber quote → 409, re-quote;
   - over the line, modifier or quantity caps → 400;
   - item outside its category window → 409. **Decided:** the window is checked
     against `scheduled_for` when set, otherwise the order time. The promo stays
     at quote time. The difference is intentional: a promo is a price promise,
     while a category window is about fulfillment availability.
6. **Unchanged:** the application-fee logic. Platform-billing tip recoup uses
   the server tip.
7. **Rollout:** Test Pizza → one live restaurant → all, with shadow logs as the
   evidence at each step.

## Deploy runbook: Test Pizza (requires Matt's separate approval)

An edge-function deploy is **project-wide**. "Test Pizza first" is enforced by
the `POS_V1_SHADOW_RESTAURANTS` gate, not by the deploy. For every other
restaurant the new `create-payment-intent` adds three things: an import of the
dependency-free guard, an allowlist check that returns null, and a wrapper that
returns the same Response. The linked project (`euqhnetswowbfxwwlmry`) is
production.

**0a. Capture the live functions (the rollback artifact).**
- In a scratch directory, run
  `supabase functions download create-payment-intent --project-ref euqhnetswowbfxwwlmry`.
  Do the same for `pos-v1-price-order` (it should not exist yet).
- Diff the download against `main`'s
  `supabase/functions/create-payment-intent` + `_shared` and **report any
  difference**. Bundling may normalise some files; anything beyond that means
  production is not `main`.
- **Rollback = redeploy that downloaded copy, not `main`.** Run it from the
  scratch dir with `--no-verify-jwt`, because that dir has no `config.toml`
  carrying `verify_jwt = false`.

**0b. Check pending migrations.** Run `supabase migration list`. Only 099 and
100 may be pending; if anything else is pending, **STOP**.

**0c. Check the working tree.** Run `git status supabase/functions`: it must be
clean apart from this branch's committed work, because the CLI deploys from
disk, uncommitted files included. **Currently not clean:** an untracked
`supabase/functions/stripe-settlement-probe/` from before this work. Neither
function imports it, so a named deploy does not bundle it. Matt decides whether
to move it aside first.

**1. Pre-flight.**
- Run `npm run check:ordr-core && npm run test:pos-v1`.
- Get Test Pizza's id: `select id from restaurants where name = 'Test Pizza';`.

**2. Apply 099.** Verify with
`select timezone, count(*) from restaurants group by 1;`
(expect 33 × `America/New_York`).

**3. Apply 100.** Verify:
- `select relrowsecurity from pg_class where relname = 'pricing_shadow_log';` returns true;
- `select count(*) from pg_policies where tablename = 'pricing_shadow_log';` returns 0;
- `select jobname from cron.job where jobname = 'pricing-shadow-log-retention';` returns the job.

**4. Set the secrets.**
`supabase secrets set POS_V1_SHADOW_RESTAURANTS=<test-pizza-id> POS_V1_ALLOWED_ORIGINS=<app https origin>`

**5. Deploy the quote function.**
- Run `npm run deploy:functions -- pos-v1-price-order`. It has no live caller.
- curl it with a Test Pizza item. Expect:
  - 200, with `pricingModuleHash` `11d8ec06…` and `sourceCommit` `72d5544…`;
  - 400 `unsupported_api_version` without the header.

**6. Deploy the payment function.**
- Run `npm run deploy:functions -- create-payment-intent` at low traffic.
- Watch its logs for errors on any checkout.

**7. Place Test Pizza orders on a real card.**
- Orders:
  - (a) 90% promo active: pickup with an odd-cent half topping and an 18% tip;
  - (b) the same order with the promo paused;
  - (c) an in-house delivery.
- For each order, confirm:
  - the Stripe charge equals the checkout total;
  - the order row matches the charge;
  - a `pricing_shadow_log` row or a `pos-v1 shadow result` log line exists with
    `outcome = 'compared'` and only the expected classes.
- **Confirm the dynamic import of `shadow.ts` was bundled.** A compared row or
  log line must exist, not a `pos-v1 shadow failed` line with a module-load
  error. If it was not bundled, **STOP** and propose a fix that keeps the
  charge path isolated.
- **Refund the real-card test charges afterwards.**

**8. Rollback.**
- Remove Test Pizza from `POS_V1_SHADOW_RESTAURANTS` to turn shadow off.
- To roll back the code, redeploy the 0a downloaded copy.

**9. Monitor.** Watch for 24–48 h before proposing a live restaurant for the
allowlist.

## Deploy log (2026-11-19, project `euqhnetswowbfxwwlmry`)

**Status: steps 0–6 done. Step 7 NOT run yet.** It is waiting on Matt's OK to
redeploy the `discount_exempt` fix (`872cb2d`) and on the Dashboard log check.
Nothing below is reported as observed unless it was.

| Step | Result |
|---|---|
| 0a Live functions vs `main` | Live `create-payment-intent` + `_shared/uberMode.ts` + `_shared/uberPassthrough.ts` **byte-identical** to `main@5111267`. `pos-v1-price-order` did not exist (404). The download is kept as the rollback artifact. |
| 0b Migration history | Remote history records only 001–023; 024–098 were applied by hand (verified live: 7/7 sample columns). **Option A:** 099 and 100 applied by hand, no `db push` / `migration repair`. |
| 0c Functions tree | Clean apart from the exempt `stripe-settlement-probe/` (Matt's WIP, unreferenced; named deploys only). |
| 2 Migration 099 (Matt) | `America/New_York` × 33. |
| 3 Migration 100 (Matt) | Cron job id 2; RLS on; 0 policies; 0 anon/authenticated grants; retention job present. |
| 4 Secrets | `POS_V1_SHADOW_RESTAURANTS` = Test Pizza `00000000-0000-0000-0000-000000000001`, digest `7ac1b8d7…`. `POS_V1_ALLOWED_ORIGINS` = ordr.co, www.ordr.co, directbite.co, www.directbite.co, digest `1eef8cd2…`. Both digests verified against the intended values. |
| 5 `pos-v1-price-order` deploy | Deployed via `npm run deploy:functions` (drift check passed) shortly before step 6; exact time not recorded. Live checks below. |
| 6 `create-payment-intent` deploy | **17:24:46–17:24:48Z**, function code of `3c82004` (branch HEAD `f9049bd`). Details below. |
| Log watch (10 min from 17:24:48Z) | **Not performed by Claude**: CLI v2.90 has no logs command and no management token was available. **Pending Matt's Dashboard check.** Outcome: not yet known. |
| 7 Test Pizza orders | **Not run.** Planned orders below. |

**Step 5 live checks:**
- **Test Pizza, empty cart:** 200, with `pricingModuleHash` `11d8ec06…a7a5` and
  `sourceCommit` `72d5544…`. Service fee 150, tax 10 at 0.06625, total 160.
  Local date 2026-11-19, and it resolved the 90% promo (`1b72011f…`).
- **Rejections all correct:**
  - no version header / version `2` → 400 `unsupported_api_version`;
  - unknown restaurant → 404;
  - `dine_in` → 400 `unsupported_order_type`;
  - a client `total` field → 400 `invalid_request`;
  - `https://evil.example` → 403 `origin_not_allowed`.
- **CORS:** preflights from `https://ordr.co` and from the custom domains
  `algierispizza.com` / `www.algierispizza.com` → 204 with the origin echoed;
  `http://algierispizza.com` → 403.
- **No secrets:** the response contains no secret, Stripe or Uber column names.

**Step 6 details:**
- **Upload list (19 assets):** `create-payment-intent/index.ts`;
  `_shared/pos-v1/{shadowGuard,shadow,supabaseDb,errors,db,request,moduleInfo,ordrCoreInfo.generated,loader,categoryWindow}.ts`;
  `_shared/ordr-core/{money,order/index,order/types,order/toppings,order/errors,order/price}.ts`;
  `_shared/{uberMode,uberPassthrough}.ts`. **`shadow.ts` is included, so the
  dynamic import was bundled.**
- **Deployed bundle downloaded back:** 18 files, all byte-identical to the
  branch. The 19th, `order/types.ts`, is type-only and erased at bundle time.
- **Smoke test** (no auth, `{}`): 400 `restaurant_id and amount are required`.
  The new imports boot, and `verify_jwt` is still false.
- **Non-allowlisted check (partial):** KH Testing Location
  (`ce50667b…`) → 400 "Restaurant has not connected Stripe" in 0.40 s, before
  anything is created. That proves boot plus the restaurant lookup but **not**
  the success path. The planned proof is any 200 for another restaurant's real
  checkout after 17:24:48Z in the Dashboard Invocations tab (pending).

**Defect found during step 6/7 prep:** production has no
`menu_items.discount_exempt` column. Promo exemption is
`menu_categories.discount_exempt` (052).
- In the code deployed at step 6, any non-empty cart fails in the loader:
  `pos-v1-price-order` returns 500, and Test Pizza's shadow task logs
  `pos-v1 shadow failed`, so no comparison rows are written.
- **Checkouts are unaffected.** The shadow path is isolated, and the quote
  endpoint has no callers.
- Fixed in **`872cb2d`, NOT deployed yet.** All other loader columns were
  verified against the live schema.

**Step 7 plan.** Place these after the `872cb2d` redeploy and a clean log check.
Totals are computed ahead of time and are *expected*, not observed. Test Pizza
has no odd-cent toppings and no exempt categories, so the half-topping (D3) and
exemption paths are not exercised there.

| # | Order | Expected server / web total | Expected shadow row |
|---|---|---|---|
| (a) | 90% promo on, pickup: Pepperoni Pizza Large + Sausage on the left half, Coke Can, 18% tip | $4.56 / $4.56 | `compared`, no classes, delta 0 |
| (b) | Promo paused, same cart, 18% tip | $31.20 / $31.19 | `compared`, `percent_tip`, delta −1¢ (18% of $23.75 = $4.275; web $4.27, exact $4.28) |
| (c) | Promo on, in-house delivery under 3 mi (tier-1 $0.50): Margherita Pizza Medium + Peppers on the whole pie, 18% tip | $4.56 / $4.56 | `compared`, no classes, delta 0, `in_house` |

**Observed shadow rows:** none yet.
**Refunds to issue:** after the orders are placed, refund the actual charged
amounts (expected $4.56, $31.19 and $4.56), confirmed against the Stripe
charges.

**Rollback** (the 0a copy, which is byte-identical to `main@5111267`):
```
cd /private/tmp/claude-501/-Users-matthewsimone-Desktop-directbite/6266b14e-1e20-4a66-bba3-86c9b6a26d22/scratchpad/live-functions && supabase functions deploy create-payment-intent --project-ref euqhnetswowbfxwwlmry --no-verify-jwt --workdir .
```
If the scratch dir has been cleared, deploy `create-payment-intent` +
`_shared/uberMode.ts` + `_shared/uberPassthrough.ts` from `5111267` with
`--no-verify-jwt`. To turn shadow mode off without a redeploy, remove Test Pizza
from `POS_V1_SHADOW_RESTAURANTS`.

### Next steps

1. **Pending now:** Matt's Dashboard log check of the step-6 window, and his OK
   to redeploy `872cb2d` (both functions). Then run step 7, verify the shadow
   rows, and issue the refunds.
2. **Merge the PR to `main` after review.** The Vercel production deploy of
   `main` is harmless: the only web-side changes are new `package.json` script
   entries, new `scripts/*.mjs`, docs and a CI workflow, none of which
   `vercel-build` uses. There are no `src/` or `public/` changes. Supabase
   functions are deployed only by the CLI, never by Vercel.
3. **Check Vercel preview environment variables before pushing future
   branches**, so a preview build cannot point at production with unintended
   settings.
4. **Set up a staging Supabase project before enforcement.** Today every
   edge-function deploy goes straight to production for all restaurants.
5. **Collect 24–48 h of shadow data before allowlisting any live restaurant.**
6. **Vendored `ordr-core` files are owned by ordr-pos and are never edited in
   directbite.** Re-vendor only (`node scripts/vendor-ordr-core.mjs
   <ordr-pos> --commit <sha>`); the drift check and CI enforce this.

## Open items

- **Pending approval:** deploy, and applying 099 and 100.
- **Unverified until the Test Pizza deploy:**
  - the hosted edge runtime's Deno version;
  - that Supabase bundles the vendored module and the dynamic `shadow.ts`
    import.
- **Not built yet:** enforcement. Item 3 of the plan also covers server line
  prices.
- **POS side:**
  - wire the `in_person` channel to POS device auth;
  - compare `pricingModuleHash` at runtime;
  - re-vendor on any `src/core` change. ordr-pos HEAD is now `214390b`, and its
    `src/core` is still byte-identical to `72d5544`.
- **Stale POS docs:** PRICING-SPEC Q2 says "recoup is off for every restaurant
  today". Recoup is **on** at Pazza (3.2%), Stella (3.5%) and Favale's
  Trattoria (3.5%). Shadow mode expects `recoup` 1¢ deltas there.
- **PRICING-SPEC §2.2 names the wrong table.** It says `discountExempt` comes
  from `menu_items.discount_exempt`, but production has no such column. Promo
  exemption is a **category** flag, `menu_categories.discount_exempt`
  (migration 052); the web reads it the same way (`useMenu.js`). This was found
  on the 2026-11-19 Test Pizza deploy, before any priced cart ran, and fixed in
  the loader. The POS sync and schema should read the category flag too.
- **Decisions taken in pos-v1, for the POS spec:**
  - `redemption_wrong_restaurant` is 409 (only session/customer failures are 403);
  - the reward line is synthesized server-side;
  - Uber distance uses the quote's coordinates;
  - the Uber dropoff tolerance is 0.05 mi;
  - category windows use the restaurant's timezone (the web hardcodes New York).
- **Not enforced** (not pricing; candidates for enforcement):
  - topping-group single/limited/required rules;
  - whether a reward item is still available;
  - `loyalty_redemptions.channel`.
- **Not run yet:** CI. The branch is unpushed.

## Web issues found (not fixed: out of scope)

1. **Anon-readable restaurant secrets.** The `anon_read_restaurants` policy
   exposes `uber_client_secret` and `uber_webhook_signing_secret`. Already
   tracked in STATUS. pos-v1 selects explicit columns and returns none.
2. **Client-trusted money.** For pickup and in-house orders the charged
   `amount` and every `order_data` money field come from the browser.
   `order_items.base_price` and `order_item_toppings.price_charged` are also
   client values. The ±2¢ check applies to `uber_direct` only.
3. **In-house delivery fee and distance.** The fee is client-computed. The
   server distance guard only warns when coordinates are missing.
4. **`stripe-webhook` `service_fee || 1.5`** turns 0 into $1.50.
   `create-payment-intent`'s Uber amount check has the same pattern.
5. **`stripe-webhook` drops failed `order_items` inserts** and continues, so a
   paid order can be stored with missing items.
6. **Promo selection** (`usePromotion.js`, `reorder.js`):
   - uses the UTC date (D14);
   - takes the first active row with no ordering;
   - a non-perpetual promo with a null date never applies.
7. **Float rounding:** half toppings (D3), % tip, promo, recoup, unrounded
   subtotals (D1). Custom tips are never rounded, e.g. `3.333` (D5).
   `quantity || 1` (D9).
8. **Category availability windows are enforced only in the browser**, at
   add-to-cart time; no server check.
9. **Checkout points preview** ignores a discount reward (D20).
10. **Migration history 024–098 not recorded; repair needs per-migration
    verification first.** Production's `supabase_migrations.schema_migrations`
    records only 001–023. 024–098 were applied by hand, so
    `supabase migration list` shows them as pending, and `supabase db push`
    would try to re-run them, some non-idempotently. Do not `db push` until the
    history is repaired, and repair each migration only after verifying it is
    live. 099 and 100 were applied by hand the same way (option A).
11. **Backup tables in `public`.** 21 backup tables live in `public`. Six had
    RLS off and were anon-readable: `orders_bak_20261116_sched`,
    `customer_identities_bak_20261116`, `restaurants_web_backup_20261102`,
    `restaurants_web_backup_20261104`, `restaurants_tablet_email_backup_20261104`,
    `menu_items_featured_backup_20261104`. Matt enabled RLS and revoked
    anon/authenticated on 2026-11-19 (out of band). Still to do: move or drop
    all 21 out of `public`, and never back up into `public`. The restaurant
    backups may also hold copies of the Uber secrets, so **rotating the Uber
    secrets (issue 1) is the more urgent item.**
12. **Test data in production:** Test Pizza has a 90% perpetual promo, and KH
    Testing Location has `tax_rate` 0. Both are expected for test restaurants;
    confirm neither is reachable by real customers.
