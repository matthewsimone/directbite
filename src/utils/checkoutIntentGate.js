// When CheckoutPage may send its FIRST create-payment-intent (CP16).
//
// The bug: useRestaurant sets `restaurant` BEFORE it fetches the hours
// (useRestaurant.js:89, hours at :91), so the create effect fired on a render
// where the open flags were still their initial false and the schedules null —
// before the prefill effect could choose a time for a closed order type. The
// create always carried scheduled_for: null; with enforcement on, a closed
// restaurant's scheduled order was refused as ASAP (409 restaurant_closed,
// outside_hours), and the create was never retried (intentCreated stays set).
//
// The gate waits for (1) the restaurant load to finish (hours + open flags
// resolved) and (2) when the order type is closed and a slot exists, the
// prefill's scheduled time. It never waits when no slot exists (closed for a
// week, or hours unknown): the create goes out exactly as before.

import { getAvailableDates, getAvailableTimeSlots } from './scheduling.js'

/** The time the prefill effect picks for a closed order type: the first slot of the first available date, or null. */
export function firstPrefillSlot(typeSchedule, leadTimeMinutes) {
  const dates = getAvailableDates(typeSchedule, { leadTimeMinutes })
  if (dates.length === 0) return null
  const slots = getAvailableTimeSlots(dates[0].date, typeSchedule, { leadTimeMinutes })
  return slots.length > 0 ? slots[0].value : null
}

/**
 * Why the first create must wait, or null when it may go now.
 *   'loading'          — the restaurant load hasn't finished (open flags / schedules not resolved)
 *   'awaiting_prefill' — the order type is closed, a slot exists and no time is chosen yet
 */
export function intentCreateWait({ restLoading, isTypeOpen, scheduledFor, prefillSlot }) {
  if (restLoading) return 'loading'
  if (!isTypeOpen && !scheduledFor && prefillSlot) return 'awaiting_prefill'
  return null
}
