# Tablet Setup

Operational checklist for provisioning a restaurant tablet (Fully Kiosk
Browser on a wall-mounted Android tablet). Not a customer-facing manual
— kept brief on purpose.

## Auto-reload configuration (REQUIRED before deployment)

Every tablet must reload automatically when the screen wakes so platform
updates propagate the next morning when the restaurant opens.

In Fully Kiosk Browser settings:

1. Find "Reload on Screen On" (or equivalent — exact wording varies by
   version) → enable.
2. Find "Reload Page Every X Seconds" → set to `21600` (6 hours,
   belt-and-suspenders backup for tablets that run 24/7).
3. Verify by sleeping and waking the tablet — page should reload to the
   same URL without breaking kiosk lock.

## Why this matters

Platform updates ship to Vercel continuously. Tablets running cached
code don't see updates until forced to reload. For non-breaking changes
this is harmless. For breaking changes (DB schema, API contract, print
logic) old tablet code may fail in production — typically discovered
during dinner service when it's least convenient.

Restaurants sleep their tablets at end-of-day. Morning wake → fresh
code. The 6-hour fallback covers the rare 24/7-running case.

## Replicating config across tablets

After configuring the first tablet:

1. Settings → Other Settings → Import/Export Settings → Export.
2. Save the `.properties` file.
3. On each subsequent tablet: Import that file.
4. Verify "Reload on Screen On" is enabled after import.

## Pre-deployment tablet checklist

Before handing a tablet to a restaurant:

- [ ] Reload on Screen On enabled
- [ ] Reload Every 21600s set (6h fallback)
- [ ] Tablet locked to correct DirectBite URL via Kiosk mode
- [ ] Printer IP entered in DirectBite admin for this restaurant
- [ ] End-to-end test order placed (customer order → tablet receives →
      printer prints → marked complete)
