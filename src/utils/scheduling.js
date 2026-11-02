// Helpers for the customer-side scheduled order picker. Callers pass a
// normalized schedule from serviceHours.js ({ "0".."6": [{start,end}] }); a
// legacy `hours` rows array is still accepted and converted. From that plus
// the current clock we derive the date dropdown (next N open days) and the
// time dropdown (15-min slots inside each window, floored by now + lead time
// on the same day).

import { scheduleFromHours, getWindowsForDate } from './serviceHours.js'

const DAY_MS = 24 * 60 * 60 * 1000

// Restaurants should not be slammed at the moment they unlock the door.
// Hold scheduling slots back by this much from the listed open time so
// the kitchen has time to ramp up. Applied uniformly to today + future
// dates; the today path still respects now + leadTimeMinutes on top.
const OPEN_BUFFER_MINUTES = 30

function toSchedule(scheduleOrHours) {
  return Array.isArray(scheduleOrHours) ? scheduleFromHours(scheduleOrHours) : scheduleOrHours || null
}

function formatTimeLabel(date) {
  // Strip the space before AM/PM so "11:30AM" stays on one line in the
  // mobile UI even at narrow widths. All consumers (banner, picker button,
  // confirmation page, tablet badge) inherit this format via
  // formatScheduledLabel.
  return date
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(' ', '')
}

export function formatDateLabel(date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target - today) / DAY_MS)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  return target.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatScheduledLabel(isoString) {
  if (!isoString) return null
  const d = new Date(isoString)
  return `${formatDateLabel(d)} at ${formatTimeLabel(d)}`
}

// Build slots inside each [start, end] window in `intervalMinutes`
// increments. OPEN_BUFFER_MINUTES applies at the start of EVERY window. For
// today, a window's earliest slot is max(start + buffer, now + lead), rounded
// up to the next interval boundary so the picker doesn't show 5:07 PM.
export function getAvailableTimeSlots(date, scheduleOrHours, { leadTimeMinutes = 30, intervalMinutes = 15 } = {}) {
  const schedule = toSchedule(scheduleOrHours)
  if (!schedule || !date) return []

  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const earliestNow = new Date(now.getTime() + leadTimeMinutes * 60 * 1000)

  const slots = []
  for (const w of getWindowsForDate(schedule, date)) {
    const earliestOpen = new Date(w.start.getTime() + OPEN_BUFFER_MINUTES * 60 * 1000)
    let cursor
    if (isToday) {
      cursor = new Date(Math.max(earliestOpen.getTime(), earliestNow.getTime()))
      const rounded = Math.ceil(cursor.getMinutes() / intervalMinutes) * intervalMinutes
      cursor.setMinutes(rounded, 0, 0)
    } else {
      cursor = new Date(earliestOpen)
    }
    while (cursor.getTime() <= w.end.getTime()) {
      slots.push({ value: cursor.toISOString(), label: formatTimeLabel(cursor) })
      cursor = new Date(cursor.getTime() + intervalMinutes * 60 * 1000)
    }
  }
  return slots
}

// Walk forward up to `daysAhead` days. Skip closed days and skip today
// when its remaining window has no slots (computed via getAvailableTimeSlots
// so the rules stay in one place).
export function getAvailableDates(scheduleOrHours, { daysAhead = 7, leadTimeMinutes = 30, intervalMinutes = 15 } = {}) {
  const schedule = toSchedule(scheduleOrHours)
  if (!schedule) return []
  const result = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * DAY_MS)
    const slots = getAvailableTimeSlots(d, schedule, { leadTimeMinutes, intervalMinutes })
    if (slots.length === 0) continue

    result.push({ date: d, label: formatDateLabel(d), dayOfWeek: d.getDay() })
  }
  return result
}

// Returns YYYY-MM-DD as observed in America/New_York. en-CA natively
// produces ISO-like YYYY-MM-DD so we avoid parsing en-US's M/D/YYYY.
export function getNyDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// Formats a YYYY-MM-DD key as a section header label. "Today"/"Yesterday"
// compared by key; otherwise "Saturday, May 8" for the current year or
// "Saturday, December 14, 2024" for prior years. The key is rehydrated
// as UTC noon so the NY-tz formatter always lands on the right calendar
// day regardless of the device's local timezone.
export function formatGroupHeader(dateKey, { todayKey, yesterdayKey, currentYear }) {
  if (dateKey === todayKey) return 'Today'
  if (dateKey === yesterdayKey) return 'Yesterday'
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const opts = {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }
  if (y !== currentYear) opts.year = 'numeric'
  return new Intl.DateTimeFormat('en-US', opts).format(date)
}

// Groups orders (already sorted by created_at DESC) into NY-time
// calendar-day buckets. Returns [{ dateKey, label, orders }] preserving
// newest-first order. todayKey/yesterdayKey/currentYear are recomputed
// from now() each call, so the post-midnight polling re-render naturally
// reshuffles "Today" and "Yesterday" labels.
export function groupOrdersByCreatedAtNy(orders) {
  const now = new Date()
  const todayKey = getNyDateKey(now)
  const yesterdayKey = getNyDateKey(new Date(now.getTime() - DAY_MS))
  const currentYear = Number(todayKey.slice(0, 4))
  const groups = []
  const byKey = new Map()
  for (const o of orders) {
    const key = getNyDateKey(new Date(o.created_at))
    let group = byKey.get(key)
    if (!group) {
      group = {
        dateKey: key,
        label: formatGroupHeader(key, { todayKey, yesterdayKey, currentYear }),
        orders: [],
      }
      byKey.set(key, group)
      groups.push(group)
    }
    group.orders.push(o)
  }
  return groups
}

// Returns getNyDateKey for `daysAgo` days before now. Used for rolling-
// window presets like "Last 7 Days" (daysAgo=6 to include today).
export function getNyDateKeyForOffset(daysAgo) {
  return getNyDateKey(new Date(Date.now() - daysAgo * DAY_MS))
}

// Given a YYYY-MM-DD reference key in NY time, returns { startKey, endKey }
// for either that same calendar month (start = first of month, end = the
// reference) or the prior calendar month (start = first of prior month,
// end = last day of prior month). Last-day uses the Date.UTC(y, m, 0)
// trick which returns the final day of month `m` (1-indexed).
export function getNyMonthBounds(referenceKey, { prior } = {}) {
  const [y, m] = referenceKey.split('-').map(Number)
  if (!prior) {
    const mm = String(m).padStart(2, '0')
    return { startKey: `${y}-${mm}-01`, endKey: referenceKey }
  }
  const prevYear = m === 1 ? y - 1 : y
  const prevMonth = m === 1 ? 12 : m - 1
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate()
  const mm = String(prevMonth).padStart(2, '0')
  const dd = String(lastDay).padStart(2, '0')
  return {
    startKey: `${prevYear}-${mm}-01`,
    endKey: `${prevYear}-${mm}-${dd}`,
  }
}

// Computes the date range for a Sales Report preset. Returns startKey/
// endKey as YYYY-MM-DD strings (NY time, inclusive) plus a wider UTC
// envelope (queryStartIso/queryEndIso) that's guaranteed to cover any
// moment falling on a NY day in [startKey, endKey] regardless of DST.
// Callers should post-filter results with getNyDateKey for precise
// NY-day membership. The envelope is start - 1 day to end + 2 days
// (UTC midnight on each), which covers NY-evening rows that land on
// the next UTC day even at the deepest DST offset.
export function getRangeForPreset(preset, { customStart, customEnd } = {}) {
  const todayKey = getNyDateKey(new Date())
  let startKey
  let endKey
  switch (preset) {
    case 'today':
      startKey = todayKey
      endKey = todayKey
      break
    case 'yesterday':
      startKey = getNyDateKeyForOffset(1)
      endKey = getNyDateKeyForOffset(1)
      break
    case 'last7':
      startKey = getNyDateKeyForOffset(6)
      endKey = todayKey
      break
    case 'last30':
      startKey = getNyDateKeyForOffset(29)
      endKey = todayKey
      break
    case 'thisMonth': {
      const bounds = getNyMonthBounds(todayKey)
      startKey = bounds.startKey
      endKey = bounds.endKey
      break
    }
    case 'lastMonth': {
      const bounds = getNyMonthBounds(todayKey, { prior: true })
      startKey = bounds.startKey
      endKey = bounds.endKey
      break
    }
    case 'custom':
      startKey = customStart
      endKey = customEnd
      break
    default:
      startKey = todayKey
      endKey = todayKey
  }
  const [sy, sm, sd] = startKey.split('-').map(Number)
  const [ey, em, ed] = endKey.split('-').map(Number)
  const queryStartIso = new Date(Date.UTC(sy, sm - 1, sd - 1, 0, 0, 0)).toISOString()
  const queryEndIso = new Date(Date.UTC(ey, em - 1, ed + 2, 0, 0, 0)).toISOString()
  return { startKey, endKey, queryStartIso, queryEndIso }
}
