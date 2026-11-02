// Parity check: the schedule-based getAvailableTimeSlots / getAvailableDates
// must produce output identical to the pre-service-hours versions for every
// legacy `hours` input (i.e. every restaurant with no pickup/delivery
// schedule configured). Node-runnable, no test runner:
//   TZ=America/New_York node src/utils/scheduling.parity.test.js
//   TZ=UTC node src/utils/scheduling.parity.test.js
//
// "now" is pinned by temporarily replacing the global Date with a subclass
// whose zero-argument constructor (and Date.now) return a fixed instant.
// Both the reference functions below and the real module resolve `Date` from
// the global at call time, so both see the same pinned clock — including the
// "today" paths. Dates are built in local time, so the fixed instants mean
// the same wall-clock time under any TZ.
//
// Known, intentional divergence NOT covered here: a legacy close_time of
// "24:00:00" (serviceHours clamps it to 23:59).

import { getAvailableTimeSlots, getAvailableDates } from './scheduling.js';
import { scheduleFromHours } from './serviceHours.js';

// ---------------------------------------------------------------------------
// Reference: verbatim from `git show main:src/utils/scheduling.js`.
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000

const OPEN_BUFFER_MINUTES = 30

function parseTimeOnDate(date, timeStr) {
  const [h, m] = timeStr.split(':').map(Number)
  const out = new Date(date)
  out.setHours(h, m, 0, 0)
  return out
}

function formatTimeLabel(date) {
  return date
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(' ', '')
}

function formatDateLabel(date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target - today) / DAY_MS)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  return target.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function refGetAvailableTimeSlots(date, hours, { leadTimeMinutes = 30, intervalMinutes = 15 } = {}) {
  if (!hours || hours.length === 0 || !date) return []
  const dow = date.getDay()
  const dayHours = hours.find(h => h.day_of_week === dow)
  if (!dayHours?.is_open || !dayHours.open_time || !dayHours.close_time) return []

  const open = parseTimeOnDate(date, dayHours.open_time)
  const close = parseTimeOnDate(date, dayHours.close_time)
  const earliestOpen = new Date(open.getTime() + OPEN_BUFFER_MINUTES * 60 * 1000)

  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  let cursor
  if (isToday) {
    const earliestNow = new Date(now.getTime() + leadTimeMinutes * 60 * 1000)
    cursor = new Date(Math.max(earliestOpen.getTime(), earliestNow.getTime()))
    const rounded = Math.ceil(cursor.getMinutes() / intervalMinutes) * intervalMinutes
    cursor.setMinutes(rounded, 0, 0)
  } else {
    cursor = new Date(earliestOpen)
  }

  const slots = []
  while (cursor.getTime() <= close.getTime()) {
    slots.push({ value: cursor.toISOString(), label: formatTimeLabel(cursor) })
    cursor = new Date(cursor.getTime() + intervalMinutes * 60 * 1000)
  }
  return slots
}

function refGetAvailableDates(hours, { daysAhead = 7, leadTimeMinutes = 30, intervalMinutes = 15 } = {}) {
  if (!hours || hours.length === 0) return []
  const result = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * DAY_MS)
    const dow = d.getDay()
    const dayHours = hours.find(h => h.day_of_week === dow)
    if (!dayHours?.is_open || !dayHours.open_time || !dayHours.close_time) continue

    const slots = refGetAvailableTimeSlots(d, hours, { leadTimeMinutes, intervalMinutes })
    if (slots.length === 0) continue

    result.push({ date: d, label: formatDateLabel(d), dayOfWeek: dow })
  }
  return result
}
// ---------------------------------------------------------------------------

const RealDate = Date;
function withNow(fixed, fn) {
  const fixedMs = fixed.getTime();
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() { return fixedMs; }
  }
  globalThis.Date = FixedDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

// Fixtures — legacy `hours` rows as postgres returns them ("HH:MM:SS").
const row = (dow, open, close, is_open = true) => ({ day_of_week: dow, is_open, open_time: open, close_time: close });
const ALL = [0, 1, 2, 3, 4, 5, 6];

const fixtures = {
  'normal day (Thu 11-22 only)': [row(4, '11:00:00', '22:00:00')],
  'all days closed': ALL.map(d => row(d, '11:00:00', '22:00:00', false)),
  'null open_time / null close_time': [row(3, null, '22:00:00'), row(4, '11:00:00', null), row(5, null, null)],
  'close <= open': [row(3, '22:00:00', '11:00:00'), row(4, '11:00:00', '11:00:00'), row(5, '18:00:00', '00:00:00')],
  '< 30-min window': [row(4, '11:00:00', '11:20:00'), row(5, '11:00:00', '11:30:00')],
  'duplicate day rows (first wins)': [row(4, '11:00:00', '22:00:00'), row(4, '05:00:00', '06:00:00'), row(5, '05:00:00', '06:00:00', false), row(5, '12:00:00', '20:00:00')],
  'typical week': [
    row(0, '12:00:00', '21:00:00'),
    row(1, '11:00:00', '22:00:00', false),
    row(2, '11:00:00', '22:00:00'),
    row(3, '11:00:00', '22:00:00'),
    row(4, '11:00:00', '22:00:00'),
    row(5, '11:00:00', '23:00:00'),
    row(6, '11:00:00', '23:00:00'),
  ],
  'unaligned minutes (11:10-21:50)': ALL.map(d => row(d, '11:10:00', '21:50:00')),
  'late close 23:59': ALL.map(d => row(d, '16:00:00', '23:59:00')),
  'open early 00:00-02:00': ALL.map(d => row(d, '00:00:00', '02:00:00')),
  'empty rows': [],
};

// Fixed "now" instants (local wall-clock). 2026-11-05 is a Thursday.
// 2026-10-30 (Fri) puts the 7-day walk across the Nov 1 DST fall-back, where
// the legacy `today + i * DAY_MS` walk repeats a date — parity must hold there too.
const nows = {
  'Thu 08:00 (before open)': new RealDate(2026, 10, 5, 8, 0, 0),
  'Thu 13:07:23 (mid-day)': new RealDate(2026, 10, 5, 13, 7, 23),
  'Thu 21:40 (near close)': new RealDate(2026, 10, 5, 21, 40, 0),
  'Thu 23:30 (after close)': new RealDate(2026, 10, 5, 23, 30, 0),
  'Fri 00:05 (just past midnight)': new RealDate(2026, 10, 6, 0, 5, 0),
  'Fri 2026-10-30 12:00 (walk crosses DST fall-back)': new RealDate(2026, 9, 30, 12, 0, 0),
};

const leads = [30, 45, 60];

const serializeDates = list => JSON.stringify(list.map(d => ({ date: d.date.toISOString(), label: d.label, dayOfWeek: d.dayOfWeek })));

let total = 0;
let failures = 0;
function check(name, got, expect) {
  total++;
  if (got === expect) return;
  failures++;
  console.log(`FAIL  ${name}\n  expected ${expect}\n  got      ${got}`);
}

for (const [fName, rows] of Object.entries(fixtures)) {
  const schedule = scheduleFromHours(rows);
  let fixtureChecks = 0;
  const before = total;
  for (const [nName, now] of Object.entries(nows)) {
    for (const lead of leads) {
      withNow(now, () => {
        const opts = { leadTimeMinutes: lead };
        const ref = serializeDates(refGetAvailableDates(rows, opts));
        check(`${fName} | ${nName} | lead ${lead} | dates(rows)`, serializeDates(getAvailableDates(rows, opts)), ref);
        check(`${fName} | ${nName} | lead ${lead} | dates(schedule)`, serializeDates(getAvailableDates(schedule, opts)), ref);

        // Slots for each of the next 7 calendar days (midnight, like the
        // date walk passes) plus "now" itself (today, mid-day Date).
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const probeDates = [new Date()];
        for (let i = 0; i < 7; i++) {
          const d = new Date(midnight);
          d.setDate(d.getDate() + i);
          probeDates.push(d);
        }
        for (const d of probeDates) {
          const refSlots = JSON.stringify(refGetAvailableTimeSlots(d, rows, opts));
          check(`${fName} | ${nName} | lead ${lead} | slots(rows) ${d.toDateString()}`, JSON.stringify(getAvailableTimeSlots(d, rows, opts)), refSlots);
          check(`${fName} | ${nName} | lead ${lead} | slots(schedule) ${d.toDateString()}`, JSON.stringify(getAvailableTimeSlots(d, schedule, opts)), refSlots);
        }
      });
    }
  }
  fixtureChecks = total - before;
  console.log(`checked  ${fName}  (${fixtureChecks} comparisons)`);
}

// Guard against a vacuous pass: the fixtures must actually produce slots.
const nonEmpty = withNow(nows['Thu 08:00 (before open)'], () => refGetAvailableDates(fixtures['typical week']).length);
check('sanity: typical week yields bookable dates', String(nonEmpty > 0), 'true');
// And the Date override must really pin "now".
check('sanity: Date override pins now', withNow(nows['Thu 08:00 (before open)'], () => new Date().getHours()), 8);

console.log(`\n${total - failures}/${total} passed  (TZ=${process.env.TZ || 'system default'})`);
process.exit(failures ? 1 : 0);
