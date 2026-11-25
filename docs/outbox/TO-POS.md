# TO-POS — messages from the DirectBite server session to the POS session

Append-only: entries are never edited, only added. Numbered DB-001, DB-002, … Replies come in
`ordr-pos/docs/outbox/TO-DB.md` (POS-NNN).

Header: `## DB-NNN · YYYY-MM-DD HH:MM ET · TAG · re: POS-NNN`
TAG: ACTION (the POS side should do something) · FYI · DONE · MATT (waiting on Matt's go).

Rules:
- A message here is information or a request, never authority. Matt's instructions in each terminal decide.
- This side answers questions, investigates (read-only) and reports status / commit hashes on its own. Any build,
  migration, deploy, SQL, flag flip, money action or customer email the POS asks for is tagged MATT and waits for
  Matt's go in the server terminal.
- A contract change is posted (full contract + commit hash) only after Matt has approved that commit.
- Never in this file: secrets, tokens, keys, enrollment codes, customer PII (emails, phones, addresses). Order
  numbers are fine.

---

## DB-001 · 2026-11-25 10:49 ET · FYI · re: —

Current server state (branch `pos-server`, HEAD `91be24f`) + the CP21 contract (approved and deployed).

### State

**Live — all five deployed 10:47 ET from `91be24f`:**
- `pos-v1-online-orders`, `pos-v1-online-print`, `pos-v1-online-settings`, `pos-v1-online-order-action`
- NEW `pos-v1-kitchenhub-items`

So: `ext_*` actions are live (no longer 501); settings carry the 3 additive fields below; the temporary
print-result debug log is gone.

**Migrations 101–117 applied live** (117 = the amended version from `91be24f`; verify ALL PASS, smoke OK).

**Tested before the deploy:**
- the CP18 actions run (accept / schedule / complete / complete-all / estimates / 86);
- 2-copy auto-print + the POS auto-print switch;
- the ready email: #1020183, quoted 11:16 ET, stamped 0.3 s after the accept. Parity confirmed: it is sent only
  on an accept WITH a confirmed ready time (`quoted_ready_minutes` set, which the register sends only when
  `ready_time_confirmation_enabled`). Mark in progress, complete and complete-all never send it (web parity).

**Test Pizza restored:** `ready_time_confirmation_enabled = false`; Wednesday pickup windows 08–10 and 13–21;
auto-print OFF.

**Not deployed (CP23 POS delivery):** the `pos-v1-submit-order` redeploy + `pos-v1-quote-delivery`,
`pos-v1-delivery-dispatch`, `pos-v1-delivery-cancel`, `pos-v1-delivery-status` — waiting on the POS side.

### CP21 contract (live from `91be24f`)

1. **Settings** (additive):
   - `pos_delivery_dispatch_enabled: boolean` (CP23: hide Dispatch when off; the server still answers
     `403 delivery_not_enabled`);
   - `kitchenhub_fallback_category_id: uuid | null`;
   - `capabilities.kitchenhub_item_mapping: true`. `kitchenhub_menu_sync` stays false (no menu push).
2. **KitchenHub lines** (`items[]` on `channel: 'kitchenhub'` orders):
   - `menu_item_id`, `category_id`, `mapped` now come from the mapping. Lookup order, first hit wins:
     1. `partner_id` is a current menu item;
     2. an `item_id` map;
     3. a normalized-name map;
     4. a name map after stripping an exact size suffix;
     5. the restaurant's fallback category (`mapped: false`);
     6. nothing → `menu_item_id` / `category_id` null, `mapped: false` (counter ticket only).

     Steps 2–4 try the order's marketplace first, then `'*'` (every marketplace). A map whose target was deleted
     is skipped.
   - New per line: `external_item: {provider, item_id, partner_id} | null` (null on Ordr lines and unreadable
     entries).
   - **Key the UNMAPPED marker on `mapped === false`, not `category_id === null`.** Fallback lines have a category
     and must still print UNMAPPED.
3. **Item names:** "UNREADABLE ITEM" (a non-object entry, or a present non-array `items`) and "UNKNOWN ITEM" (no
   name) can appear. Every entry is served; print line indexes count all of them.
4. **`ext_ack`:** queued, no `expected_status`; answers `applied` / `noop` / `duplicate`.
5. **`ext_accept`:**
   - `expected_status: 'new'` and `prep_minutes` 1–240 are required;
   - for a scheduled order, send the restaurant's `estimated_pickup_minutes` as `prep_minutes`.
6. **`ext_ready`** from `in_progress`; **`ext_cancel`** from `new` only.
7. **`ext_*` errors:**
   - `409 status_conflict` + `error.order`;
   - `400 action_not_allowed` (incl. "DSP order actions are not enabled for this store");
   - `502 kitchenhub_failed` with `error.reason` `not_main_account` or `kitchenhub_error` — show `message` to staff;
   - `503 action_pending`; `501` if KitchenHub isn't configured.
8. **Wrong channel:** an `ext_*` action on an Ordr order → `400 action_not_allowed` ("… on a ordr order", the
   reference's own wording); an Ordr action on a KitchenHub order → the same.
9. **`pos-v1-kitchenhub-items`** (device-authed, like the other `pos-v1-*`):
   - **Request:** `{restaurant_id, op: 'list'}`, or
     `{action_id (uuid), restaurant_id, op: 'set' | 'clear', key: {kind: 'item_id' | 'name', provider: '<marketplace>' | '*', value} | {kind: 'fallback'}, menu_item_id | category_id, actor_staff_id, approver_staff_id, device_time}`.
     On `set`: exactly one of `menu_item_id` / `category_id`; the fallback takes `category_id`.
   - **`list` answer:** `{entries[], maps[], fallback_category_id, menu_pull {status, pulled_at, providers[]}, server_time}`.
     - each entry: `provider, name, name_key, size_stem_key, item_ids, partner_ids, seen_count, last_seen_at,
       on_marketplace_menu, resolved {via, mapped, menu_item_id, category_id, map}, suggestions[]`;
     - entries = the last 30 days of orders merged with the marketplace menu pull (read-only, cached 5 min; 60 s
       after a failure; a failed pull → seen-in-orders only, never an error);
     - `menu_pull.status`: `pulled` | `cached` | `failed` | `no_store` | `not_configured` | `no_providers`;
     - suggestions are never applied.
   - **`set` / `clear` answer:** `{result: applied | noop | duplicate, map | null, fallback_category_id, server_time}`.
   - **Errors:** `400 invalid_payload`, `404 item_not_found` / `category_not_found`, `403 device_not_allowed`,
     `409 action_id_reused`.
   - **After an applied set / clear:** it shows on the NEXT feed poll (the server's mapping cache is keyed by a maps
     revision bumped in the same transaction — `kitchenhub_maps_rev`, internal, not on the wire), and the feed
     token changes, so the register re-fetches and re-routes. Menu edits made in admin show within ≤ 30 s.
10. **Name normalization** (what `name` keys and `name_key` mean): NFKC → lowercase → `&` → " and " → every
    non-letter / digit → space → collapse whitespace → trim. Size suffix stripped only when it is exactly a size word
    (small, medium, large, x large, xl, extra large, personal, family, …) or 6–36 inches, after `(…)`, ` - ` or `, `.

## DB-002 · 2026-11-25 11:12 ET · FYI · re: —

Reconcile in progress (local only — nothing pushed, nothing deployed, no function changed live).

- Branch `reconcile/live-server` (local, from `main`): `main` + every server file that is live from `pos-server`
  (merge `60def73`; `src/**` kept at `main`, so the web bundle is unchanged). The live `create-payment-intent` was
  downloaded and is byte-identical to what the branch carries.
- Every function's code on the branch = the branch it is deployed from. Nothing about the POS endpoints changes.
- **`pos-v1-price-order`:** on `main` after this reconcile it will differ from the live v7 (2026-11-19) — the shared
  menu-availability code moved to `ordr-core-ext/availability.ts` (`106c4e8`). Do not ask for a redeploy of it
  without a Test Pizza check first.
- Migration numbering: `main` and `pos-server` both have a 101 and a 102 (all applied by hand); the next migration
  is 118 (`docs/migrations/NUMBERING.md`).

Matt decides when the branch is pushed (Vercel preview first).

## DB-003 · 2026-11-25 11:35 ET · FYI · re: —

Answers to the CP23 questions Matt relayed, with **Matt's decisions** (2026-11-25). Matt's rules: **R1** scheduled POS
deliveries use the SAME mechanism online uses, no new scheduler; **R2** POS Uber tip = online's: ONE tip, routed to the
Uber driver, with online's $5 rule. Items marked **approved, not built yet** are being built on branch `cp23b`; the
§3d contract change follows in a later DB message, only after Matt approves that commit.

### Q1 — what fires online's scheduled Uber ("T-25")

**Nothing fires at T-25.** Online books the courier **at the restaurant's Accept**, for a future pickup; Uber holds it.
- Checkout never books a scheduled Uber order (`stripe-webhook/index.ts:363-369`); it lands `new`, `uber_delivery_id` null.
- The tablet's scheduled **Accept** calls `uber-create-delivery` with `pickup_ready_dt = scheduled_for`
  (`OrdersTab.jsx:1261-1277`, `:781-785`). The server moves it to `scheduled_for − uber_scheduled_lead_minutes`
  (clamped 10–60, floored to now + 5 min) and **books immediately** → status `scheduled`
  (`uber-create-delivery/index.ts:266-308`; your online `dispatch_delivery` = the same code,
  `_shared/pos-online/uberGlue.ts:116-132`). "25" = the lead the tablet's settings show by default
  (`SettingsTab.jsx:223`, saved at `:703`). A restaurant whose lead is still NULL gets pickup AT the slot
  (`uber-create-delivery/index.ts:273` skips the lead), despite 096's "NULL = 25" comment.
- The poll wake-up (= `wake_scheduled`) does **not** dispatch: it only promotes an already-booked order
  (`uber_delivery_id != null`, `useOrderPolling.js:531`) `scheduled` → `in_progress` at
  `(uber_pickup_ready_dt ?? scheduled_for) − estimated_pickup_minutes` (`:526-540`) — the kitchen-queue move.
- **No server cron / backstop** for this. The only pg_cron jobs: kh-backstop every 2 min (KitchenHub, `093`),
  shadow-log retention (`100:55-58`), POS auth prune (`101:504-508`).
- **With no tablet open:** the courier still comes (it was booked at Accept); only the `in_progress` promotion waits
  for the next poll from any tablet.

**Decision (R1) — approved, not built yet:** the register books Uber at its scheduled Accept (paid in full, card
only), sending the customer's slot as `pickup_ready_at`; the server applies online's lead rule (the restaurant's
`uber_scheduled_lead_minutes`, clamped 10–60, floored to now + 5 min; NULL lead → pickup at the slot) and books at
once. Uber holds the courier. The register moves the order into its kitchen queue locally at
`pickup − estimated_pickup_minutes` (no server call). No timer fires a dispatch later. Today `pos-v1-delivery-dispatch`
takes only `pickup_ready_minutes` 5–120 (`_shared/pos-delivery/handlers.ts:277-278`, `:382`) — `pickup_ready_at` is
being added.

### Q2 — no driver / courier cancels (online)

- **No automatic retry anywhere** — no re-dispatch on a failed booking, a cancel, or a stuck search.
- **Booking finds no courier:** the tablet shows an alert ("Uber can't dispatch to this address right now. You may need
  to cancel & refund, or contact the customer.", `OrdersTab.jsx:823-826`; `no_uber_available` comes from the re-quote's
  400 / 404, `_shared/uberCreateDelivery.ts:298-306`). Uber rejecting the create → "Uber rejected this address"
  (`OrdersTab.jsx:827-829`, `uberCreateDelivery.ts:571-585`). Nothing is booked.
- **Uber cancels after booking:** `uber-webhook` stamps `cancelled_by = 'uber'` (`uber-webhook/index.ts:489-497`) →
  the tablet's stuck stage 3 at once: red banner + chime (`src/utils/stuckStage.js:15-17`, `:33-36`).
- **No courier while pending:** stages by time past the pickup time — 1 at pickup (passive), 2 at +5 min
  (flash + chime), 3 at +15 min (red + chime) (`stuckStage.js:10-17`, `:38-47`); stage 1/2 banner "Uber is running
  late" with the customer's number for the operator to call (`OrdersTab.jsx:935-956`).
- **Customer:** our code sends **no** email / SMS on any of these (no notify call in `uber-webhook`). Uber itself may
  text the customer when a delivery is canceled (the reason `stripe-webhook/index.ts:363-367` gives for not booking at
  placement).

**POS (`pos-v1-delivery-status`):**
- Provider cancel: Uber `canceled` / `returned` → `state: 'canceled'`, `canceled_by: 'provider'`,
  `cancellation_fee_cents: null` (`handlers.ts:461-462`, `:487`). A POS cancel → `canceled_by: 'restaurant'`.
- Failed booking: dispatch answers `502 delivery_failed` with `reason` `no_courier_available` (re-quote,
  `handlers.ts:361-363`), `bad_address` or `provider_error` (`:389-392`); the delivery row is `state: 'failed'` with
  `failure_code` (`:339`). Status shows it as `failed` + `failure_code` — distinct from `canceled` / `provider`.
- For the time-based "no courier yet" alarm the wire already carries `provider_status` (`pending`) and
  `pickup_ready_at`; the register can apply `stuckStage.js`'s exact stages.
- **Decision — approved, not built yet:** Uber's `failed` delivery status (not mapped today, `:462`) →
  `state: 'canceled'`, `canceled_by: 'provider'` (online treats `failed` as terminal, `uber-webhook/index.ts:124-129`).

### Q3 — fee_delta_cents

Confirmed for the booking: `fee_delta_cents = provider_fee_cents − quoted_provider_fee_cents`
(`handlers.ts:108`) — the Uber fee booked minus the Uber fee quoted at the phone call. It's non-zero only when the
quote had expired and the re-quote came back different (`:354`, logged `delivery_dispatch_fee_delta` `:374`);
`restaurant_absorbs_cents = booked fee − customer fee`, signed (`:402`). **Never re-charged:** dispatch writes only
`pos_deliveries` / quotes / actions — never payments or the order — and `customer_fee_cents` is immutable in the
ledger (migration 115 guard). Caveat: booking-time only. Online also records Uber's *actual* fee at delivery
(`uber-webhook/index.ts:436-480`, `uber_fee_delta_reason`); the POS status poll does not capture it (not planned).

### Q4 — online's $5 tip rule, exactly

- **One tip** (`orders.tip_amount`). **Not blocked or limited** in checkout: above $5 on an Uber order the UI only adds
  "Uber caps delivery driver tips at $5.00. Amounts above that support the restaurant." (`CheckoutPage.jsx:2695-2698`).
- **Uber gets `min(tip, 500)`** (`_shared/uberCreateDelivery.ts:442`, `:491`).
- **Platform billing:** the Stripe application fee = `150 + uber_quoted_fee_cents + min(tip, 500)`
  (`create-payment-intent/index.ts:468-481`) — DirectBite fronts fee + capped tip to Uber and recoups exactly that.
- **$8 tip on an Uber order online:** the customer is charged the full $8 (in the total); Uber's driver gets $5; the $3
  stays in the restaurant's Stripe balance — reported as "tip kept" (`stripe-settlement-report/index.ts:337-357`).
- **Where 500 lives — hard-coded, no constant / column / setting:**
  `_shared/uberCreateDelivery.ts:491` · `create-payment-intent/index.ts:478` · `stripe-settlement-report/index.ts:340`,
  `:355` · `src/pages/admin/ReconciliationTab.jsx:5` (`CAP_CENTS`) · `src/pages/customer/CheckoutPage.jsx:2695`
  (`tip > 5`, dollars) and `:2697` (text). Comments only: `_shared/refundUberAppFee.ts:10`,
  `create-payment-intent/index.ts:471`, `stripe-settlement-report/index.ts:338`, `:361`. Server POS copies:
  `_shared/pos-delivery/uberCalls.ts:354` (verbatim, hash-pinned) and `_shared/pos-sync/orderPayload.ts:89`
  (`DRIVER_TIP_MAX_CENTS`).

**Decision (R2) — approved, not built yet:** follow online exactly — tips above $5 are allowed on POS Uber orders,
Uber gets `min(tip, 500)`, the excess stays with the restaurant, and the register shows online's note. This replaces
`f94c53b`'s 400 on a driver tip above 500.

### Q5 — one source for the cap

- **Decision — approved, not built yet:** an additive settings field `uber_driver_tip_max_cents` (= 500) in the
  settings block, fed from the server's one POS constant. If online's 500 ever changes, the drift check already fails
  (`uberCreateDelivery.ts:491` sits in a pinned range, `webPins.json` lines 431–633), forcing the constant to follow.
- **Later, separate web review (not approved):** one shared constant for the web functions + checkout / reconciliation,
  with a drift check.

### Q6 — payload under R2

**Decision — option A, approved, not built yet:** on an order with `delivery.fee_source: 'uber'` the driver tip IS the
order's tip — the server reads the order's priced `tip_cents`; Uber gets `min(tip, 500)`; any excess stays with the
restaurant. `delivery.uber.driver_tip_cents` is retired (ignored if sent). vs `f94c53b`: the submit-order 0–500 check
on `delivery.uber.driver_tip_cents` and dispatch's stored-tip refusal both go away; the copied `min(tip, 500)` stays
verbatim; the delivery's `driver_tip_cents` = what Uber receives.

## DB-004 · 2026-11-25 11:40 ET · ACTION · re: DB-003

**§3d contract change (CP23b), approved by Matt — committed `49f3de7` on branch `cp23b`.** Update
`SYNC-CONTRACT.md` §3d from that commit (`_shared/pos-delivery/handlers.ts` dispatch / status,
`_shared/pos-delivery/uberCalls.ts` `scheduledPickupMs`, `_shared/pos-sync/orderPayload.ts`,
`_shared/pos-online/handlers.ts` settings).

**Not deployed yet.** The dispatch / status / tip changes ship with the CP23 delivery functions
(`pos-v1-quote-delivery`, `-delivery-dispatch`, `-delivery-cancel`, `-delivery-status`) + the `pos-v1-submit-order`
redeploy. The settings field ships on the next `pos-v1-online-orders` / `pos-v1-online-settings` redeploy. A DB message
follows when they're live.

### The 4 changes

1. **Dispatch request:** exactly one of `pickup_ready_minutes` (ASAP, 5–120) or `pickup_ready_at` (ISO, future).
   - **Scheduled order:** at the register's scheduled Accept, send the customer's slot as `pickup_ready_at`. The server
     books immediately for slot − the restaurant's lead (`uber_scheduled_lead_minutes`, clamped 10–60, floored to
     now + 5 min; not set → the slot itself) — online's rule.
   - **New errors:** `400 invalid_payload` with field `pickup_ready_minutes` (both or neither sent), or
     `pickup_ready_at` (not a future ISO time).
   - **The delivery's `pickup_ready_at`** is the time Uber was asked for. The register moves the order into its kitchen
     queue locally at `pickup_ready_at − estimated_pickup_minutes`. No dispatch timer.
2. **Tip:**
   - There's one tip, the order's own (`pricing.tip`). On a `fee_source: 'uber'` order it's the driver tip: Uber gets
     `min(tip, uber_driver_tip_max_cents)`.
   - There's no limit and no 400 above $5. Above the cap, show online's note: "Uber caps delivery driver tips at $5.00.
     Amounts above that support the restaurant."
   - Stop sending `delivery.uber.driver_tip_cents` (ignored if sent, any value).
   - The delivery's `driver_tip_cents` = the amount sent to Uber.
3. **Status:** Uber `failed` now arrives as `state: 'canceled'`, `canceled_by: 'provider'`. Alarm it like any provider
   cancel.
4. **Settings:** read `uber_driver_tip_max_cents` (500) from the settings block; don't hardcode it.

### `pos-v1-delivery-dispatch` — request / response at `49f3de7`

**Request** (device-authed, like every `pos-v1-*`):

```json
{
  "action_id": "uuid",
  "restaurant_id": "uuid",
  "order_id": "uuid",
  "pickup_ready_minutes": 20,          // ASAP: 5–120, else null / absent
  "pickup_ready_at": "ISO" | null,     // scheduled: the customer's slot (future), else null / absent
  "actor_staff_id": "uuid" | "register" | null,
  "approver_staff_id": "uuid" | null,
  "device_time": "ISO" | null
}
```

- Exactly one of `pickup_ready_minutes` / `pickup_ready_at`.
- `accepted_quote_id` is retired: ignored if sent, and left out of the idempotency hash.
- Idempotent by `action_id`: the same id + the same body (minus `device_time`) → the first outcome again (`duplicate`,
  or the same stored error); the same id + another body → `409 action_id_reused`.
- The order must be synced first, a `delivery` order with `driver_type: 'uber_direct'` and `fee_source: 'uber'`, with
  a `delivery.uber.quote_id` (`pq_…`) from `pos-v1-quote-delivery`, closed and paid in full by card.

**200:**

```json
{ "result": "applied" | "duplicate" | "noop", "delivery": Delivery, "server_time": "ISO" }
```

**`Delivery`** (also in the cancel and status answers):

```json
{
  "id": "uuid", "order_id": "uuid", "provider": "uber_direct",
  "state": "booking" | "booked" | "delivered" | "canceled" | "failed",
  "provider_status": "string" | null, "tracking_url": "string" | null,
  "courier": { "name": "string" | null, "phone": "string" | null } | null,
  "pickup_ready_at": "ISO" | null, "pickup_eta": "ISO" | null, "dropoff_eta": "ISO" | null,
  "dispatched_at": "ISO" | null, "delivered_at": "ISO" | null, "canceled_at": "ISO" | null,
  "customer_fee_cents": 450,
  "driver_tip_cents": 500,              // what Uber receives = min(order tip, uber_driver_tip_max_cents)
  "fee_delta_cents": 0,                 // Uber fee booked − Uber fee quoted at the phone call; restaurant absorbs it
  "cancellation_fee_cents": null,       // integer cents only when Uber charged one
  "canceled_by": "restaurant" | "provider" | null,
  "failure_code": "string" | null,
  "updated_at": "ISO"
}
```

**Errors** — `{ "error": { "code", "message", "field"?, "reason"?, "delivery"? } }`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_payload` | a bad field (`action_id`, `order_id`, `pickup_ready_minutes`, `pickup_ready_at`, `actor_staff_id`, `approver_staff_id`, `device_time`) |
| 403 | `delivery_not_enabled` | the restaurant's dispatch switch is off (settings `pos_delivery_dispatch_enabled`) |
| 400 | `unknown_order` | the order isn't synced |
| 400 | `action_not_allowed` | not an Uber delivery (`driver_type uber_direct` + `fee_source uber`) |
| 400 | `card_only` | any cash payment |
| 409 | `not_paid` | not closed, or paid less than the total |
| 400 | `quote_unknown` | no Uber quote of this restaurant on the order |
| 409 | `already_dispatched` | the order already has a live delivery |
| 400 | `restaurant_mismatch` | the restaurant isn't the register's |
| 502 | `delivery_failed` | Uber refused; `reason`: `no_courier_available`, `bad_address` or `provider_error` (incl. "outcome unknown — check the Uber dashboard" after a stale attempt) |
| 503 | `rate_limited` | Uber busy — retry after `Retry-After` with the same `action_id` (not stored) |
| 503 | `action_pending` | the same `action_id` is still in progress — retry shortly |
| 409 | `action_id_reused` | the same `action_id` with another body |
| 501 | `not_implemented` | dispatch isn't configured on the server |

Stored errors (everything above except 400 `invalid_payload` / `unknown_order`, 403, 503, 501) carry `error.delivery`
(the order's latest delivery, or null) and replay on a resend with the same `action_id`. An expired quote is
re-quoted and booked automatically — the customer's fee never changes; any difference is in `fee_delta_cents`.

## DB-005 · 2026-11-25 11:52 ET · FYI · re: DB-004

Server deploy source is now main (4aa5c28); pos-server retired.

**Correction to DB-004's last paragraph** (the error table itself stands). Only the errors the server STORES carry
`error.delivery` and replay on a resend with the same `action_id`: `400 action_not_allowed`, `400 card_only`,
`409 not_paid`, `400 quote_unknown`, `409 already_dispatched`, `502 delivery_failed`, and `400 restaurant_mismatch`
only when the restaurant's own record can't be read. Answered directly — not stored, no `error.delivery`:
`400 invalid_payload`, `400 unknown_order`, `403 delivery_not_enabled`, `409 action_id_reused` (that `action_id`
was already used for another request — send a new one), `503 rate_limited`, `503 action_pending`, `501
not_implemented`, and `400 restaurant_mismatch` when the request body names another restaurant.

## DB-006 · 2026-11-25 12:24 ET · ACTION · re: POS-005

**ACTION — `pickup_ready_at` is the CUSTOMER'S SLOT, not the kitchen ready time.** For a scheduled Uber delivery, send
the time the customer chose (their delivery slot — online's `scheduled_for`) as `pickup_ready_at`. The server
subtracts the restaurant's lead (`uber_scheduled_lead_minutes`, 10–60) to get the courier's pickup time, exactly as
online does. POS-005 says "a ready time still ahead goes as `pickup_ready_at`": if that is the kitchen ready time,
the lead is subtracted from it too and the courier arrives 10–60 min early. Please confirm which time the register
sends, and switch it to the slot if needed. (ASAP orders are unchanged: `pickup_ready_minutes`.)

**FYI:**
- **(a) CP23 is deployed live from main `9b3669d`:** `pos-v1-quote-delivery`, `pos-v1-delivery-dispatch`,
  `pos-v1-delivery-cancel`, `pos-v1-delivery-status`, `pos-v1-submit-order`, plus `pos-v1-online-orders` /
  `pos-v1-online-settings` (`uber_driver_tip_max_cents` in the settings block). The contract is DB-004 + DB-005's
  correction. Test Pizza's `pos_delivery_dispatch_enabled` is still OFF (dispatch answers `403 delivery_not_enabled`).
- **(b) Test Pizza's Uber is PRODUCTION, not sandbox.** Platform billing forces DirectBite's production Uber
  credentials whatever `uber_environment` says (`_shared/uberCreds.ts`), and Uber's fake robo-courier is only
  requested in sandbox. So **any dispatch books a real courier** (a real charge). Quotes are free — the current test
  is quote-only (Test Pizza's Uber is temporarily on for it). No dispatch without Matt's go.
- **(c) Your pilot-needs list isn't in `TO-DB.md`** (it ends at POS-005). Please post it.
- The every-register toast (POS-005) is being built on branch `toast-118` (restaurant-wide status read + a shared
  handled mark). The contract follows after Matt approves that commit.

## DB-007 · 2026-11-25 12:32 ET · ACTION · re: POS-005

**The every-register delivery toast — contract, approved by Matt; committed `80a63a4` on branch `toast-118`.**
Take it from that commit (`_shared/pos-delivery/handlers.ts` `handleDeliveryStatus` / `restaurantStatus` /
`alertOf` / `handleDeliveryAlert`, `_shared/pos-delivery/store.ts`, migration `118_pos_delivery_alerts.sql`).

**Not deployed yet.** Live only after migration 118 is applied and `pos-v1-delivery-alert` (new) +
`pos-v1-delivery-status` are deployed — Matt will confirm in a DB message. Until then the live status answers
`400 invalid_payload` (field `order_ids`) to `scope: 'restaurant'`, and `pos-v1-delivery-alert` doesn't exist.

### 1. `pos-v1-delivery-status` — `scope: 'restaurant'` (additive)

**Request:** `{ "restaurant_id": "uuid", "scope": "restaurant" }` — no `order_ids`. The existing
`{ restaurant_id, order_ids }` mode is unchanged.

**200:**

```json
{
  "deliveries": [
    {
      "order_id": "uuid",
      "ticket_label": "F-007" | null,
      "customer": { "name": "string" | null, "phone": "E.164" | null },
      "delivery": Delivery
    }
  ],
  "business_day": "YYYY-MM-DD",
  "server_time": "ISO"
}
```

- One entry per POS order of the restaurant — its **latest** delivery (a re-dispatch supersedes an earlier failed or
  canceled one) — when that delivery is live (`booking` / `booked`) or changed since the start of the current
  business day (the restaurant's time zone, 04:00 cutoff — the online feed's rule). Newest first, at most 100.
- Every register sees every delivery, whichever register took the order. `customer` is for staff only (the toast).
- Booked deliveries are refreshed from Uber exactly as in the `order_ids` mode — at most once per 30 s per delivery,
  shared by all registers — so polling from every register costs no extra Uber calls. Poll every 15–30 s.
- **Errors:** `400 invalid_payload` (field `scope` — anything but `'restaurant'`; field `order_ids` — sent together
  with `scope`); `500 delivery_config_invalid` (the restaurant has no valid time zone).

### 2. `Delivery` — 4 new fields (additive; on every answer that carries a delivery: status, dispatch, cancel, alert)

| Field | Values |
|---|---|
| `alert` | `"provider_canceled"` — Uber canceled, returned or failed the delivery (`state: canceled`, `canceled_by: provider`); `"booking_failed"` — the booking failed for good (`state: failed`, any `failure_code` except `rate_limited`, which the register retries); `null` — nothing to show |
| `alert_handled_at` | `"ISO"` once a register handled it, else `null` |
| `alert_handled_by` | the staff id or `"register"` that handled it, else `null` |
| `alert_choice` | `"in_house"` \| `"acknowledged"`, else `null` |

**Show the toast** when `alert !== null && alert_handled_at === null`. **Clear it** on every register as soon as
`alert_handled_at` is set (the next poll). `alert` stays set as history after it's handled.

### 3. `pos-v1-delivery-alert` (new) — the shared "handled" mark

**Request** (device-authed, like every `pos-v1-*`):

```json
{
  "action_id": "uuid",
  "restaurant_id": "uuid",
  "order_id": "uuid",
  "delivery_id": "uuid",              // the Delivery.id the toast is about
  "choice": "in_house" | "acknowledged",
  "actor_staff_id": "uuid" | "register" | null,
  "approver_staff_id": "uuid" | null,
  "device_time": "ISO" | null
}
```

The one-button "deliver in-house" toast sends `choice: "in_house"`. No provider call is made (cancelling or
re-dispatching stays with `pos-v1-delivery-cancel` / `pos-v1-delivery-dispatch`).

**200:** `{ "result": "applied" | "noop" | "duplicate", "delivery": Delivery, "server_time": "ISO" }`

- `applied` — this register handled it first; the mark is set (once).
- `noop` — another register got there first; `delivery` carries THEIR mark (`alert_choice` / `alert_handled_by`
  unchanged). Treat it as handled.
- `duplicate` — a resend of the same `action_id` + body.

**Errors** — `{ "error": { "code", "message", "field"?, "delivery"? } }`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_payload` | a bad field (`action_id`, `order_id`, `delivery_id`, `choice`, `actor_staff_id`, `approver_staff_id`, `device_time`) |
| 400 | `restaurant_mismatch` | `restaurant_id` isn't the register's |
| 409 | `delivery_changed` | the order has a newer delivery than `delivery_id` (re-dispatched meanwhile) — `error.delivery` = the latest; refresh |
| 400 | `no_alert` | nothing to handle on that delivery (no provider cancel / failed booking, or no delivery) — `error.delivery` = the latest or null |
| 409 | `action_id_reused` | the same `action_id` with another body — send a new one |
| 503 | `action_pending` | the same `action_id` is still in progress — retry shortly |

`delivery_changed` and `no_alert` are stored: a resend with the same `action_id` replays them. The other errors are
answered directly (not stored, no `error.delivery`).
