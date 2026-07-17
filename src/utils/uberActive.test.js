// Node-runnable assertions for isUberActiveNow (no test runner required):
//   node src/utils/uberActive.test.js
//
// Dates use explicit -04:00 (EDT, July) offsets so the injected `now` maps to
// an unambiguous America/New_York wall-clock time.
//   2026-07-15 = Wednesday (NY dow "3")
//   2026-07-14 = Tuesday   (NY dow "2")

import { isUberActiveNow } from './uberActive.js';

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

let failures = 0;
for (const c of cases) {
  const got = isUberActiveNow(c.restaurant, c.now);
  const pass = got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
