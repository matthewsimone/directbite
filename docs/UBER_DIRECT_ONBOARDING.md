# DirectBite Restaurant Onboarding Playbook

> Uber Direct + Stripe Connect, white-glove. This is **my** checklist — not something to hand the restaurant. Work top to bottom.

## Overview

This is the step-by-step for getting a new restaurant fully live on DirectBite with both Stripe Connect (payments) and Uber Direct (delivery). It's built around how I actually run these: a little prep a day or two ahead, then an in-person visit to wire everything up and run a real test order.

**Time budget:** ~2–3 hours of active work, split:
- Pre-meeting: ~20 min sending links + a follow-up to make sure they finished.
- Onsite: ~90 min config + ~20 min test order + walkthrough.
- The wall-clock is longer because you're waiting on *them* to finish Stripe/Uber signups in between.

**Bring:**
- Laptop (you'll be logging into Stripe + Uber dashboards).
- A spare tablet for testing, OR use theirs once it's set up.
- Your phone (you place the test order from it).
- A real credit card for the test charge (you refund it at the end).
- Business cards + the printer cables/adapters (Netgear switch, WiFi dongle, power).

**The golden rule:** the webhook signing secret is shown **once**. If you blow past that screen without copying it, you're regenerating the webhook. Don't rush section 4.

---

## Pre-Meeting (1–2 days before)

Send the restaurant two signup links and the list of stuff they'll need. Do this far enough ahead that they can finish before you show up — Stripe verification especially can take a bit.

**Links to send:**
- **Stripe Connect signup** — (custom-generated link; source TBD — grab from the Stripe Connect onboarding flow).
- **Uber Direct signup** — `direct.uber.com`.

**Tell them to have ready:**
- Business EIN
- Bank account info — routing + account number (for payouts)
- Business address (must match their verification docs)
- Owner's photo ID
- Business phone number

> **Tip:** Text them the list, don't just say it. Half the delay on these is someone hunting for a voided check at 9pm. If they're a sole prop without an EIN, Stripe will take an SSN — flag that so they're not surprised.

---

## Restaurant Completes Signups

- They fill out **Stripe Connect** → they ping you when done. You review the account in your Stripe dashboard, submit/approve anything pending.
- They fill out **Uber Direct** → confirm the account actually exists and is approved before you drive out. An Uber account that's still "under review" will block you onsite.
- Review **both** before the visit. If either is stuck, sort it remotely — don't burn the onsite slot waiting on Uber approval.

> **Tip:** Don't schedule the onsite until you've personally confirmed the Uber Direct account is live and you can see API credentials. This is the #1 thing that wastes a visit.

---

## Onsite Visit: DirectBite Configuration

### 1. Set up hardware (15 min)
- Put their tablet into kiosk mode with **Fully Kiosk Browser**.
- Start URL: `https://directbite.co/[slug]/tablet`
- Plug in the **Epson TM-m30II-H** — either via the Netgear switch (wired, preferred) or the WiFi dongle.
- Fire off a couple test prints. Confirm they actually come out, not just "success" on screen.

> **Tip:** Wired printer > WiFi printer every time. If you're on the dongle and prints are flaky, that's your first suspect.

### 2. Add restaurant to DirectBite (5 min)
- Create the restaurant record + slug. *(DB/admin setup — fill in exact steps here.)*
- Confirm `https://directbite.co/[slug]` loads their menu before moving on.

### 3. Stripe Connect setup (10 min)
- Open your Stripe dashboard → find the restaurant's connected account.
- Copy the **Stripe account ID** (`acct_...`).
- Enter it in DirectBite **Settings → Stripe**.
- Confirm the account shows **verified / charges enabled** on the Stripe side. If it's still pending, payments won't go through — resolve before the test order.

> **Tip:** If Stripe shows a ToS / capabilities loop (see Common Issues), deal with it now, not during the test order.

### 4. Uber Direct setup (15 min) — *go slow here*
1. Open `https://direct.uber.com` and log in with **their** credentials.
2. Go to the **Developer / API** section. All three API keys live on this one page:
   - **Customer ID**
   - **Client ID**
   - **Client Secret**
   Copy all three somewhere safe.
3. Open a **separate tab** → Webhook configuration. Add a new webhook:
   - **URL:** `https://euqhnetswowbfxwwlmry.supabase.co/functions/v1/uber-webhook`
   - **Events:** ✅ `event.delivery_status`  ✅ `event.courier_update`
   - ❌ Do **not** subscribe to `event.refund_request` — we don't handle it and it'll just create noise.
   - Click **Save**. Uber generates the **webhook signing secret**.
   - 🚨 **COPY THE SIGNING SECRET RIGHT NOW.** It's shown once. If you miss it, delete the webhook and re-create it to get a fresh one.
4. Back in DirectBite → **Settings → Set up Uber Direct**.
5. Paste all **four** fields: Customer ID, Client ID, Client Secret, **Webhook Signing Secret**.
6. Click **Save Credentials** → wait for the green **Verified** confirmation.

> **Tip:** The first three verify against Uber's API (you'll see "Verified! Connected as ..."). The signing secret does **not** get verified at this step — it's only exercised when a webhook actually arrives. So the real proof it's right is the test order in a few minutes. Double-check you pasted it correctly; a wrong signing secret = webhooks silently rejected.

### 5. Configure Delivery Mode (10 min)
Talk it through with them, then pick on the connected card:
- **In-House Only** — they deliver with their own drivers, always. (Uber never used.)
- **Uber Direct Only** — they have no drivers; everything goes to Uber.
- **Both — Schedule + Real-Time Override** — they cover some days/hours themselves and want Uber to fill the gaps.

If **Both**, you'll set the schedule in section 7.

> **Tip:** Most places that "have a driver" actually mean "have a guy who sometimes can." For those, **Both** with a conservative schedule + the Real-Time Override is the honest setup — they flip Uber on when their guy bails.

### 6. Configure Cost Sharing (10 min)
This is "who eats the Uber delivery fee." Pick a mode and use the **live preview** ("On a $7.99 fee: customer pays $X.XX, you absorb $Y.YY") to show them exactly what happens:
- **Customer pays full fee** — restaurant absorbs nothing. **Safest starting point; most common.**
- **Split by percentage** — customer pays X% of the fee, restaurant covers the rest.
- **You cap your cost** — restaurant absorbs up to $X, customer pays anything above. (Subsidize delivery up to a limit.)
- **Cap the customer's cost** — customer pays up to $X, restaurant absorbs the overflow. (Good for "free delivery feels expensive" psychology with a ceiling on your exposure.)
- **You cover the full fee** — restaurant eats 100%. Premium / promo play.

> **Tip:** Reference setup is **Test Pizza: "You cap your cost" at $3.00** → on a $7.99 fee the customer pays $4.99 and the restaurant absorbs $3.00. Show them that exact example with the preview — it makes the cap modes click instantly. **Watch the asymmetry:** "You cap your cost" caps *your* share; "Cap the customer's cost" caps *theirs*. Read the helper text out loud so nobody picks the wrong one.

### 7. Set Delivery Hours (only if Both mode)
- Per-day: toggle the day on/off, set **start** and **end** time (24h).
- The schedule decides when Uber Direct is the active fulfillment for delivery orders; outside those windows it falls back to in-house.
- **Real-Time Override** toggle = "my driver just bailed, send everything to Uber **now**" regardless of schedule. Show them where it is and how to flip it back off.

> **Tip:** Overnight windows (e.g. 10pm–2am) aren't supported yet — keep start before end within the same day. And it's all **Eastern time** right now, so no surprises there for Bergen County.

---

## End-to-End Test Order (20 min)

Do a **real** order, real money, then cancel it to also prove the refund cascade. This is the single most important step — it validates Stripe, Uber dispatch, webhooks, and refunds in one shot.

1. From **your phone**, place a test delivery order at `https://directbite.co/[slug]`.
2. Use a **real Stripe card** (you refund at the end). Use a real, deliverable address — pick it from the Google autocomplete dropdown, don't hand-type it.
3. On the **tablet**: accept → **Set Pickup Time** → 5 min → **Confirm and Dispatch**.
4. Wait for **courier assigned** (~5–6 min in Bergen County). Watch the tile: it should move `Searching for courier → Courier en route` with a live **ETA** (driver's arrival at the restaurant).
5. Now **Cancel mid-flow** to validate the refund cascade. Tap **Cancel & Refund Order** — the modal shows the live delivery state + cancellation-fee estimate. Confirm.
6. Verify: order shows **Cancelled**, the customer (you) gets a **full refund**, no error banners, and the tablet doesn't show a red "REFUND FAILED" card.

> **Tip:** Watching the ETA flip from "Scheduled" to a live "ETA 5:12 PM" once the courier's assigned is your proof the **webhook + signing secret are correct**. If the ETA never goes live, the webhook isn't landing — go back to section 4 and check the signing secret. Also confirm your refund actually shows the right **dollar** amount (e.g. "$8.03," not "$0.08" — that was an old bug, fixed, but eyeball it).

---

## Go Live + Initial Monitoring

- Walk the staff through the tablet: accepting orders, **Set Pickup Time & dispatch**, reading order status, and **Cancel & Refund** (when and how).
- Show them what a **delivered** vs **canceled** tile looks like, and where the order number + customer info are.
- **24-hour check-in:** text or call. "Any orders come through? Anything weird?" Catch problems while they're small.
- **1-week follow-up:** check order volume + any failed dispatches. Make sure they're actually using it, not falling back to phone orders out of habit.
- **1-month follow-up:** review the numbers together, troubleshoot any patterns (slow dispatches, cancellations, print failures).

> **Tip:** After any DirectBite deploy, the tablet (Fully Kiosk) can serve stale cached JS. If a restaurant reports "the button does nothing" right after you pushed something, it's almost always cache — hard refresh first, debug second.

---

## Common Issues + Fixes

### "Webhook not firing"
- Webhook URL must be an **exact** match: `https://euqhnetswowbfxwwlmry.supabase.co/functions/v1/uber-webhook` (no trailing slash, no typos).
- Confirm all **4** credentials are pasted — especially the **Webhook Signing Secret** (it's the one with no UI verification, so it's the easy one to fat-finger).
- Confirm the signing secret in the Uber dashboard matches what's in DirectBite Settings. If unsure, regenerate in Uber and re-paste in both is overkill — just re-copy and re-paste into DirectBite.
- Symptom: courier gets assigned on Uber's side but the tablet never shows live status/ETA → webhook landing but being **rejected** (bad signing secret) or not subscribed to the right events.

### "Order shows NULL dropoff coords" *(historical — fixed in production)*
- The customer's address needs valid lat/lng from the **Google autocomplete** (selected from the dropdown, not hand-typed).
- This was a real bug (order #1000436) and is fixed three ways now (quote cache stores coords, payment-intent backfills, dispatch guard blocks coordless orders). If you ever see it again: check the `uber_quotes` cache row for that quote has dropoff coords.

### "Order stuck in Searching for courier"
- Bergen County usually finds a courier in **1–5 min**.
- Past **15 min** = likely no driver available (rare here). There's **no auto-alert** yet — the operator has to notice and manually **Cancel & Refund**.
- Tell the staff this during the walkthrough so they're not staring at it forever.

### "Refund failed in tablet"
- That's a real Stripe error, not a display glitch. Check the **Stripe dashboard** for that specific charge.
- **Retry from the tablet** — the cancel cascade is idempotent: it won't double-cancel Uber, it just re-attempts the Stripe refund. The red "REFUND FAILED" card clears once it succeeds.

### "Tablet white screen / Fully Kiosk session expired"
- **Hard refresh** from Fully Kiosk settings.
- Clear browser cache + cookies if that doesn't do it.
- Most common right after a deploy — see the monitoring tip above.

### "Stripe Connect ToS compliance loop"
- Known from past onboardings — account gets stuck asking for ToS acceptance / capabilities it won't let you complete.
- May need **Stripe support escalation**. Don't let it eat your onsite time — flag it during pre-meeting review and resolve before the visit.

---

## Glossary / Quick Reference (for the new operator)

**Order states (tablet tabs):**
- **New** — just came in, not yet accepted.
- **In Progress** — accepted / being prepared / out for delivery.
- **Complete** — done. (Uber orders auto-complete once the courier picks up the food.)
- **Cancelled** — cancelled + refunded.

**Uber Direct status line (on delivery tiles):**
- `Searching for courier` → `Courier en route` → `Picked up` → `Delivering` → `Delivered`
- `· ETA X:XX` = live estimate of the **courier arriving at the restaurant** (pickup), not the customer drop-off.
- `· Scheduled X:XX` = the pickup time you committed to before a courier was assigned.

**Color cues:**
- **Blue** = Uber Direct in flight (normal).
- **Green** = delivered / done.
- **Red** = canceled / failed / returned, or a **REFUND FAILED** card that needs manual follow-up.

**Key buttons:**
- **Set Pickup Time & Mark in Progress** — accept a new Uber order + dispatch to Uber.
- **Cancel & Refund Order** — cancels the Uber delivery (if any) and refunds the customer. Shows a fee estimate first.
- **ADJUST** — (on complete orders) partial refund / charge adjustment.
- **REPRINT** — re-run the kitchen ticket.

**Reference setup:** Test Pizza — Delivery Mode varies, Cost Sharing = **You cap your cost @ $3.00**. Use it as your "known-good" comparison when something looks off.
