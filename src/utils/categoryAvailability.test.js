// Node-runnable assertions for categoryAvailability (no test runner required):
//   node src/utils/categoryAvailability.test.js
//
// Dates use explicit -04:00 (EDT, August) offsets so the injected `now` maps to
// an unambiguous America/New_York wall-clock time.
//   2026-08-23 = Sunday    (NY dow "0")
//   2026-08-24 = Monday    (NY dow "1")
//   2026-08-25 = Tuesday   (NY dow "2")
//   2026-08-29 = Saturday  (NY dow "6")
// The DST case at the bottom uses -05:00 (EST, January) for the same reason.

import { isCategoryAvailableNow, formatAvailabilityLabel } from './categoryAvailability.js';

// Fixtures. A literal seven-day object is unreadable, so days are built from a
// list — the shape produced is exactly the documented one:
//   { "<dow>": { enabled: true, start, end } }
function days(dowList, start = null, end = null) {
  const out = {};
  for (const d of dowList) out[String(d)] = { enabled: true, start, end };
  return out;
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
const MON_FRI = [1, 2, 3, 4, 5];

const allDaysNoTimes = days(ALL);
const allDays11to3 = days(ALL, '11:00', '15:00');
const tuesdayOnly = days([2]);
const monFri11to3 = days(MON_FRI, '11:00', '15:00');
const sunAndWed = days([0, 3]);
const monWedFri = days([1, 3, 5]);
const monFri11to3PlusSat11to4 = { ...monFri11to3, ...days([6], '11:00', '16:00') };

const SUN_NOON = new Date('2026-08-23T12:00:00-04:00');
const MON_NOON = new Date('2026-08-24T12:00:00-04:00');
const TUE_NOON = new Date('2026-08-25T12:00:00-04:00');
const SAT_NOON = new Date('2026-08-29T12:00:00-04:00');
const TUE_1100 = new Date('2026-08-25T11:00:00-04:00');
const TUE_1500 = new Date('2026-08-25T15:00:00-04:00');
const TUE_1501 = new Date('2026-08-25T15:01:00-04:00');

// January, EST. Same Tuesday-only object must still resolve dow "2" — proves
// the NY extraction is not carrying a hardcoded summer offset.
const JAN_TUE_NOON = new Date('2026-01-06T12:00:00-05:00');
const JAN_MON_NOON = new Date('2026-01-05T12:00:00-05:00');

const availabilityCases = [
  {
    name: 'null → available (unrestricted)',
    availability: null,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'undefined → available',
    availability: undefined,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: '{} → available (fail open, nothing configured)',
    availability: {},
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'all 7 days enabled, no times → available',
    availability: allDaysNoTimes,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'all 7 days enabled, no times → available at 3am too',
    availability: allDaysNoTimes,
    now: new Date('2026-08-25T03:00:00-04:00'),
    expect: true,
  },
  {
    name: 'Tuesday-only, no times → available Tuesday noon',
    availability: tuesdayOnly,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'Tuesday-only, no times → NOT available Monday noon',
    availability: tuesdayOnly,
    now: MON_NOON,
    expect: false,
  },
  {
    name: 'all 7 days 11:00-15:00 → available Tue 12:00',
    availability: allDays11to3,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'all 7 days 11:00-15:00 → NOT available Tue 15:01',
    availability: allDays11to3,
    now: TUE_1501,
    expect: false,
  },
  {
    name: 'all 7 days 11:00-15:00 → available exactly at 11:00 (inclusive start)',
    availability: allDays11to3,
    now: TUE_1100,
    expect: true,
  },
  {
    name: 'all 7 days 11:00-15:00 → available exactly at 15:00 (inclusive end)',
    availability: allDays11to3,
    now: TUE_1500,
    expect: true,
  },
  {
    name: 'Mon-Fri 11:00-15:00 → NOT available Saturday noon',
    availability: monFri11to3,
    now: SAT_NOON,
    expect: false,
  },
  {
    name: 'Mon-Fri 11:00-15:00 → available Tuesday noon',
    availability: monFri11to3,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'Sun + Wed enabled → available Sunday noon',
    availability: sunAndWed,
    now: SUN_NOON,
    expect: true,
  },
  {
    name: 'Sun + Wed enabled → NOT available Tuesday noon',
    availability: sunAndWed,
    now: TUE_NOON,
    expect: false,
  },
  {
    name: 'Mon-Fri 11-3 + Sat 11-4 → available Sat 15:30 (Saturday window is longer)',
    availability: monFri11to3PlusSat11to4,
    now: new Date('2026-08-29T15:30:00-04:00'),
    expect: true,
  },
  {
    name: 'Mon-Fri 11-3 + Sat 11-4 → NOT available Fri 15:30',
    availability: monFri11to3PlusSat11to4,
    now: new Date('2026-08-28T15:30:00-04:00'),
    expect: false,
  },

  // --- day present but switched off ---
  {
    name: 'enabled:false on today → NOT available (other days enabled)',
    availability: { '2': { enabled: false }, '3': { enabled: true } },
    now: TUE_NOON,
    expect: false,
  },
  {
    name: 'every day enabled:false → available (fail open, no day enabled)',
    availability: { '0': { enabled: false }, '2': { enabled: false } },
    now: TUE_NOON,
    expect: true,
  },

  // --- garbage: every one of these must fail open, at any instant ---
  {
    name: 'garbage "abc" → available',
    availability: 'abc',
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'garbage 42 → available',
    availability: 42,
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'garbage [] → available',
    availability: [],
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'garbage { "2": { enabled: true, start: "banana" } } → available on Tuesday',
    availability: { '2': { enabled: true, start: 'banana' } },
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'garbage { "2": { enabled: true, start: "banana" } } → available on MONDAY too (bad blob restricts nothing)',
    availability: { '2': { enabled: true, start: 'banana' } },
    now: MON_NOON,
    expect: true,
  },
  {
    name: 'garbage { "2": { enabled: true, start: "11:00", end: "25:00" } } → available',
    availability: { '2': { enabled: true, start: '11:00', end: '25:00' } },
    now: SAT_NOON,
    expect: true,
  },
  {
    name: 'garbage { "2": "yes" } → available',
    availability: { '2': 'yes' },
    now: TUE_NOON,
    expect: true,
  },
  {
    name: 'partial window (start, no end) → treated as all day',
    availability: { '2': { enabled: true, start: '11:00', end: null } },
    now: new Date('2026-08-25T23:00:00-04:00'),
    expect: true,
  },
  {
    name: 'HH:MM:SS from the hours table is tolerated, not distrusted',
    availability: { '2': { enabled: true, start: '11:00:00', end: '15:00:00' } },
    now: TUE_1501,
    expect: false,
  },

  // --- DST sanity: the same object, six months earlier ---
  {
    name: 'DST: Tuesday-only → available Tue 2026-01-06 noon EST',
    availability: tuesdayOnly,
    now: JAN_TUE_NOON,
    expect: true,
  },
  {
    name: 'DST: Tuesday-only → NOT available Mon 2026-01-05 noon EST',
    availability: tuesdayOnly,
    now: JAN_MON_NOON,
    expect: false,
  },
  {
    name: 'DST: all 7 days 11:00-15:00 → NOT available 15:01 EST in January',
    availability: allDays11to3,
    now: new Date('2026-01-06T15:01:00-05:00'),
    expect: false,
  },
];

const labelCases = [
  { name: 'label: null → ""', availability: null, expect: '' },
  { name: 'label: {} → ""', availability: {}, expect: '' },
  { name: 'label: all 7 days, no times → ""', availability: allDaysNoTimes, expect: '' },
  { name: 'label: all 7 days 11:00-15:00 → "11am-3pm"', availability: allDays11to3, expect: '11am-3pm' },
  { name: 'label: Tuesday only → "Tuesday"', availability: tuesdayOnly, expect: 'Tuesday' },
  { name: 'label: Mon-Fri 11:00-15:00 → "Mon-Fri, 11am-3pm"', availability: monFri11to3, expect: 'Mon-Fri, 11am-3pm' },
  { name: 'label: Sun + Wed → "Sun & Wed"', availability: sunAndWed, expect: 'Sun & Wed' },
  { name: 'label: Mon, Wed, Fri → "Mon, Wed & Fri"', availability: monWedFri, expect: 'Mon, Wed & Fri' },
  {
    name: 'label: Mon-Fri 11-3 + Sat 11-4 → "Mon-Fri 11am-3pm, Sat 11am-4pm"',
    availability: monFri11to3PlusSat11to4,
    expect: 'Mon-Fri 11am-3pm, Sat 11am-4pm',
  },
  {
    name: 'label: Fri-Sun wraps the week end → "Fri-Sun" (WEEK_ORDER run detection)',
    availability: days([5, 6, 0]),
    expect: 'Fri-Sun',
  },
  {
    name: 'label: Mon-Fri only, no times → "Mon-Fri"',
    availability: days(MON_FRI),
    expect: 'Mon-Fri',
  },
  {
    name: 'label: Saturday alone with a window → "Saturday, 11am-4pm"',
    availability: days([6], '11:00', '16:00'),
    expect: 'Saturday, 11am-4pm',
  },
  {
    name: 'label: half-hour times render minutes → "11:30am-3pm"',
    availability: days([2], '11:30', '15:00'),
    expect: 'Tuesday, 11:30am-3pm',
  },
  { name: 'label: garbage "abc" → ""', availability: 'abc', expect: '' },
  { name: 'label: garbage 42 → ""', availability: 42, expect: '' },
  { name: 'label: garbage [] → ""', availability: [], expect: '' },
  {
    name: 'label: garbage { "2": { enabled: true, start: "banana" } } → ""',
    availability: { '2': { enabled: true, start: 'banana' } },
    expect: '',
  },
  {
    name: 'label: every day enabled:false → ""',
    availability: { '0': { enabled: false }, '2': { enabled: false } },
    expect: '',
  },
];

// Every label must be ASCII — this string is destined for the Epson thermal
// printer. An en dash slipping into a range would print as garbage.
const asciiCases = labelCases.map(c => ({
  name: `ascii: ${c.name}`,
  availability: c.availability,
}));

let failures = 0;
for (const c of availabilityCases) {
  const got = isCategoryAvailableNow(c.availability, c.now);
  const pass = got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
}
for (const c of labelCases) {
  const got = formatAvailabilityLabel(c.availability);
  const pass = got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected "${c.expect}", got "${got}")`);
}
for (const c of asciiCases) {
  const got = formatAvailabilityLabel(c.availability);
  const pass = /^[\x20-\x7E]*$/.test(got);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (got "${got}")`);
}

const total = availabilityCases.length + labelCases.length + asciiCases.length;
console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
