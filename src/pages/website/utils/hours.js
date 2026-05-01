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
