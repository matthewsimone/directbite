import { useState, useEffect, useMemo } from 'react'
import { getAvailableDates, getAvailableTimeSlots } from '../utils/scheduling'

// Modal time picker. Caller passes the current `scheduledFor` (null = ASAP)
// and `onUpdate(value)` is fired with null for ASAP or an ISO timestamp
// when the user taps Update. Internal state is reset on every open.
export default function TimePickerModal({
  open,
  onClose,
  onUpdate,
  orderType,
  hours,
  isOpen,
  leadTimeMinutes,
  scheduledFor,
}) {
  const availableDates = useMemo(
    () => getAvailableDates(hours, { leadTimeMinutes }),
    [hours, leadTimeMinutes]
  )

  const [dateIdx, setDateIdx] = useState(0)
  const [timeValue, setTimeValue] = useState('asap')

  // Re-seed local state every time the modal is opened so it reflects
  // the current parent selection (and a stale modal can't apply old state).
  useEffect(() => {
    if (!open) return
    if (!scheduledFor) {
      setDateIdx(0)
      setTimeValue('asap')
      return
    }
    const target = new Date(scheduledFor)
    const idx = availableDates.findIndex(
      d => d.date.toDateString() === target.toDateString()
    )
    setDateIdx(idx >= 0 ? idx : 0)
    setTimeValue(scheduledFor)
  }, [open, scheduledFor, availableDates])

  // Escape closes without applying.
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const selectedDate = availableDates[dateIdx]?.date || null
  const slots = useMemo(
    () => (selectedDate ? getAvailableTimeSlots(selectedDate, hours, { leadTimeMinutes }) : []),
    [selectedDate, hours, leadTimeMinutes]
  )

  const isTodaySelected =
    selectedDate && selectedDate.toDateString() === new Date().toDateString()
  // ASAP is offered only when the picked date is today and the
  // restaurant is currently open. A future date or a closed restaurant
  // hides ASAP regardless.
  const showAsap = isTodaySelected && isOpen

  // If the user switched dates and the prior pick is no longer valid,
  // snap to the next sensible choice (ASAP if available, otherwise the
  // first slot) so the dropdown is never showing a phantom selection.
  useEffect(() => {
    if (!open) return
    if (timeValue === 'asap') {
      if (!showAsap) setTimeValue(slots[0]?.value || '')
      return
    }
    if (timeValue && !slots.some(s => s.value === timeValue)) {
      setTimeValue(showAsap ? 'asap' : (slots[0]?.value || ''))
    }
  }, [open, slots, showAsap])

  if (!open) return null

  const labelText = orderType === 'delivery' ? 'Delivery' : 'Pickup'

  function handleUpdate() {
    onUpdate(timeValue === 'asap' ? null : timeValue)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-900">{labelText} Time</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-gray-100"
            aria-label="Close"
          >
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {availableDates.length === 0 ? (
          <p className="text-sm text-red-500">
            No upcoming time slots available. Please try again later.
          </p>
        ) : (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select {labelText} Date
              </label>
              <select
                value={dateIdx}
                onChange={e => setDateIdx(Number(e.target.value))}
                className="w-full px-4 py-3 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              >
                {availableDates.map((d, i) => (
                  <option key={i} value={i}>{d.label}</option>
                ))}
              </select>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select {labelText} Time
              </label>
              <select
                value={timeValue}
                onChange={e => setTimeValue(e.target.value)}
                className="w-full px-4 py-3 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
                disabled={!showAsap && slots.length === 0}
              >
                {showAsap && <option value="asap">ASAP</option>}
                {slots.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
                {!showAsap && slots.length === 0 && (
                  <option value="">No times available</option>
                )}
              </select>
            </div>

            <button
              onClick={handleUpdate}
              disabled={!timeValue}
              className="w-full py-3.5 rounded-xl font-semibold text-base text-white bg-[#16A34A] hover:bg-[#15803D] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Update
            </button>
          </>
        )}
      </div>
    </div>
  )
}
