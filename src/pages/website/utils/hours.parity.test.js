// Parity + behavior checks for the website hours utilities. Node-runnable,
// no test runner:
//   TZ=America/New_York node src/pages/website/utils/hours.parity.test.js
//   TZ=UTC node src/pages/website/utils/hours.parity.test.js
//
// PARITY: for unconfigured restaurants (and when the restaurant is omitted),
// getStatus / formatWeekHours / getDisplayDays must match the pre-service-hours
// code copied below from `git show main:src/pages/website/utils/hours.js`
// (getStatus, formatWeekHours) and from main's HoursModal / Footer row loops.
//
// No clock pinning is needed: getStatus takes `now` as a parameter, and
// formatWeekHours / getDisplayDays don't read the clock. Dates are built in
// local time, so the fixed instants mean the same wall-clock time in any TZ.
// 2026-11-05 = Thursday.

import {
  getStatus,
  formatWeekHours,
  getDisplayDays,
  getWebsiteSchedules,
  isServiceConfigured,
} from './hours.js';

// ---------------------------------------------------------------------------
// Reference: verbatim from main (exports renamed ref*).
// ---------------------------------------------------------------------------
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function refFormatTime(hhmm) {
  if (!hhmm) return ''
  const [hStr, mStr] = hhmm.split(':')
  const h = parseInt(hStr, 10)
  const m = parseInt(mStr, 10)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, '0')}${ampm}`
}

function toMinutes(t) {
  if (!t) return null
  const [h, m] = t.split(':')
  return parseInt(h, 10) * 60 + parseInt(m, 10)
}

function refGetStatus(hours, now = new Date()) {
  const today = now.getDay()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const todayHours = (hours || []).find(h => h.day_of_week === today)

  if (todayHours?.is_open && todayHours.open_time && todayHours.close_time) {
    const openMin = toMinutes(todayHours.open_time)
    const closeMin = toMinutes(todayHours.close_time)
    if (nowMin >= openMin && nowMin <= closeMin) {
      return {
        isOpen: true,
        statusText: `OPEN ${refFormatTime(todayHours.open_time)}-${refFormatTime(todayHours.close_time)}`,
        todaysHours: { open: todayHours.open_time, close: todayHours.close_time },
      }
    }
    if (nowMin < openMin) {
      return {
        isOpen: false,
        statusText: `CLOSED · Opens at ${refFormatTime(todayHours.open_time)}`,
        todaysHours: { open: todayHours.open_time, close: todayHours.close_time },
      }
    }
  }

  for (let i = 1; i <= 7; i++) {
    const checkDay = (today + i) % 7
    const h = (hours || []).find(hr => hr.day_of_week === checkDay)
    if (h?.is_open && h.open_time) {
      const dayLabel = i === 1 ? 'Tomorrow' : DAY_ABBR[checkDay]
      return {
        isOpen: false,
        statusText: `CLOSED · Opens at ${refFormatTime(h.open_time)} ${dayLabel}`,
        todaysHours: todayHours?.is_open
          ? { open: todayHours.open_time, close: todayHours.close_time }
          : null,
      }
    }
  }

  return { isOpen: false, statusText: 'CLOSED', todaysHours: null }
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

function refFormatWeekHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0) return ''
  const byDay = {}
  for (const h of hours) byDay[h.day_of_week] = h

  const days = WEEK_ORDER.map((dow) => {
    const h = byDay[dow]
    const label = h && h.is_open && h.open_time && h.close_time
      ? `${refFormatTime(h.open_time)} – ${refFormatTime(h.close_time)}`
      : 'Closed'
    return { dow, label }
  })

  const parts = []
  let i = 0
  while (i < days.length) {
    let j = i
    while (j + 1 < days.length && days[j + 1].label === days[i].label) j++
    const startAbbr = DAY_ABBR[days[i].dow]
    const endAbbr = DAY_ABBR[days[j].dow]
    const dayPart = i === j ? startAbbr : `${startAbbr}–${endAbbr}`
    parts.push(`${dayPart} ${days[i].label}`)
    i = j + 1
  }
  return parts.join(', ')
}

// main's HoursModal DISPLAY_ORDER / Footer DAY_ROWS loop (both Mon→Sun, same
// per-day text), reduced to { dow, text }.
function refDisplayRows(hours) {
  return [1, 2, 3, 4, 5, 6, 0].map(idx => {
    const h = (hours || []).find(hr => hr.day_of_week === idx)
    const closed = !h?.is_open || !h.open_time || !h.close_time
    return { dow: idx, text: closed ? 'Closed' : `${refFormatTime(h.open_time)} - ${refFormatTime(h.close_time)}` }
  })
}
// ---------------------------------------------------------------------------

const at = (day, h, m = 0, s = 0) => new Date(2026, 10, day, h, m, s);
const MON = 2, TUE = 3, THU = 5, SAT = 7;

const row = (dow, open, close, is_open = true) => ({ day_of_week: dow, is_open, open_time: open, close_time: close });
const ALL = [0, 1, 2, 3, 4, 5, 6];

const fixtures = {
  'typical week': [
    row(0, '12:00:00', '21:00:00'),
    row(1, '11:00:00', '22:00:00', false),
    row(2, '11:00:00', '22:00:00'),
    row(3, '11:00:00', '22:00:00'),
    row(4, '11:00:00', '22:00:00'),
    row(5, '11:00:00', '23:00:00'),
    row(6, '11:00:00', '23:00:00'),
  ],
  'only Thursday': [row(4, '11:00:00', '22:00:00')],
  'all closed': ALL.map(d => row(d, '11:00:00', '22:00:00', false)),
  'null times': [row(3, null, '22:00:00'), row(4, '11:00:00', null), row(5, null, null)],
  'close <= open': [row(3, '22:00:00', '11:00:00'), row(4, '11:00:00', '11:00:00'), row(5, '18:00:00', '00:00:00')],
  'duplicate rows': [row(4, '11:00:00', '22:00:00'), row(4, '05:00:00', '06:00:00'), row(5, '12:00:00', '20:00:00')],
  'unaligned minutes': ALL.map(d => row(d, '11:10:00', '21:50:00')),
  'empty': [],
};

const nows = [
  at(THU, 8, 0), at(THU, 10, 59, 59), at(THU, 11, 0, 0), at(THU, 13, 7, 23),
  at(THU, 22, 0, 0), at(THU, 22, 0, 59), at(THU, 22, 1, 0), at(THU, 23, 30),
  at(MON, 12, 0), at(SAT, 23, 59, 59), at(6, 0, 5),
];

// Restaurant shapes that must all take the legacy path with is_open true.
const unconfigured = {
  'restaurant omitted': undefined,
  'null schedules': { is_open: true, delivery_available: true, pickup_schedule: null, delivery_schedule: null },
  'invalid schedule blobs': { is_open: true, delivery_available: true, pickup_schedule: 'banana', delivery_schedule: [] },
};

let total = 0;
let failures = 0;
function check(name, got, expect) {
  total++;
  const g = typeof got === 'string' ? got : JSON.stringify(got);
  const e = typeof expect === 'string' ? expect : JSON.stringify(expect);
  if (g === e) return;
  failures++;
  console.log(`FAIL  ${name}\n  expected ${e}\n  got      ${g}`);
}

// ---- Parity ---------------------------------------------------------------
for (const [fName, hours] of Object.entries(fixtures)) {
  const before = total;
  for (const [rName, restaurant] of Object.entries(unconfigured)) {
    for (const now of nows) {
      check(`parity getStatus | ${fName} | ${rName} | ${now.toString().slice(0, 24)}`,
        getStatus(hours, now, restaurant), refGetStatus(hours, now));
    }
    check(`parity formatWeekHours | ${fName} | ${rName}`, formatWeekHours(hours, restaurant), refFormatWeekHours(hours));
    check(`parity displayDays | ${fName} | ${rName}`,
      getDisplayDays(restaurant, hours).map(d => ({ dow: d.dow, text: d.windows.length ? d.windows[0] : 'Closed' })),
      refDisplayRows(hours));
    check(`parity displayDays single window | ${fName} | ${rName}`,
      getDisplayDays(restaurant, hours).every(d => d.windows.length <= 1), true);
    check(`parity showDeliveryTab false | ${fName} | ${rName}`, getWebsiteSchedules(restaurant, hours).showDeliveryTab, false);
  }
  // Two-argument call (no restaurant param at all) — the old signature.
  for (const now of nows) {
    check(`parity getStatus 2-arg | ${fName} | ${now.toString().slice(0, 24)}`, getStatus(hours, now), refGetStatus(hours, now));
  }
  check(`parity formatWeekHours 1-arg | ${fName}`, formatWeekHours(hours), refFormatWeekHours(hours));
  console.log(`checked  ${fName}  (${total - before} comparisons)`);
}

// ---- Admin "Pause Ordering" (is_open false) ------------------------------
const typical = fixtures['typical week'];
const paused = { is_open: false, delivery_available: true, pickup_schedule: null, delivery_schedule: null };
check('paused unconfigured: mid-day Thu → CLOSED', getStatus(typical, at(THU, 13), paused).statusText, 'CLOSED');
check('paused unconfigured: isOpen false', getStatus(typical, at(THU, 13), paused).isOpen, false);
check('paused unconfigured: todaysHours as legacy path computes it',
  getStatus(typical, at(THU, 13), paused).todaysHours, refGetStatus(typical, at(THU, 13)).todaysHours);
check('paused unconfigured: before open → plain CLOSED (no "Opens at")', getStatus(typical, at(THU, 8), paused).statusText, 'CLOSED');

// ---- Configured: Favale's --------------------------------------------------
const w = (...pairs) => pairs.map(([start, end]) => ({ start, end }));
const favale = {
  is_open: true,
  delivery_available: true,
  pickup_schedule: {
    '0': { enabled: true, windows: w(['16:00', '21:00']) },
    '1': { enabled: false, windows: [] },
    '2': { enabled: true, windows: w(['16:30', '20:30']) },
    '3': { enabled: true, windows: w(['11:30', '15:15'], ['16:30', '20:30']) },
    '4': { enabled: true, windows: w(['11:30', '15:15'], ['16:30', '20:30']) },
    '5': { enabled: true, windows: w(['11:30', '15:15'], ['16:30', '20:30']) },
    '6': { enabled: true, windows: w(['16:00', '21:30']) },
  },
  delivery_schedule: {
    '0': { enabled: true, windows: w(['16:00', '21:00']) },
    '2': { enabled: true, windows: w(['17:00', '20:30']) },
    '3': { enabled: true, windows: w(['17:00', '20:30']) },
    '4': { enabled: true, windows: w(['17:00', '20:30']) },
    '5': { enabled: true, windows: w(['17:00', '20:30']) },
    '6': { enabled: true, windows: w(['16:00', '21:30']) },
  },
};
const st = (now, r = favale, hours = []) => getStatus(hours, now, r).statusText;

check('configured: isServiceConfigured', isServiceConfigured(favale), true);
check("Favale's: Thu 12:00 → OPEN lunch window", st(at(THU, 12)), 'OPEN 11:30am-3:15pm');
check("Favale's: Thu 15:30 → CLOSED · Opens at 4:30pm (same day)", st(at(THU, 15, 30)), 'CLOSED · Opens at 4:30pm');
check("Favale's: Thu 16:45 → OPEN 4:30pm-8:30pm (pickup only)", st(at(THU, 16, 45)), 'OPEN 4:30pm-8:30pm');
check("Favale's: Thu 17:15 → OPEN 4:30pm-8:30pm (both; merged)", st(at(THU, 17, 15)), 'OPEN 4:30pm-8:30pm');
check("Favale's: Thu 20:30:00 → OPEN (inclusive close)", getStatus([], at(THU, 20, 30, 0), favale).isOpen, true);
check("Favale's: Thu 20:30:01 → CLOSED · Opens at 11:30am Tomorrow", st(at(THU, 20, 30, 1)), 'CLOSED · Opens at 11:30am Tomorrow');
check("Favale's: Mon 12:00 → CLOSED · Opens at 4:30pm Tomorrow", st(at(MON, 12)), 'CLOSED · Opens at 4:30pm Tomorrow');
check("Favale's: Sat 23:00 → CLOSED · Opens at 4pm Tomorrow", st(at(SAT, 23)), 'CLOSED · Opens at 4pm Tomorrow');
check("Favale's: Sun 22:00 → CLOSED · Opens at 4:30pm Tue", st(new Date(2026, 10, 8, 22)), 'CLOSED · Opens at 4:30pm Tue');
check("Favale's: Thu todaysHours = day span 11:30-20:30", getStatus([], at(THU, 9), favale).todaysHours, { open: '11:30', close: '20:30' });

// Delivery-only window counts only when delivery is offered.
const deliveryLate = {
  is_open: true,
  pickup_schedule: { '4': { enabled: true, windows: w(['11:00', '14:00']) } },
  delivery_schedule: { '4': { enabled: true, windows: w(['17:00', '21:00']) } },
};
check('delivery window, delivery_available true → OPEN', st(at(THU, 18), { ...deliveryLate, delivery_available: true }), 'OPEN 5pm-9pm');
check('delivery window, delivery_available false → CLOSED',
  getStatus([], at(THU, 18), { ...deliveryLate, delivery_available: false }).isOpen, false);

// Paused configured restaurant.
check('paused configured: Thu 17:15 → CLOSED', st(at(THU, 17, 15), { ...favale, is_open: false }), 'CLOSED');
check('paused configured: todaysHours kept',
  getStatus([], at(THU, 17, 15), { ...favale, is_open: false }).todaysHours, { open: '11:30', close: '20:30' });

// formatWeekHours — pickup schedule, windows joined with " & ".
check("Favale's: formatWeekHours", formatWeekHours([], favale),
  'Mon Closed, Tue 4:30pm – 8:30pm, Wed–Fri 11:30am – 3:15pm & 4:30pm – 8:30pm, Sat 4pm – 9:30pm, Sun 4pm – 9pm');

// Display days.
const dd = (r, service) => getDisplayDays(r, [], service);
check("Favale's: display days Mon→Sun order", dd(favale).map(d => d.dow), [1, 2, 3, 4, 5, 6, 0]);
check("Favale's: Thu pickup windows stacked", dd(favale, 'pickup')[3].windows, ['11:30am - 3:15pm', '4:30pm - 8:30pm']);
check("Favale's: Thu delivery window", dd(favale, 'delivery')[3].windows, ['5pm - 8:30pm']);
check("Favale's: Mon closed → []", dd(favale, 'pickup')[0].windows, []);
check("Favale's: showDeliveryTab true", getWebsiteSchedules(favale, []).showDeliveryTab, true);
check("Favale's: showDeliveryTab false when delivery not offered",
  getWebsiteSchedules({ ...favale, delivery_available: false }, []).showDeliveryTab, false);
check("configured, delivery_schedule null → no tab (delivery = pickup)",
  getWebsiteSchedules({ ...favale, delivery_schedule: null }, []).showDeliveryTab, false);
check('configured via delivery only, no hours → pickup null → formatWeekHours ""',
  formatWeekHours([], { is_open: true, delivery_available: true, delivery_schedule: favale.delivery_schedule }), '');

console.log(`\n${total - failures}/${total} passed  (TZ=${process.env.TZ || 'system default'})`);
process.exit(failures ? 1 : 0);
