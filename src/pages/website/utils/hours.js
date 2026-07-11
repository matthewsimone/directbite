// Hours status utilities for the restaurant website.
// Pure functions — easy to test, no React.

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

// hours: array of { day_of_week (0-6), is_open, open_time, close_time }
// now: Date — re-pass each tick to keep status live
export function getStatus(hours, now = new Date()) {
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

export function formatWeekHours(hours) {
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

  // Collapse consecutive same-label runs into "Mon–Thu {label}".
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
