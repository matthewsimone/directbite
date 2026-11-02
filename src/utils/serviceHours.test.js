// Node-runnable assertions for serviceHours (no test runner required):
//   node src/utils/serviceHours.test.js
//
// serviceHours works in browser-local time (like scheduling.js), so dates here
// are built with the local Date constructor — the assertions hold in any TZ.
//   2026-11-01 = Sunday
//   2026-11-02 = Monday
//   2026-11-05 = Thursday

import {
  MAX_WINDOWS,
  normalizeSchedule,
  scheduleFromHours,
  getEffectiveSchedule,
  getWindowsForDate,
  isOpenAt,
  getNextOpen,
  getDaySpan,
  buildLegacyHoursRows,
} from './serviceHours.js';

const at = (day, h, m = 0, s = 0) => new Date(2026, 10, day, h, m, s);
const SUN = 1;
const MON = 2;
const THU = 5;

// Fixtures. Builds the stored shape { "<dow>": { enabled, windows } }.
function days(dowList, ...windows) {
  const out = {};
  for (const d of dowList) {
    out[String(d)] = { enabled: true, windows: windows.map(([start, end]) => ({ start, end })) };
  }
  return out;
}

// Favale's
const favalePickupRaw = {
  ...days([0], ['16:00', '21:00']),
  '1': { enabled: false, windows: [] },
  ...days([2], ['16:30', '20:30']),
  ...days([3, 4, 5], ['11:30', '15:15'], ['16:30', '20:30']),
  ...days([6], ['16:00', '21:30']),
};
const favaleDeliveryRaw = {
  ...days([0], ['16:00', '21:00']),
  ...days([2, 3, 4, 5], ['17:00', '20:30']),
  ...days([6], ['16:00', '21:30']),
};
const favale = { pickup_schedule: favalePickupRaw, delivery_schedule: favaleDeliveryRaw };
const fPickup = getEffectiveSchedule(favale, [], 'pickup');
const fDelivery = getEffectiveSchedule(favale, [], 'delivery');

// Legacy hours rows (postgres `time` → "HH:MM:SS"). Includes a duplicate
// Tuesday row to prove FIRST-row-wins.
const legacyRows = [
  { day_of_week: 0, is_open: false, open_time: null, close_time: null },
  { day_of_week: 1, is_open: true, open_time: '11:00:00', close_time: '22:00:00' },
  { day_of_week: 2, is_open: true, open_time: '11:00:00', close_time: '22:00:00' },
  { day_of_week: 2, is_open: true, open_time: '05:00:00', close_time: '06:00:00' },
  { day_of_week: 3, is_open: true, open_time: '11:00:00', close_time: '22:00:00' },
  { day_of_week: 4, is_open: true, open_time: '11:00:00', close_time: '22:00:00' },
  { day_of_week: 5, is_open: true, open_time: '11:00:00', close_time: '24:00:00' },
  { day_of_week: 6, is_open: true, open_time: '11:00:00', close_time: '00:00:00' },
];

const fmt = d => (d instanceof Date ? `${d.getDay()}@${d.toTimeString().slice(0, 8)}` : String(d));
const json = v => JSON.stringify(v);

const cases = [
  // Fixture sanity: the calendar dates really are the weekdays named.
  { name: 'fixture: Nov 1 2026 is Sunday', got: at(SUN, 12).getDay(), expect: 0 },
  { name: 'fixture: Nov 2 2026 is Monday', got: at(MON, 12).getDay(), expect: 1 },
  { name: 'fixture: Nov 5 2026 is Thursday', got: at(THU, 12).getDay(), expect: 4 },
  { name: 'MAX_WINDOWS is 2', got: MAX_WINDOWS, expect: 2 },

  // Favale's open/closed
  { name: "Favale's: Thu 15:30 pickup closed", got: isOpenAt(fPickup, at(THU, 15, 30)), expect: false },
  { name: "Favale's: Thu 16:45 pickup open", got: isOpenAt(fPickup, at(THU, 16, 45)), expect: true },
  { name: "Favale's: Thu 16:45 delivery closed", got: isOpenAt(fDelivery, at(THU, 16, 45)), expect: false },
  { name: "Favale's: Thu 17:15 pickup open", got: isOpenAt(fPickup, at(THU, 17, 15)), expect: true },
  { name: "Favale's: Thu 17:15 delivery open", got: isOpenAt(fDelivery, at(THU, 17, 15)), expect: true },
  { name: "Favale's: Thu 12:00 pickup open (lunch window)", got: isOpenAt(fPickup, at(THU, 12)), expect: true },
  { name: "Favale's: Mon 18:00 pickup closed", got: isOpenAt(fPickup, at(MON, 18)), expect: false },
  { name: "Favale's: Mon 18:00 delivery closed", got: isOpenAt(fDelivery, at(MON, 18)), expect: false },
  { name: "Favale's: Mon 12:00 pickup closed", got: isOpenAt(fPickup, at(MON, 12)), expect: false },
  { name: "Favale's: Mon getDaySpan → null", got: getDaySpan([fPickup, fDelivery], at(MON, 12)), expect: null },
  { name: "Favale's: Mon getWindowsForDate pickup → []", got: getWindowsForDate(fPickup, at(MON, 12)).length, expect: 0 },

  // getNextOpen
  { name: "Favale's: getNextOpen pickup from Thu 15:30 → Thu 16:30", got: fmt(getNextOpen(fPickup, at(THU, 15, 30))), expect: '4@16:30:00' },
  { name: "Favale's: getNextOpen pickup from Thu 16:30:00 exactly → strictly after → Fri 11:30", got: fmt(getNextOpen(fPickup, at(THU, 16, 30))), expect: '5@11:30:00' },
  { name: "Favale's: getNextOpen delivery from Sun 22:00 → Tue 17:00 (skips closed Mon)", got: fmt(getNextOpen(fDelivery, at(SUN, 22))), expect: '2@17:00:00' },
  { name: 'getNextOpen: null schedule → null', got: getNextOpen(null, at(THU, 12)), expect: null },
  { name: 'getNextOpen: all-closed schedule → null', got: getNextOpen(normalizeSchedule({}), at(THU, 12)), expect: null },
  {
    name: 'getNextOpen: only-Thursday schedule from Thu 21:00 → next Thursday (daysAhead inclusive)',
    got: (() => { const d = getNextOpen(normalizeSchedule(days([4], ['11:00', '12:00'])), at(THU, 21)); return d && `${d.getDate()} ${fmt(d)}`; })(),
    expect: '12 4@11:00:00',
  },

  // getWindowsForDate
  {
    name: "Favale's: Thu pickup windows",
    got: json(getWindowsForDate(fPickup, at(THU, 9)).map(w => [fmt(w.start), fmt(w.end)])),
    expect: json([['4@11:30:00', '4@15:15:00'], ['4@16:30:00', '4@20:30:00']]),
  },
  {
    name: 'getWindowsForDate: windows land on the given calendar date',
    got: getWindowsForDate(fPickup, at(THU, 9)).every(w => w.start.getDate() === THU && w.end.getDate() === THU),
    expect: true,
  },

  // getDaySpan
  {
    name: "Favale's: getDaySpan Thu (pickup+delivery) → 11:30-20:30",
    got: (() => { const s = getDaySpan([fPickup, fDelivery], at(THU, 9)); return s && `${fmt(s.start)}-${fmt(s.end)}`; })(),
    expect: '4@11:30:00-4@20:30:00',
  },
  {
    name: 'getDaySpan: null schedules ignored',
    got: (() => { const s = getDaySpan([null, fDelivery], at(THU, 9)); return s && `${fmt(s.start)}-${fmt(s.end)}`; })(),
    expect: '4@17:00:00-4@20:30:00',
  },
  { name: 'getDaySpan: all null → null', got: getDaySpan([null, null], at(THU, 9)), expect: null },

  // buildLegacyHoursRows
  {
    name: "Favale's: buildLegacyHoursRows Thu → 11:30:00-20:30:00",
    got: json(buildLegacyHoursRows(fPickup, fDelivery)[4]),
    expect: json({ day_of_week: 4, is_open: true, open_time: '11:30:00', close_time: '20:30:00' }),
  },
  {
    name: "Favale's: buildLegacyHoursRows Mon → closed",
    got: json(buildLegacyHoursRows(fPickup, fDelivery)[1]),
    expect: json({ day_of_week: 1, is_open: false, open_time: null, close_time: null }),
  },
  {
    name: "Favale's: buildLegacyHoursRows Tue → 16:30:00-20:30:00 (pickup start, shared end)",
    got: json(buildLegacyHoursRows(fPickup, fDelivery)[2]),
    expect: json({ day_of_week: 2, is_open: true, open_time: '16:30:00', close_time: '20:30:00' }),
  },
  { name: 'buildLegacyHoursRows: always 7 rows, dow 0..6', got: json(buildLegacyHoursRows(fPickup, null).map(r => r.day_of_week)), expect: json([0, 1, 2, 3, 4, 5, 6]) },

  // Fallbacks
  {
    name: 'pickup_schedule null → falls back to hours rows',
    got: json(getEffectiveSchedule({ pickup_schedule: null, delivery_schedule: null }, legacyRows, 'pickup')),
    expect: json(scheduleFromHours(legacyRows)),
  },
  {
    name: 'delivery_schedule null → equals effective pickup (configured pickup)',
    got: json(getEffectiveSchedule({ pickup_schedule: favalePickupRaw, delivery_schedule: null }, legacyRows, 'delivery')),
    expect: json(normalizeSchedule(favalePickupRaw)),
  },
  {
    name: 'delivery_schedule null + pickup null → equals legacy hours',
    got: json(getEffectiveSchedule({}, legacyRows, 'delivery')),
    expect: json(scheduleFromHours(legacyRows)),
  },
  {
    name: 'invalid pickup_schedule counts as unset → hours rows',
    got: json(getEffectiveSchedule({ pickup_schedule: 'banana' }, legacyRows, 'pickup')),
    expect: json(scheduleFromHours(legacyRows)),
  },
  { name: 'nothing configured and no hours → null (no info)', got: getEffectiveSchedule({}, [], 'pickup'), expect: null },
  { name: 'null restaurant tolerated', got: json(getEffectiveSchedule(null, legacyRows, 'pickup')), expect: json(scheduleFromHours(legacyRows)) },

  // scheduleFromHours
  { name: 'scheduleFromHours: Wed 11:00:00-22:00:00 → HH:MM', got: json(scheduleFromHours(legacyRows)['3']), expect: json([{ start: '11:00', end: '22:00' }]) },
  { name: 'scheduleFromHours: first row per day wins (duplicate Tue)', got: json(scheduleFromHours(legacyRows)['2']), expect: json([{ start: '11:00', end: '22:00' }]) },
  { name: 'scheduleFromHours: is_open false → []', got: json(scheduleFromHours(legacyRows)['0']), expect: '[]' },
  { name: 'scheduleFromHours: close 24:00:00 → 23:59', got: json(scheduleFromHours(legacyRows)['5']), expect: json([{ start: '11:00', end: '23:59' }]) },
  { name: 'scheduleFromHours: close 00:00:00 (<= open, never open today) → []', got: json(scheduleFromHours(legacyRows)['6']), expect: '[]' },
  { name: 'scheduleFromHours: missing open/close → []', got: json(scheduleFromHours([{ day_of_week: 3, is_open: true, open_time: null, close_time: '22:00:00' }])['3']), expect: '[]' },
  { name: 'scheduleFromHours: missing day → []', got: json(scheduleFromHours([{ day_of_week: 3, is_open: true, open_time: '11:00:00', close_time: '22:00:00' }])['4']), expect: '[]' },
  { name: 'scheduleFromHours: [] → null', got: scheduleFromHours([]), expect: null },
  { name: 'scheduleFromHours: undefined → null', got: scheduleFromHours(undefined), expect: null },

  // normalizeSchedule — valid shapes
  {
    name: 'normalize: windows sorted by start',
    got: json(normalizeSchedule({ '3': { enabled: true, windows: [{ start: '16:30', end: '20:30' }, { start: '11:30', end: '15:15' }] } })['3']),
    expect: json([{ start: '11:30', end: '15:15' }, { start: '16:30', end: '20:30' }]),
  },
  { name: 'normalize: absent days → []', got: json(normalizeSchedule({})), expect: json({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }) },
  { name: 'normalize: enabled !== true → [] (even with junk windows)', got: json(normalizeSchedule({ '3': { enabled: 'yes', windows: 'junk' } })['3']), expect: '[]' },
  { name: 'normalize: enabled true + empty windows → []', got: json(normalizeSchedule({ '3': { enabled: true, windows: [] } })['3']), expect: '[]' },
  { name: 'normalize: touching windows allowed', got: json(normalizeSchedule(days([3], ['11:00', '15:00'], ['15:00', '20:00']))['3']), expect: json([{ start: '11:00', end: '15:00' }, { start: '15:00', end: '20:00' }]) },
  { name: 'normalize: stray non-dow key ignored', got: json(normalizeSchedule({ ...days([3], ['11:00', '15:00']), note: 'x' })['3']), expect: json([{ start: '11:00', end: '15:00' }]) },

  // normalizeSchedule — invalid → null (one bad day kills the blob)
  { name: 'invalid: 3 windows → null', got: normalizeSchedule(days([3], ['08:00', '09:00'], ['10:00', '11:00'], ['12:00', '13:00'])), expect: null },
  { name: 'invalid: overlapping windows → null', got: normalizeSchedule(days([3], ['11:00', '15:00'], ['14:00', '20:00'])), expect: null },
  { name: 'invalid: start == end → null', got: normalizeSchedule(days([3], ['11:00', '11:00'])), expect: null },
  { name: 'invalid: start > end → null', got: normalizeSchedule(days([3], ['20:00', '11:00'])), expect: null },
  { name: 'invalid: "25:00" → null', got: normalizeSchedule(days([3], ['11:00', '25:00'])), expect: null },
  { name: 'invalid: "banana" time → null', got: normalizeSchedule(days([3], ['banana', '15:00'])), expect: null },
  { name: 'invalid: "9:00" (not zero-padded) → null', got: normalizeSchedule(days([3], ['9:00', '15:00'])), expect: null },
  { name: 'invalid: "11:00:00" (seconds) → null', got: normalizeSchedule(days([3], ['11:00:00', '15:00'])), expect: null },
  { name: 'invalid: one good day + one bad day → null', got: normalizeSchedule({ ...days([2], ['11:00', '15:00']), ...days([3], ['20:00', '11:00']) }), expect: null },
  { name: 'invalid: windows not an array → null', got: normalizeSchedule({ '3': { enabled: true, windows: { start: '11:00', end: '15:00' } } }), expect: null },
  { name: 'invalid: day entry is a string → null', got: normalizeSchedule({ '3': 'banana' }), expect: null },
  { name: 'invalid: blob is an array → null', got: normalizeSchedule([]), expect: null },
  { name: 'invalid: blob is a string → null', got: normalizeSchedule('banana'), expect: null },
  { name: 'invalid: blob is null → null', got: normalizeSchedule(null), expect: null },
  { name: 'invalid: blob is a number → null', got: normalizeSchedule(42), expect: null },

  // Boundary semantics — match useRestaurant.js: inclusive at open AND close,
  // whole-second resolution.
  { name: 'boundary: Thu 16:29:59 pickup closed', got: isOpenAt(fPickup, at(THU, 16, 29, 59)), expect: false },
  { name: 'boundary: Thu 16:30:00 pickup open (inclusive open)', got: isOpenAt(fPickup, at(THU, 16, 30, 0)), expect: true },
  { name: 'boundary: Thu 20:30:00 pickup open (inclusive close)', got: isOpenAt(fPickup, at(THU, 20, 30, 0)), expect: true },
  { name: 'boundary: Thu 20:30:00.999 pickup open (ms ignored)', got: isOpenAt(fPickup, new Date(2026, 10, THU, 20, 30, 0, 999)), expect: true },
  { name: 'boundary: Thu 20:30:01 pickup closed', got: isOpenAt(fPickup, at(THU, 20, 30, 1)), expect: false },
  { name: 'boundary: Thu 15:15:00 pickup open (lunch close inclusive)', got: isOpenAt(fPickup, at(THU, 15, 15, 0)), expect: true },
  { name: 'boundary: Thu 15:15:01 pickup closed (between windows)', got: isOpenAt(fPickup, at(THU, 15, 15, 1)), expect: false },

  // Null schedule = no info
  { name: 'null schedule: isOpenAt → true', got: isOpenAt(null, at(MON, 3)), expect: true },
  { name: 'null schedule: getWindowsForDate → []', got: getWindowsForDate(null, at(THU, 12)).length, expect: 0 },

  // Type guard
  {
    name: 'getEffectiveSchedule: unknown type throws',
    got: (() => { try { getEffectiveSchedule(favale, [], 'dine_in'); return 'no throw'; } catch { return 'threw'; } })(),
    expect: 'threw',
  },
];

let failures = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${c.got})`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
