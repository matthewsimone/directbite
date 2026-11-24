// Node-runnable assertions for the checkout intent gate (CP16; no test runner required):
//   node src/utils/checkoutIntentGate.test.js
//
// Replays the render sequence CheckoutPage sees (useRestaurant sets the restaurant first, the hours
// second, then the prefill effect sets scheduledFor) and records the scheduled_for of the FIRST
// create-payment-intent. The pre-fix gate (restaurant + items only) is replayed too: it reproduces
// the bug — a closed restaurant's scheduled order is created with scheduled_for null.

import assert from 'node:assert/strict'
import { firstPrefillSlot, intentCreateWait } from './checkoutIntentGate.js'

const legacyGate = () => null // pre-CP16: no wait once restaurant + items exist

/** The first create's scheduled_for under `gate`, or 'none' if no render creates. */
function firstCreate(renders, gate) {
  for (const r of renders) {
    if (!r.restaurant) continue
    if (gate(r) === null) return r.scheduledFor
  }
  return 'none'
}

const SLOT = '2026-11-20T13:30:00.000Z' // tomorrow 08:30 New York

// useRestaurant + prefill render sequence for a restaurant CLOSED now with slots tomorrow
const closedWithSlots = [
  { restaurant: null, restLoading: true, isTypeOpen: false, scheduledFor: null, prefillSlot: null },
  { restaurant: {}, restLoading: true, isTypeOpen: false, scheduledFor: null, prefillSlot: null },    // restaurant set, hours in flight
  { restaurant: {}, restLoading: false, isTypeOpen: false, scheduledFor: null, prefillSlot: SLOT },  // hours loaded: closed
  { restaurant: {}, restLoading: false, isTypeOpen: false, scheduledFor: SLOT, prefillSlot: SLOT },  // prefill effect ran
]
// OPEN now: ASAP, no time
const openNow = [
  { restaurant: {}, restLoading: true, isTypeOpen: false, scheduledFor: null, prefillSlot: null },
  { restaurant: {}, restLoading: false, isTypeOpen: true, scheduledFor: null, prefillSlot: SLOT },
]
// hours fetch failed / timed out (hoursUnknown): no schedule, open flag untouched (false), no slot
const hoursUnknown = [
  { restaurant: {}, restLoading: true, isTypeOpen: false, scheduledFor: null, prefillSlot: null },
  { restaurant: {}, restLoading: false, isTypeOpen: false, scheduledFor: null, prefillSlot: null },
]

let n = 0
const check = (name, fn) => { fn(); n++; console.log('ok -', name) }

check('REPRO (pre-fix gate): closed now + slot tomorrow → first create carries scheduled_for null', () => {
  assert.equal(firstCreate(closedWithSlots, legacyGate), null)
})
check('FIX: closed now + slot tomorrow → first create carries the prefilled time', () => {
  assert.equal(firstCreate(closedWithSlots, intentCreateWait), SLOT)
})
check('open now → first create is ASAP (null), right after the load', () => {
  assert.equal(firstCreate(openNow, intentCreateWait), null)
})
check('hours unknown / no slot → the create still goes out (no new hang)', () => {
  assert.equal(firstCreate(hoursUnknown, intentCreateWait), null)
})
check('a user-chosen time on a closed type → no wait', () => {
  assert.equal(intentCreateWait({ restLoading: false, isTypeOpen: false, scheduledFor: SLOT, prefillSlot: SLOT }), null)
})
check('wait reasons', () => {
  assert.equal(intentCreateWait({ restLoading: true, isTypeOpen: true, scheduledFor: null, prefillSlot: null }), 'loading')
  assert.equal(intentCreateWait({ restLoading: false, isTypeOpen: false, scheduledFor: null, prefillSlot: SLOT }), 'awaiting_prefill')
})
check('firstPrefillSlot: no schedule → null; a schedule open every day → an ISO slot in the future', () => {
  assert.equal(firstPrefillSlot(null, 30), null)
  // the effective-schedule shape useRestaurant passes ({"<dow>": [{start, end}]})
  const every = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ start: '00:00', end: '23:59' }]]))
  const s = firstPrefillSlot(every, 30)
  assert.ok(typeof s === 'string' && !Number.isNaN(Date.parse(s)) && Date.parse(s) > Date.now(), String(s))
})

console.log(`\n${n} checks passed`)
