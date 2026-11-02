// Hours status utilities for the restaurant website.
// Pure functions — easy to test, no React.

import { isServiceConfigured, getEffectiveSchedule, getWindowsForDate, getNextOpen } from '../../../utils/serviceHours.js'

// Re-exported so HoursModal / Footer / HomePage keep importing it from here.
export { isServiceConfigured }

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "09:00" → "9am"  |  "21:30" → "9:30pm"  |  "00:00" → "12am"  |  "12:00" → "12pm"
export function formatTime(hhmm) {
  if (!hhmm) return ''
  const [hStr, mStr] = hhmm.split(':')
  const h = parseInt(hStr, 10)
  const m = parseInt(mStr, 10)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, '0')}${ampm}`
}

// "HH:MM:SS" or "HH:MM" → minutes since midnight, comparable as int
function toMinutes(t) {
  if (!t) return null
  const [h, m] = t.split(':')
  return parseInt(h, 10) * 60 + parseInt(m, 10)
}

// Effective schedules for display. showDeliveryTab: delivery is offered AND
// its effective schedule differs from pickup. Always false for unconfigured
// restaurants (delivery falls back to the very same pickup schedule).
export function getWebsiteSchedules(restaurant, hours) {
  const pickup = getEffectiveSchedule(restaurant, hours, 'pickup')
  const delivery = getEffectiveSchedule(restaurant, hours, 'delivery')
  const showDeliveryTab = !!restaurant?.delivery_available && JSON.stringify(pickup) !== JSON.stringify(delivery)
  return { pickup, delivery, showDeliveryTab }
}

const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

// Configured restaurants: open if pickup, or (delivery offered and) delivery,
// is open now. Boundaries are inclusive to the second, matching isOpenAt.
// Status strings use the legacy formats.
function getServiceStatus(restaurant, hours, now) {
  const { pickup, delivery } = getWebsiteSchedules(restaurant, hours)
  const schedules = [pickup, restaurant.delivery_available ? delivery : null].filter(Boolean)
  const windows = schedules.flatMap(s => getWindowsForDate(s, now))
  const todaysHours = windows.length > 0
    ? { open: hhmm(new Date(Math.min(...windows.map(w => w.start)))), close: hhmm(new Date(Math.max(...windows.map(w => w.end)))) }
    : null

  const at = new Date(now)
  at.setMilliseconds(0)
  const current = windows.filter(w => w.start <= at && at <= w.end)
  if (current.length > 0) {
    const open = new Date(Math.min(...current.map(w => w.start)))
    const close = new Date(Math.max(...current.map(w => w.end)))
    return { isOpen: true, statusText: `OPEN ${formatTime(hhmm(open))}-${formatTime(hhmm(close))}`, todaysHours }
  }

  const starts = schedules.map(s => getNextOpen(s, now, 7)).filter(Boolean)
  if (starts.length === 0) return { isOpen: false, statusText: 'CLOSED', todaysHours }
  const next = new Date(Math.min(...starts.map(d => d.getTime())))
  const dayA = new Date(now)
  dayA.setHours(0, 0, 0, 0)
  const dayB = new Date(next)
  dayB.setHours(0, 0, 0, 0)
  const diff = Math.round((dayB - dayA) / 86400000)
  const dayLabel = diff === 0 ? '' : diff === 1 ? ' Tomorrow' : ` ${DAY_ABBR[next.getDay()]}`
  return { isOpen: false, statusText: `CLOSED · Opens at ${formatTime(hhmm(next))}${dayLabel}`, todaysHours }
}

// hours: array of { day_of_week (0-6), is_open, open_time, close_time }
// now: Date — re-pass each tick to keep status live
// restaurant: optional. A configured restaurant uses its service schedules;
// is_open === false (admin "Pause Ordering") forces plain CLOSED on either
// path. Omitted → the legacy hours-only status, unchanged.
export function getStatus(hours, now = new Date(), restaurant = null) {
  const status = isServiceConfigured(restaurant)
    ? getServiceStatus(restaurant, hours, now)
    : getLegacyStatus(hours, now)
  if (restaurant && restaurant.is_open === false) {
    return { isOpen: false, statusText: 'CLOSED', todaysHours: status.todaysHours }
  }
  return status
}

function getLegacyStatus(hours, now) {
  const today = now.getDay()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const todayHours = (hours || []).find(h => h.day_of_week === today)

  // Currently open?
  if (todayHours?.is_open && todayHours.open_time && todayHours.close_time) {
    const openMin = toMinutes(todayHours.open_time)
    const closeMin = toMinutes(todayHours.close_time)
    if (nowMin >= openMin && nowMin <= closeMin) {
      return {
        isOpen: true,
        statusText: `OPEN ${formatTime(todayHours.open_time)}-${formatTime(todayHours.close_time)}`,
        todaysHours: { open: todayHours.open_time, close: todayHours.close_time },
      }
    }
    // Before open today
    if (nowMin < openMin) {
      return {
        isOpen: false,
        statusText: `CLOSED · Opens at ${formatTime(todayHours.open_time)}`,
        todaysHours: { open: todayHours.open_time, close: todayHours.close_time },
      }
    }
    // Past close — fall through to next-day search
  }

  // Find the next day with hours
  for (let i = 1; i <= 7; i++) {
    const checkDay = (today + i) % 7
    const h = (hours || []).find(hr => hr.day_of_week === checkDay)
    if (h?.is_open && h.open_time) {
      const dayLabel = i === 1 ? 'Tomorrow' : DAY_ABBR[checkDay]
      return {
        isOpen: false,
        statusText: `CLOSED · Opens at ${formatTime(h.open_time)} ${dayLabel}`,
        todaysHours: todayHours?.is_open
          ? { open: todayHours.open_time, close: todayHours.close_time }
          : null,
      }
    }
  }

  return { isOpen: false, statusText: 'CLOSED', todaysHours: null }
}

// Compact human week-hours string for FAQ/schema answers, e.g.
// "Mon–Thu 11am–10pm, Fri–Sat 11am–11pm, Sun 12pm–9pm".
// Collapses consecutive days with identical hours into ranges; folds
// closed days in as "Closed". Pure/build-safe (formatTime is pure).
// `hours`: array of { day_of_week (0=Sun..6=Sat), is_open, open_time, close_time }.
// Reuses the module-level DAY_ABBR array (indexed by day_of_week, 0=Sun).
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon..Sun display order

// Collapse consecutive same-label days into "Mon–Thu {label}" runs.
function collapseWeek(days) {
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

// restaurant: optional. A configured restaurant uses its pickup schedule
// (= business hours), one "start – end" per window joined with " & ".
export function formatWeekHours(hours, restaurant = null) {
  if (isServiceConfigured(restaurant)) {
    const { pickup } = getWebsiteSchedules(restaurant, hours)
    if (!pickup) return ''
    return collapseWeek(WEEK_ORDER.map(dow => {
      const ws = pickup[String(dow)]
      return { dow, label: ws.length ? ws.map(w => `${formatTime(w.start)} – ${formatTime(w.end)}`).join(' & ') : 'Closed' }
    }))
  }
  if (!Array.isArray(hours) || hours.length === 0) return ''
  const byDay = {}
  for (const h of hours) byDay[h.day_of_week] = h

  // Build a per-day label string ("11am – 10pm" or "Closed") in week order.
  const days = WEEK_ORDER.map((dow) => {
    const h = byDay[dow]
    const label = h && h.is_open && h.open_time && h.close_time
      ? `${formatTime(h.open_time)} – ${formatTime(h.close_time)}`
      : 'Closed'
    return { dow, label }
  })

  return collapseWeek(days)
}

// Per-day rows for the shared hours list (modal + footer), Mon→Sun.
// Unconfigured: legacy rows exactly as HoursModal/Footer built them (first
// row per day; "Closed" unless is_open with both times).
// Configured: one "start - end" string per window of the given service.
export function getDisplayDays(restaurant, hours, service = 'pickup') {
  if (!isServiceConfigured(restaurant)) {
    return WEEK_ORDER.map(dow => {
      const h = (hours || []).find(hr => hr.day_of_week === dow)
      const closed = !h?.is_open || !h.open_time || !h.close_time
      return { dow, windows: closed ? [] : [`${formatTime(h.open_time)} - ${formatTime(h.close_time)}`] }
    })
  }
  const schedule = getWebsiteSchedules(restaurant, hours)[service]
  return WEEK_ORDER.map(dow => ({
    dow,
    windows: (schedule?.[String(dow)] || []).map(w => `${formatTime(w.start)} - ${formatTime(w.end)}`),
  }))
}
