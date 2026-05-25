// Helpers for the customer-side scheduled order picker. The restaurant's
// `hours` table provides one row per day_of_week with HH:MM:SS open/close
// strings; from those plus the current clock we derive the date dropdown
// (next N open days) and the time dropdown (15-min slots inside the
// open/close window, floored by now + lead time on the same day).

const DAY_MS = 24 * 60 * 60 * 1000

// Restaurants should not be slammed at the moment they unlock the door.
// Hold scheduling slots back by this much from the listed open time so
// the kitchen has time to ramp up. Applied uniformly to today + future
// dates; the today path still respects now + leadTimeMinutes on top.
const OPEN_BUFFER_MINUTES = 30

function parseTimeOnDate(date, timeStr) {
  const [h, m] = timeStr.split(':').map(Number)
  const out = new Date(date)
  out.setHours(h, m, 0, 0)
  return out
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

// Build slots inside [open, close] in `intervalMinutes` increments. For
// today, the earliest slot is max(open, now + leadTimeMinutes), rounded up
// to the next interval boundary so the picker doesn't show 5:07 PM.
export function getAvailableTimeSlots(date, hours, { leadTimeMinutes = 30, intervalMinutes = 15 } = {}) {
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

// Walk forward up to `daysAhead` days. Skip closed days and skip today
// when its remaining window has no slots (computed via getAvailableTimeSlots
// so the rules stay in one place).
export function getAvailableDates(hours, { daysAhead = 7, leadTimeMinutes = 30, intervalMinutes = 15 } = {}) {
  if (!hours || hours.length === 0) return []
  const result = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * DAY_MS)
    const dow = d.getDay()
    const dayHours = hours.find(h => h.day_of_week === dow)
    if (!dayHours?.is_open || !dayHours.open_time || !dayHours.close_time) continue

    const slots = getAvailableTimeSlots(d, hours, { leadTimeMinutes, intervalMinutes })
    if (slots.length === 0) continue

    result.push({ date: d, label: formatDateLabel(d), dayOfWeek: dow })
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
