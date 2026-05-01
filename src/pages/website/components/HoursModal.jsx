import { useEffect } from 'react'
import { formatTime } from '../utils/hours'

// Render Mon → Sun. day_of_week 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
const DISPLAY_ORDER = [
  { idx: 1, label: 'Monday' },
  { idx: 2, label: 'Tuesday' },
  { idx: 3, label: 'Wednesday' },
  { idx: 4, label: 'Thursday' },
  { idx: 5, label: 'Friday' },
  { idx: 6, label: 'Saturday' },
  { idx: 0, label: 'Sunday' },
]

export default function HoursModal({ open, onClose, hours }) {
  const today = new Date().getDay()

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold uppercase tracking-wide">Hours</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none w-8 h-8 flex items-center justify-center"
          >
            &times;
          </button>
        </div>

        <div className="px-6 py-4">
          {DISPLAY_ORDER.map(({ idx, label }) => {
            const h = (hours || []).find(hr => hr.day_of_week === idx)
            const isToday = idx === today
            const closed = !h?.is_open || !h.open_time || !h.close_time
            return (
              <div
                key={idx}
                className={`flex items-center justify-between py-2 px-3 rounded-lg text-sm ${
                  isToday ? 'bg-green-50 text-green-700 font-bold' : 'text-gray-700'
                }`}
              >
                <span>{label}</span>
                <span>
                  {closed ? 'Closed' : `${formatTime(h.open_time)} - ${formatTime(h.close_time)}`}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
