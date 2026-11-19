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
11. **Test data in production:** Test Pizza has a 90% perpetual promo, and KH
    Testing Location has `tax_rate` 0. Both are expected for test restaurants;
    confirm neither is reachable by real customers.
