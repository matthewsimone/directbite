// Node-runnable assertions for isUberActiveNow (no test runner required):
//   node src/utils/uberActive.test.js
//
// Dates use explicit -04:00 (EDT, July) offsets so the injected `now` maps to
// an unambiguous America/New_York wall-clock time.
//   2026-07-15 = Wednesday (NY dow "3")
//   2026-07-14 = Tuesday   (NY dow "2")

import { isUberActiveNow, isUberExtendedZoneActiveNow } from './uberActive.js';

const wedSchedule = { '3': { enabled: true, start: '11:00', end: '16:00' } };

// A fixed clock for cases where time shouldn't matter.
const anyNow = new Date('2026-07-15T12:00:00-04:00');

const cases = [
  {
    name: 'in_house → false (always)',
    restaurant: { delivery_fulfillment: 'in_house', uber_billing_mode: 'platform', uber_direct_active: true, uber_schedule: wedSchedule },
    now: anyNow,
    expect: false,
  },
  {
    name: 'uber_direct + platform billing → true',
    restaurant: { delivery_fulfillment: 'uber_direct', uber_billing_mode: 'platform', uber_credentials_verified_at: null },
    now: anyNow,
    expect: true,
  },
  {
    name: 'both + override ON → true (even off-schedule)',
    restaurant: { delivery_fulfillment: 'both', uber_billing_mode: 'platform', uber_direct_active: true, uber_schedule: {} },
    now: new Date('2026-07-14T03:00:00-04:00'), // Tue 3am, no schedule
    expect: true,
  },
  {
    name: 'both + override off + Wed 12:00 NY, sched Wed 11:00-16:00 → true',
    restaurant: { delivery_fulfillment: 'both', uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-15T12:00:00-04:00'),
    expect: true,
  },
  {
    name: 'both + override off + Tue 12:00 NY, same schedule → false',
    restaurant: { delivery_fulfillment: 'both', uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-14T12:00:00-04:00'),
    expect: false,
  },
  {
    name: 'both + override off + Wed 16:00 NY (end-exclusive) → false',
    restaurant: { delivery_fulfillment: 'both', uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-15T16:00:00-04:00'),
    expect: false,
  },
];

// isUberExtendedZoneActiveNow — the "is in-house being EXTENDED by Uber" question.
// True for delivery_fulfillment='in_house' AND uber_extends_delivery=true AND
// usable credentials. CREDENTIALS ONLY — the schedule and the realtime override
// are not consulted, because an extended zone is a permanent capability, not an
// availability window. Mirrors resolveMode Branch 1e.
//
// A schedule that throws on read proves the point: the old rule ran it through
// evaluateBothRules and caught the error into a false, the new one never touches it.
const explodingSchedule = {
  get '3'() { throw new Error('uber_schedule must not be read on the extended-zone path'); },
};

const extendedCases = [
  {
    name: 'extended: in_house + opted in + platform creds → true',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-15T12:00:00-04:00'),
    expect: true,
  },
  {
    name: 'extended: in_house + opted in + Tue 12:00 NY, Wed-only schedule → true (schedule ignored)',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-14T12:00:00-04:00'),
    expect: true,
  },
  {
    name: 'extended: in_house + opted in + override ON, no schedule → true',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: true, uber_schedule: {} },
    now: new Date('2026-07-14T03:00:00-04:00'),
    expect: true,
  },
  {
    name: 'extended: in_house + NOT opted in + override ON → false',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: false, uber_billing_mode: 'platform', uber_direct_active: true, uber_schedule: wedSchedule },
    now: anyNow,
    expect: false,
  },
  {
    name: 'extended: in_house + opted in + self billing, creds unverified → false',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'self', uber_credentials_verified_at: null, uber_direct_active: true, uber_schedule: wedSchedule },
    now: anyNow,
    expect: false,
  },
  {
    name: 'extended: uber_direct + opted in → false (not an in_house zone)',
    restaurant: { delivery_fulfillment: 'uber_direct', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: true, uber_schedule: wedSchedule },
    now: anyNow,
    expect: false,
  },
  {
    name: 'extended: both + opted in → false (not an in_house zone)',
    restaurant: { delivery_fulfillment: 'both', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: true, uber_schedule: wedSchedule },
    now: anyNow,
    expect: false,
  },

  // --- schedule independence: every case below is off-schedule with the
  // override OFF, and every one must still be true. Under the old rule each
  // resolved false, which is what made the tablet badge disappear.
  {
    name: 'extended: override off + empty schedule → true',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: {} },
    now: new Date('2026-07-14T03:00:00-04:00'),
    expect: true,
  },
  {
    name: 'extended: override off + null schedule → true',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: null },
    now: anyNow,
    expect: true,
  },
  {
    name: 'extended: override off + Wed 16:00 NY (end-exclusive, false for both) → true',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-15T16:00:00-04:00'),
    expect: true,
  },
  {
    name: 'extended: override off + self billing WITH verified creds, off-schedule → true',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'self', uber_credentials_verified_at: '2026-07-01T00:00:00Z', uber_direct_active: false, uber_schedule: wedSchedule },
    now: new Date('2026-07-14T12:00:00-04:00'),
    expect: true,
  },
  {
    name: 'extended: override off + schedule that throws if read → true (never read)',
    restaurant: { delivery_fulfillment: 'in_house', uber_extends_delivery: true, uber_billing_mode: 'platform', uber_direct_active: false, uber_schedule: explodingSchedule },
    now: new Date('2026-07-15T12:00:00-04:00'),
    expect: true,
  },
];

let failures = 0;
for (const c of cases) {
  const got = isUberActiveNow(c.restaurant, c.now);
  const pass = got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
}
for (const c of extendedCases) {
  const got = isUberExtendedZoneActiveNow(c.restaurant, c.now);
  const pass = got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
}
const total = cases.length + extendedCases.length;
console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
