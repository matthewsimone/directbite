// One renderer for the website hours list (HoursModal + Footer) so the two
// can't drift. `variant` keeps each surface's existing markup and classes.
// `configured` (per-service schedules) switches on stacked split-shift
// windows and the "Today" label; unconfigured output is unchanged.

const FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function HoursDayList({ days, variant, today, configured }) {
  const rows = days.map(({ dow, windows }) => {
    const isToday = dow === today
    const label = configured && isToday ? 'Today' : (variant === 'modal' ? FULL : ABBR)[dow]
    const closed = windows.length === 0
    const value = configured && !closed
      ? (
        <span className="flex flex-col items-end">
          {windows.map(w => <span key={w}>{w}</span>)}
        </span>
      )
      : <span>{closed ? 'Closed' : windows[0]}</span>

    if (variant === 'modal') {
      return (
        <div
          key={dow}
          className={`flex ${configured ? 'items-start' : 'items-center'} justify-between py-2 px-3 rounded-lg text-sm ${
            isToday ? 'bg-green-50 text-green-700 font-bold' : 'text-gray-700'
          }`}
        >
          <span>{label}</span>
          {value}
        </div>
      )
    }
    const tone = isToday ? 'font-bold text-green-700' : 'text-gray-600'
    return (
      <div key={dow} className={`flex justify-between ${tone}`}>
        <span>{label}</span>
        {value}
      </div>
    )
  })
  return variant === 'modal'
    ? <div className="px-6 py-4">{rows}</div>
    : <div className="text-sm leading-relaxed">{rows}</div>
}
