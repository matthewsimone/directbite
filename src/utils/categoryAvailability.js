// ============================================================================
// Category availability — "is this menu category orderable right now?"
// ============================================================================
//
// Pure functions, no React, no browser globals. Importable from a Node .mjs
// prerender script as well as from the app.
//
// SHAPE
//   availability = null
//     -> always available. Same for any non-object, an empty object, or an
//        object with no day whose `enabled` is exactly true.
//
//   availability = {
//     "<dow>": { enabled: boolean, start: "HH:MM" | null, end: "HH:MM" | null }
//   }
//
//   `dow` is a STRING "0".."6" where 0 = Sunday. This matches the `hours`
//   table's day_of_week column (migrations/001_initial_schema.sql: check
//   between 0 and 6) and JS Date.getDay(), which every hours consumer in this
//   codebase already compares against.
//
//   A day that is absent, or whose enabled !== true, is UNAVAILABLE that day.
//   A day with enabled === true and neither start nor end is available all day.
//   A day with enabled === true and both start and end is available inside
//   [start, end] — INCLUSIVE on both ends, matching hours.js getStatus rather
//   than uberMode's end-exclusive schedule windows.
//   A day with only one of start/end is treated as all-day (see PARTIAL below).
//
// KNOWN LIMIT — overnight windows (start > end, e.g. "22:00"-"02:00") are NOT
// supported. They evaluate as never-in-range, the same limitation uberActive.js
// and uberMode.ts carry for uber_schedule. A category needing one must be
// modelled as two day entries or left always-available.
//
// PARTIAL — a day with a start but no end (or vice versa) cannot describe a
// window, so it is read as all-day rather than as an unbounded one. Failing
// toward "available" here is the same instinct as the fail-open rule below.
//
// FAIL OPEN — this module decides whether to HIDE a category. Every ambiguous
// or malformed input therefore resolves to "available": null, a non-object, an
// array, an empty object, a blob with no enabled day, an unparseable time
// string anywhere in the blob, or any thrown error. A bad blob must never hide
// a category, and one bad time must not be read as a narrow window.
// ============================================================================

import { formatTime } from '../pages/website/utils/hours.js'

/**
 * Extract day-of-week ("0"=Sun.."6"=Sat) and "HH:MM" 24-hour time string in
 * America/New_York. Mirrors getNyTimeComponents in uberMode.ts: build a Date
 * from the NY-localized string, then read local getDay/getHours/getMinutes.
 *
 * DELIBERATE COPY of the function in src/utils/uberActive.js — byte-identical
 * body. It is duplicated rather than imported because that module is the
 * client-side mirror of a Deno file and carries its own drift contract with
 * supabase/functions/_shared/uberMode.ts; importing from it would make this
 * module a third party to that agreement. THE TWO MUST NOT DRIFT: if the NY
 * time extraction changes in uberActive.js, change it here in the same commit.
 */
function getNyTimeComponents(date) {
  const nyLocal = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = String(nyLocal.getDay());
  const hour = String(nyLocal.getHours()).padStart(2, '0');
  const minute = String(nyLocal.getMinutes()).padStart(2, '0');
  return { dow, time: `${hour}:${minute}` };
}

// Mirrors the module-level WEEK_ORDER in src/pages/website/utils/hours.js:78,
// which is not exported. Mon..Sun display order. Used to decide whether a set
// of days forms a consecutive run — Monday-first is what makes Fri/Sat/Sun read
// as "Fri-Sun" instead of three separate days.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

// Mirrors DAY_ABBR in the same file (hours.js:4), also not exported. Indexed by
// day_of_week, 0 = Sun.
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// "HH:MM" or "HH:MM:SS" -> "HH:MM"; anything else -> null.
// The :SS tolerance is not decoration: the `hours` table stores postgres `time`
// values that come back as "11:00:00", and SettingsTab already slices them to
// HH:MM when seeding uber_schedule. Rejecting them here would fail the whole
// blob open on a value the rest of the codebase treats as ordinary.
function normalizeTime(value) {
  if (typeof value !== 'string') return null
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) return null
  return value.slice(0, 5)
}

/**
 * Validate and reduce an availability blob to { "<dow>": { start, end } } for
 * enabled days only.
 *
 * Returns null to mean "this blob cannot restrict anything" — the single
 * fail-open signal both exports read. That covers a malformed container, a
 * malformed day entry, an unparseable time on an enabled day, and the
 * no-enabled-days case. Callers turn null into `true` / `''`.
 */
function parseAvailability(availability) {
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) return null

  const parsed = {}
  let enabledCount = 0

  for (const key of Object.keys(availability)) {
    // Stray non-dow keys are ignored rather than distrusted — an extra field
    // alongside a valid schedule should not silently widen it.
    if (!/^[0-6]$/.test(key)) continue

    const day = availability[key]
    if (day == null) continue // absent day == unavailable that day
    if (typeof day !== 'object' || Array.isArray(day)) return null
    if (day.enabled !== true) continue

    const rawStart = day.start == null || day.start === '' ? null : day.start
    const rawEnd = day.end == null || day.end === '' ? null : day.end
    const start = rawStart === null ? null : normalizeTime(rawStart)
    const end = rawEnd === null ? null : normalizeTime(rawEnd)

    // Present but unparseable — distrust the whole blob rather than this one
    // window, or "banana" would read as a restriction nobody can satisfy.
    if (rawStart !== null && start === null) return null
    if (rawEnd !== null && end === null) return null

    parsed[key] = { start, end }
    enabledCount++
  }

  if (enabledCount === 0) return null
  return parsed
}

/**
 * Is this category orderable at `now`?
 *
 * @param {object|null} availability - the blob documented at the top of this file
 * @param {Date} [now] - injectable clock (defaults to real now), same signature
 *   convention as isUberActiveNow
 * @returns {boolean} - true when orderable; fails open on anything malformed
 */
export function isCategoryAvailableNow(availability, now = new Date()) {
  try {
    const parsed = parseAvailability(availability)
    if (!parsed) return true

    const { dow, time } = getNyTimeComponents(now)
    const day = parsed[dow]
    if (!day) return false // enabled elsewhere, but not today

    // All-day (or PARTIAL, per the header note).
    if (!day.start || !day.end) return true

    // String compare on zero-padded "HH:MM" is correct and is what uberActive
    // does. Inclusive both ends — see the header note on hours.js getStatus.
    return time >= day.start && time <= day.end
  } catch {
    return true
  }
}

// "11:00"/"15:00" -> "11am-3pm". Plain ASCII hyphen, never an en dash: this
// string is destined for the Epson thermal printer, which is ASCII-only.
function formatWindow(day) {
  return `${formatTime(day.start)}-${formatTime(day.end)}`
}

/**
 * Render a set of day numbers as a human string.
 *
 * Consecutiveness is judged in WEEK_ORDER (Monday-first) so a Fri/Sat/Sun
 * category reads "Fri-Sun" rather than as a scattered list.
 *
 * NOTE on ordering of the non-consecutive "&" list: it is sorted by numeric
 * dow, i.e. Sunday first, which is what produces "Sun & Wed" and
 * "Mon, Wed & Fri". Sorting that list in WEEK_ORDER instead would render the
 * first as "Wed & Sun". Run detection stays Monday-first; only this list is
 * numeric.
 *
 * @param {number[]} dows
 * @param {boolean} abbrevSingle - a lone day renders abbreviated ("Sat") inside
 *   a multi-group listing, but full ("Saturday") when it is the whole label.
 */
function formatDayList(dows, abbrevSingle = false) {
  const positions = dows.map(d => WEEK_ORDER.indexOf(d)).sort((a, b) => a - b)

  if (positions.length === 1) {
    const only = WEEK_ORDER[positions[0]]
    return abbrevSingle ? DAY_ABBR[only] : DAY_FULL[only]
  }

  const consecutive = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1)
  if (consecutive) {
    const first = WEEK_ORDER[positions[0]]
    const last = WEEK_ORDER[positions[positions.length - 1]]
    return `${DAY_ABBR[first]}-${DAY_ABBR[last]}`
  }

  const labels = [...dows].sort((a, b) => a - b).map(d => DAY_ABBR[d])
  if (labels.length === 2) return `${labels[0]} & ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')} & ${labels[labels.length - 1]}`
}

/**
 * Human label for an availability blob, WITHOUT any "Only available " prefix —
 * the caller owns that framing.
 *
 * Returns '' whenever the category is always available: any input
 * isCategoryAvailableNow would fail open on, or all seven days enabled with no
 * times. Shapes, in priority order:
 *
 *   all 7 days, one shared window      -> "11am-3pm"
 *   all 7 days, no times               -> ""
 *   subset, no times                   -> "Tuesday" / "Mon-Fri" / "Sun & Wed"
 *   subset, one shared window          -> "Mon-Fri, 11am-3pm"
 *   differing windows                  -> "Mon-Fri 11am-3pm, Sat 11am-4pm"
 *
 * The comma before the time in the shared-window form is what distinguishes it
 * from a group in the differing-windows form, where groups are themselves
 * comma-separated.
 *
 * @param {object|null} availability
 * @returns {string}
 */
export function formatAvailabilityLabel(availability) {
  try {
    const parsed = parseAvailability(availability)
    if (!parsed) return ''

    const dows = Object.keys(parsed).map(Number).sort((a, b) => a - b)
    const windowKey = d => {
      const day = parsed[String(d)]
      return day.start && day.end ? `${day.start}|${day.end}` : ''
    }

    const distinct = [...new Set(dows.map(windowKey))]

    if (distinct.length === 1) {
      const key = distinct[0]
      if (key === '') return dows.length === 7 ? '' : formatDayList(dows)
      const window = formatWindow(parsed[String(dows[0])])
      return dows.length === 7 ? window : `${formatDayList(dows)}, ${window}`
    }

    // Differing windows — one group per distinct window, ordered by each
    // group's earliest day in WEEK_ORDER so the listing reads Mon-first.
    const groups = new Map()
    for (const d of dows) {
      const key = windowKey(d)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(d)
    }

    return [...groups.entries()]
      .sort((a, b) => {
        const posA = Math.min(...a[1].map(d => WEEK_ORDER.indexOf(d)))
        const posB = Math.min(...b[1].map(d => WEEK_ORDER.indexOf(d)))
        return posA - posB
      })
      .map(([key, groupDows]) => {
        const days = formatDayList(groupDows, true)
        if (key === '') return days // an all-day group inside a mixed listing
        return `${days} ${formatWindow(parsed[String(groupDows[0])])}`
      })
      .join(', ')
  } catch {
    return ''
  }
}
