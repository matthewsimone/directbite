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
