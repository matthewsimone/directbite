// Node-runnable assertions for the split-hours editor helpers and the Uber
// Direct schedule defaults (no test runner required):
//   TZ=America/New_York node src/pages/tablet/hoursDraft.test.js
//   TZ=UTC node src/pages/tablet/hoursDraft.test.js
//
// PARITY: bufferBeforeClose / defaultsFromHours below are copied verbatim
// from `git show main:src/pages/tablet/SettingsTab.jsx` (lines 17-26 and
// 141-165), and refSaveHoursWrites reduces main's saveHours loop (lines
// 304-333) to the values it writes. Unconfigured restaurants must match them.
// Nothing here reads the clock.

import {
  draftFromRows,
  initialDrafts,
  hasSecondWindow,
  draftToStored,
  legacyRowsFromDraft,
  validateDraft,
  planHoursWrites,
  bufferBeforeClose,
  defaultsFromHours,
  defaultsFromSchedule,
  uberScheduleDefaults,
  configuredDaySeed,
} from './hoursDraft.js';
import { normalizeSchedule, buildLegacyHoursRows, getEffectiveSchedule } from '../../utils/serviceHours.js';

// ---------------------------------------------------------------------------
// Reference: verbatim from main (renamed ref*).
// ---------------------------------------------------------------------------
const UBER_SCHEDULE_CLOSE_BUFFER_MIN = 30
function refBufferBeforeClose(hhmm, bufferMin = UBER_SCHEDULE_CLOSE_BUFFER_MIN) {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  let total = h * 60 + m - bufferMin
  if (total < 0) total = 0
  const bh = String(Math.floor(total / 60)).padStart(2, '0')
  const bm = String(total % 60).padStart(2, '0')
  return `${bh}:${bm}`
}

function refDefaultsFromHours(hoursArray, fallback) {
  if (!hoursArray || hoursArray.length === 0) return fallback
  const result = {}
  for (let dow = 0; dow <= 6; dow++) {
    const dayHours = hoursArray.find(h => h.day_of_week === dow)
    if (dayHours?.is_open && dayHours.open_time && dayHours.close_time) {
      const start = dayHours.open_time.slice(0, 5)
      const close = dayHours.close_time.slice(0, 5)
      const buffered = refBufferBeforeClose(close)
      result[String(dow)] = {
        enabled: true,
        start,
        end: buffered > start ? buffered : close,
      }
    } else {
      result[String(dow)] = { enabled: false }
    }
  }
  return result
}

// main's saveHours: for each editor row, update by id or insert.
function refSaveHoursWrites(rows) {
  return rows.map(h => (h.id
    ? { type: 'update', id: h.id, values: { is_open: h.is_open, open_time: h.open_time, close_time: h.close_time } }
    : { type: 'insert', values: { day_of_week: h.day_of_week, is_open: h.is_open, open_time: h.open_time, close_time: h.close_time } }))
}

// main's day-toggle seed (SettingsTab.jsx 587-596), reduced to { start, end }.
function refDaySeed(hours, dayIndex) {
  const dayHours = hours?.find(h => h.day_of_week === dayIndex)
  if (dayHours?.is_open && dayHours.open_time && dayHours.close_time) {
    return { start: dayHours.open_time.slice(0, 5), end: dayHours.close_time.slice(0, 5) }
  }
  return { start: '11:00', end: '22:00' }
}
// ---------------------------------------------------------------------------

const FALLBACK = { fallback: true };
let id = 0;
const row = (dow, open, close, is_open = true) => ({ id: `r${++id}`, day_of_week: dow, is_open, open_time: open, close_time: close });
const ALL = [0, 1, 2, 3, 4, 5, 6];

// main's fetchHours synthesized these (no ids) when the table was empty.
const synthesized = ALL.map(i => ({ day_of_week: i, is_open: false, open_time: '09:00', close_time: '21:00', restaurant_id: 'x' }));

const fixtures = {
  'empty': [],
  'synthesized closed week (no ids)': synthesized,
  'typical week': [
    row(0, '12:00:00', '21:00:00'),
    row(1, '11:00:00', '22:00:00', false),
    row(2, '11:00:00', '22:00:00'),
    row(3, '11:00:00', '22:00:00'),
    row(4, '11:00:00', '22:00:00'),
    row(5, '11:00:00', '23:00:00'),
    row(6, '11:00:00', '23:00:00'),
  ],
  'missing days': [row(2, '11:00:00', '22:00:00'), row(4, '16:00:00', '21:00:00')],
  'is_open with null times': [row(3, null, '22:00:00'), row(4, '11:00:00', null), row(5, null, null)],
  'close <= open': [row(3, '22:00:00', '11:00:00'), row(4, '11:00:00', '11:00:00'), row(5, '18:00:00', '00:00:00')],
  'HH:MM (no seconds)': ALL.map(d => row(d, '10:30', '20:45')),
  'close inside buffer (11:00-11:20)': [row(4, '11:00:00', '11:20:00')],
  'close 00:15': [row(4, '00:00:00', '00:15:00')],
  'closed rows keep old times': [row(1, '07:00:00', '15:00:00', false), row(2, '11:00:00', '22:00:00')],
};

const unconfigured = {
  'restaurant omitted': undefined,
  'null schedules': { pickup_schedule: null, delivery_schedule: null },
  'invalid blobs': { pickup_schedule: 'banana', delivery_schedule: [] },
};

let total = 0;
let failures = 0;
function check(name, got, expect) {
  total++;
  const g = JSON.stringify(got);
  const e = JSON.stringify(expect);
  if (g === e) return;
  failures++;
  console.log(`FAIL  ${name}\n  expected ${e}\n  got      ${g}`);
}

// 1. The moved functions are unchanged.
for (const t of ['00:00', '00:15', '00:30', '11:20', '21:00', '23:59', 'banana', '7:5']) {
  check(`bufferBeforeClose("${t}") = main`, bufferBeforeClose(t), refBufferBeforeClose(t));
}
for (const [fName, rows] of Object.entries(fixtures)) {
  check(`defaultsFromHours = main | ${fName}`, defaultsFromHours(rows, FALLBACK), refDefaultsFromHours(rows, FALLBACK));
}

// 2-4. Unconfigured parity: Uber defaults (flag off and on), day seed, round trip.
for (const [fName, rows] of Object.entries(fixtures)) {
  // Flag off: legacyHoursView = the editor's `hours` state (main's fetchHours
  // substitutes the synthesized week when the table is empty).
  const editorRows = rows.length > 0 ? rows : synthesized;
  const dbRows = rows === synthesized ? [] : rows;
  const draftRows = legacyRowsFromDraft(draftFromRows(dbRows));
  for (const [rName, r] of Object.entries(unconfigured)) {
    const ref = refDefaultsFromHours(editorRows, FALLBACK);
    check(`uber defaults, flag off | ${fName} | ${rName}`, uberScheduleDefaults(r, dbRows, editorRows, FALLBACK), ref);
    check(`uber defaults, flag on  | ${fName} | ${rName}`, uberScheduleDefaults(r, dbRows, draftRows, FALLBACK), ref);
    for (const dow of ALL) {
      check(`day seed null (falls to legacy) | ${fName} | ${rName} | dow ${dow}`, configuredDaySeed(r, dbRows, dow), null);
      check(`legacy day seed, flag on = main | ${fName} | ${rName} | dow ${dow}`, refDaySeed(draftRows, dow), refDaySeed(editorRows, dow));
    }
    check(`initialDrafts unconfigured → sameAsPickup | ${fName} | ${rName}`, initialDrafts(r, dbRows).sameAsPickup, true);
  }
  // Round trip: every stored day reads back with the same values.
  const back = legacyRowsFromDraft(draftFromRows(rows));
  for (const dow of ALL) {
    const h = rows.find(x => x.day_of_week === dow);
    if (!h) continue;
    const b = back.find(x => x.day_of_week === dow);
    check(`round trip | ${fName} | dow ${dow}`,
      { is_open: b.is_open, open_time: b.open_time, close_time: b.close_time },
      { is_open: h.is_open, open_time: h.open_time, close_time: h.close_time });
  }

  // 5. Simple-save write plan (flag on, preserveClosedTimes) vs main's saveHours.
  //    Open days: identical update. Closed days: is_open only (times kept).
  //    Days with no row: inserted with full values.
  const plan = planHoursWrites(legacyRowsFromDraft(draftFromRows(dbRows)), dbRows, { preserveClosedTimes: true });
  const refByDow = new Map(refSaveHoursWrites(dbRows).map((op, i) => [dbRows[i].day_of_week, op]));
  for (const op of plan) {
    const dow = op.type === 'update' ? dbRows.find(h => h.id === op.id).day_of_week : op.values.day_of_week;
    const existing = dbRows.find(h => h.day_of_week === dow);
    if (!existing) {
      check(`simple save inserts missing day | ${fName} | dow ${dow}`, op.type, 'insert');
      continue;
    }
    if (existing.is_open) {
      check(`simple save, open day = main update | ${fName} | dow ${dow}`, op, refByDow.get(dow));
    } else {
      check(`simple save, closed day → is_open only | ${fName} | dow ${dow}`, op, { type: 'update', id: existing.id, values: { is_open: false } });
    }
  }
}

// ---- Configured: Favale's --------------------------------------------------
const w = (...pairs) => pairs.map(([start, end]) => ({ start, end }));
const favPickupRaw = {
  '0': { enabled: true, windows: w(['16:00', '21:00']) },
  '1': { enabled: false, windows: [] },
  '2': { enabled: true, windows: w(['16:30', '20:30']) },
  '3': { enabled: true, windows: w(['11:30', '15:15'], ['16:30', '20:30']) },
  '4': { enabled: true, windows: w(['11:30', '15:15'], ['16:30', '20:30']) },
  '5': { enabled: true, windows: w(['11:30', '15:15'], ['16:30', '20:30']) },
  '6': { enabled: true, windows: w(['16:00', '21:30']) },
};
const favDeliveryRaw = {
  '0': { enabled: true, windows: w(['16:00', '21:00']) },
  '2': { enabled: true, windows: w(['17:00', '20:30']) },
  '3': { enabled: true, windows: w(['17:00', '20:30']) },
  '4': { enabled: true, windows: w(['17:00', '20:30']) },
  '5': { enabled: true, windows: w(['17:00', '20:30']) },
  '6': { enabled: true, windows: w(['16:00', '21:30']) },
};
const favale = { pickup_schedule: favPickupRaw, delivery_schedule: favDeliveryRaw };
const favRows = fixtures['typical week'];

// 6. Configured-mode mirror: closed days update is_open only.
const mirror = planHoursWrites(
  buildLegacyHoursRows(normalizeSchedule(favPickupRaw), normalizeSchedule(favDeliveryRaw)),
  favRows,
  { preserveClosedTimes: true },
);
check("Favale's mirror: Mon (closed) → is_open only", mirror[1], { type: 'update', id: favRows[1].id, values: { is_open: false } });
check("Favale's mirror: Thu → 11:30:00-20:30:00", mirror[4],
  { type: 'update', id: favRows[4].id, values: { is_open: true, open_time: '11:30:00', close_time: '20:30:00' } });
check("Favale's mirror: missing row inserted with full values",
  planHoursWrites(buildLegacyHoursRows(normalizeSchedule(favPickupRaw), normalizeSchedule(favDeliveryRaw)), [], { preserveClosedTimes: true })[1],
  { type: 'insert', values: { day_of_week: 1, is_open: false, open_time: null, close_time: null } });

// 7. Configured Uber defaults + day seed.
const favDefaults = uberScheduleDefaults(favale, favRows, favRows, FALLBACK);
check("Favale's Uber default Thu (delivery 17:00-20:30 − 30)", favDefaults['4'], { enabled: true, start: '17:00', end: '20:00' });
check("Favale's Uber default Mon → disabled", favDefaults['1'], { enabled: false });
check('delivery null → pickup span 11:30 → 20:30 − 30',
  uberScheduleDefaults({ pickup_schedule: favPickupRaw, delivery_schedule: null }, [], [], FALLBACK)['4'],
  { enabled: true, start: '11:30', end: '20:00' });
check('defaultsFromSchedule(null) → fallback', defaultsFromSchedule(null, FALLBACK), FALLBACK);
check("Favale's day seed Thu → 17:00-20:30 (no buffer)", configuredDaySeed(favale, favRows, 4), { start: '17:00', end: '20:30' });
check("Favale's day seed Mon (closed) → null", configuredDaySeed(favale, favRows, 1), null);

// initialDrafts for a configured restaurant.
const favDrafts = initialDrafts(favale, favRows);
check("Favale's drafts: sameAsPickup false", favDrafts.sameAsPickup, false);
check("Favale's drafts: Thu pickup has 2 windows", favDrafts.pickup['4'].windows.length, 2);
check("Favale's drafts: round trip to stored = normalized pickup",
  normalizeSchedule(draftToStored(favDrafts.pickup)), getEffectiveSchedule(favale, favRows, 'pickup'));
check('configured, delivery null → sameAsPickup true',
  initialDrafts({ pickup_schedule: favPickupRaw, delivery_schedule: null }, favRows).sameAsPickup, true);

// 8. Save-mode selection.
const simple = draftFromRows(favRows);
check('hasSecondWindow: legacy rows → false', hasSecondWindow(simple), false);
check("hasSecondWindow: Favale's → true", hasSecondWindow(favDrafts.pickup), true);
const closedSecond = draftFromRows(favRows);
closedSecond['1'] = { open: false, windows: w(['09:00', '10:00'], ['11:00', '12:00']) };
check('hasSecondWindow: second window on a CLOSED day ignored', hasSecondWindow(closedSecond), false);

// 9. Validation messages.
const one = (dow, open, ...pairs) => {
  const d = draftFromRows([]);
  d[String(dow)] = { open, windows: w(...pairs) };
  return d;
};
check('valid single window → null', validateDraft(one(4, true, ['11:00', '22:00']), 'Pickup'), null);
check('valid two windows → null', validateDraft(one(4, true, ['11:30', '15:15'], ['16:30', '20:30']), 'Pickup'), null);
check('touching windows allowed → null', validateDraft(one(4, true, ['11:00', '15:00'], ['15:00', '20:00']), 'Pickup'), null);
check('overlap', validateDraft(one(4, true, ['11:00', '15:00'], ['14:00', '20:00']), 'Pickup'), 'Pickup – Thursday: the two windows overlap.');
check('start >= end (single)', validateDraft(one(4, true, ['22:00', '11:00']), 'Pickup'), 'Pickup – Thursday: the window must end after it starts.');
check('start >= end (second window)', validateDraft(one(4, true, ['11:00', '15:00'], ['18:00', '17:00']), 'Delivery'), 'Delivery – Thursday: the second window must end after it starts.');
check('midnight close', validateDraft(one(4, true, ['18:00', '00:00']), 'Pickup'), "Pickup – Thursday: closing at midnight isn't supported. Use 11:59 PM.");
check('missing time', validateDraft(one(4, true, [null, '22:00']), 'Pickup'), 'Pickup – Thursday: set both times.');
check('legacy HH:MM:SS accepted', validateDraft(draftFromRows(favRows), 'Pickup'), null);
check('closed day with bad times passes', validateDraft(one(4, false, ['22:00', '11:00']), 'Pickup'), null);

console.log(`\n${total - failures}/${total} passed  (TZ=${process.env.TZ || 'system default'})`);
process.exit(failures ? 1 : 0);
