// Per-service (pickup / delivery) opening hours. Pure — no React, no
// Supabase — so it imports cleanly from Node for the test file.
//
// Stored shape on restaurants.pickup_schedule / restaurants.delivery_schedule
// (migration 097). Day keys are STRINGS "0".."6", 0 = Sunday — the same
// convention as uber_schedule and menu_categories.availability:
//   { "3": { "enabled": true, "windows": [ { "start": "11:30", "end": "15:15" },
//                                           { "start": "16:30", "end": "20:30" } ] } }
//
// Everything below works on the NORMALIZED shape:
//   { "0": [{ start: "HH:MM", end: "HH:MM" }, ...], ..., "6": [] }   (closed day = [])
// A null schedule means "no info" (nothing configured and no legacy hours):
// isOpenAt → true, getWindowsForDate → [], getDaySpan ignores it. That matches
// useOrderPolling.isRestaurantOpen, where empty hours = open.
//
// Times are browser-local Dates, matching src/utils/scheduling.js.

export const MAX_WINDOWS = 2

const DOW_KEYS = ['0', '1', '2', '3', '4', '5', '6']

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// "HH:MM" (24h) → minutes since midnight; anything else → null.
function parseHHMM(value) {
  if (typeof value !== 'string') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function minutesToHHMM(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function emptySchedule() {
  const out = {}
  for (const k of DOW_KEYS) out[k] = []
  return out
}

// Validate one day's raw windows. Returns sorted [{start,end}] or null if
// anything is wrong. Touching windows (end === next start) are allowed;
// only a true overlap (next start < previous end) is rejected.
function normalizeWindows(rawWindows) {
  if (!Array.isArray(rawWindows)) return null
  if (rawWindows.length > MAX_WINDOWS) return null
  const parsed = []
  for (const w of rawWindows) {
    if (!isPlainObject(w)) return null
    const start = parseHHMM(w.start)
    const end = parseHHMM(w.end)
    if (start === null || end === null) return null
    if (start >= end) return null
    parsed.push({ start, end })
  }
  parsed.sort((a, b) => a.start - b.start)
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].start < parsed[i - 1].end) return null
  }
  return parsed.map(w => ({ start: minutesToHHMM(w.start), end: minutesToHHMM(w.end) }))
}

/**
 * Validate a stored schedule blob and reduce it to { "0".."6": [{start,end}] }.
 * Returns null if the blob is not a plain object or ANY enabled day is bad
 * (bad HH:MM, start >= end, > MAX_WINDOWS, overlap, non-array windows, or a
 * day entry that is not an object). One bad day invalidates the whole blob.
 * Absent days and days with enabled !== true are closed ([]).
 * Stray non-dow keys are ignored.
 */
export function normalizeSchedule(raw) {
  if (!isPlainObject(raw)) return null
  const out = emptySchedule()
  for (const key of DOW_KEYS) {
    const day = raw[key]
    if (day == null) continue
    if (!isPlainObject(day)) return null
    if (day.enabled !== true) continue
    const windows = normalizeWindows(day.windows)
    if (windows === null) return null
    out[key] = windows
  }
  return out
}

// Legacy `hours` rows store postgres `time` ("HH:MM:SS"). Postgres also
// allows "24:00:00"; clamp that to 23:59 so a midnight close still parses.
function legacyTimeToHHMM(value) {
  if (typeof value !== 'string') return null
  if (/^24:00(:00)?$/.test(value)) return '23:59'
  const hhmm = value.slice(0, 5)
  return parseHHMM(hhmm) === null ? null : hhmm
}

/**
 * Build a normalized schedule from legacy `hours` rows. Uses the FIRST row
 * per day_of_week (matching every existing .find() consumer). A closed day,
 * missing/unparseable times, or close <= open (which today's isOpen check
 * can never satisfy) → []. Empty/missing rows → null.
 */
export function scheduleFromHours(hoursRows) {
  if (!Array.isArray(hoursRows) || hoursRows.length === 0) return null
  const out = emptySchedule()
  for (const key of DOW_KEYS) {
    const row = hoursRows.find(h => h.day_of_week === Number(key))
    if (!row?.is_open) continue
    const start = legacyTimeToHHMM(row.open_time)
    const end = legacyTimeToHHMM(row.close_time)
    if (start === null || end === null) continue
    if (parseHHMM(start) >= parseHHMM(end)) continue
    out[key] = [{ start, end }]
  }
  return out
}

/**
 * Effective schedule for a service type.
 *   pickup   = pickup_schedule   ?? legacy hours
 *   delivery = delivery_schedule ?? effective pickup
 * An invalid stored blob counts as unset (falls through).
 */
export function getEffectiveSchedule(restaurant, hoursRows, type) {
  const pickup = normalizeSchedule(restaurant?.pickup_schedule) ?? scheduleFromHours(hoursRows)
  if (type === 'pickup') return pickup
  if (type === 'delivery') return normalizeSchedule(restaurant?.delivery_schedule) ?? pickup
  throw new Error(`getEffectiveSchedule: unknown type "${type}"`)
}

function atMinutes(date, min) {
  const out = new Date(date)
  out.setHours(Math.floor(min / 60), min % 60, 0, 0)
  return out
}

/** [{start: Date, end: Date}] for the calendar date of `date`. */
export function getWindowsForDate(schedule, date) {
  if (!schedule || !date) return []
  const windows = schedule[String(date.getDay())] || []
  return windows.map(w => ({
    start: atMinutes(date, parseHHMM(w.start)),
    end: atMinutes(date, parseHHMM(w.end)),
  }))
}

/**
 * Open at `date`? Boundary semantics match useRestaurant.js isOpen exactly:
 * it compares "HH:MM:SS" strings with `>= open_time && <= close_time`, i.e.
 * INCLUSIVE at both open and close, at whole-second resolution (ms ignored).
 * So close 20:30 → open at 20:30:00, closed at 20:30:01.
 */
export function isOpenAt(schedule, date = new Date()) {
  if (!schedule) return true
  const windows = schedule[String(date.getDay())] || []
  const nowSec = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()
  return windows.some(w => {
    const startSec = parseHHMM(w.start) * 60
    const endSec = parseHHMM(w.end) * 60
    return nowSec >= startSec && nowSec <= endSec
  })
}

/**
 * Start of the next window strictly after `fromDate`, looking from fromDate's
 * day through `daysAhead` days later (inclusive, so the same weekday next week
 * is reachable). Null schedule or nothing found → null.
 */
export function getNextOpen(schedule, fromDate = new Date(), daysAhead = 7) {
  if (!schedule) return null
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date(fromDate)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + i)
    for (const w of getWindowsForDate(schedule, d)) {
      if (w.start.getTime() > fromDate.getTime()) return w.start
    }
  }
  return null
}

/**
 * Earliest start / latest end across ALL given schedules on `date`'s calendar
 * day. Null schedules are ignored. Returns null when no schedule has a window
 * that day (including when every schedule is null). Gaps between windows are
 * deliberately swallowed — the tablet polling gate uses this and must not go
 * dark between lunch and dinner.
 */
export function getDaySpan(schedules, date) {
  let start = null
  let end = null
  for (const s of schedules || []) {
    for (const w of getWindowsForDate(s, date)) {
      if (start === null || w.start < start) start = w.start
      if (end === null || w.end > end) end = w.end
    }
  }
  return start === null ? null : { start, end }
}

/**
 * Legacy `hours` rows (day_of_week 0..6) from the two service schedules:
 * per-day span across both. Closed in both → is_open false, times null.
 * Null schedules contribute nothing.
 */
export function buildLegacyHoursRows(pickupSchedule, deliverySchedule) {
  return DOW_KEYS.map(key => {
    let start = null
    let end = null
    for (const s of [pickupSchedule, deliverySchedule]) {
      for (const w of s?.[key] || []) {
        const ws = parseHHMM(w.start)
        const we = parseHHMM(w.end)
        if (start === null || ws < start) start = ws
        if (end === null || we > end) end = we
      }
    }
    if (start === null) {
      return { day_of_week: Number(key), is_open: false, open_time: null, close_time: null }
    }
    return {
      day_of_week: Number(key),
      is_open: true,
      open_time: `${minutesToHHMM(start)}:00`,
      close_time: `${minutesToHHMM(end)}:00`,
    }
  })
}
