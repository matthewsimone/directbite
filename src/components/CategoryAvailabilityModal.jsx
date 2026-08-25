import { useState } from 'react'
import { createPortal } from 'react-dom'
import { formatAvailabilityLabel } from '../utils/categoryAvailability'

// Monday-first, matching WEEK_ORDER in src/pages/website/utils/hours.js:78 and
// the display order categoryAvailability.js uses for its labels. The STORED
// keys are still "0"=Sunday — this array only controls row order.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ALL_DOWS = [0, 1, 2, 3, 4, 5, 6]

// Mirrors the Toggle in src/pages/tablet/SettingsTab.jsx:69, which is local to
// that file and not exported. Same geometry so the two schedule editors read as
// the same control.
function Toggle({ value, onChange, disabled = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative w-14 h-8 rounded-full transition-colors shrink-0 ${value ? 'bg-[#16A34A]' : 'bg-gray-300'} ${disabled ? 'opacity-50' : ''}`}
      style={{ minWidth: 56 }}
    >
      <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-transform ${value ? 'left-7' : 'left-1'}`} />
    </button>
  )
}

// The editor keeps all seven days in state, including the disabled ones, so a
// day toggled off and on again does not lose the times that were typed into it.
// draftToPayload is what drops them on the way out.
function seedDraft(availability) {
  const usable = availability && typeof availability === 'object' && !Array.isArray(availability)
    ? availability
    : null
  const draft = {}
  for (const dow of ALL_DOWS) {
    const day = usable ? usable[String(dow)] : null
    draft[String(dow)] = {
      enabled: day?.enabled === true,
      // slice(0,5) tolerates an "HH:MM:SS" value the way categoryAvailability
      // does; <input type="time"> will not display the seconds form.
      start: typeof day?.start === 'string' ? day.start.slice(0, 5) : '',
      end: typeof day?.end === 'string' ? day.end.slice(0, 5) : '',
    }
  }
  return draft
}

/**
 * Draft -> the value written to menu_categories.availability.
 *
 * Enabled days ONLY: a disabled day is omitted entirely rather than stored as
 * enabled:false, because absent and disabled mean the same thing to the reader
 * and the shorter object is the one worth persisting.
 *
 * Zero enabled days returns NULL, not {}. Both fail open, but only null is an
 * honest "no schedule" and only null greys the trigger icon back out.
 *
 * Empty strings become null so an all-day entry never persists as "".
 */
export function draftToPayload(draft) {
  const out = {}
  let enabledCount = 0
  for (const dow of ALL_DOWS) {
    const day = draft[String(dow)]
    if (!day?.enabled) continue
    out[String(dow)] = {
      enabled: true,
      start: day.start ? day.start : null,
      end: day.end ? day.end : null,
    }
    enabledCount++
  }
  return enabledCount === 0 ? null : out
}

// The only validation rule. An enabled day with both times where start >= end
// describes either an overnight window (unsupported — see categoryAvailability's
// KNOWN LIMIT) or a zero-length one; both produce a category nobody can order
// from, and neither is what the operator meant. Everything else is allowed
// through: blanks mean all day, and the reader fails open on the rest.
function validateDraft(draft) {
  const errors = {}
  for (const dow of ALL_DOWS) {
    const day = draft[String(dow)]
    if (!day?.enabled) continue
    if (day.start && day.end && day.start >= day.end) {
      errors[String(dow)] = 'End time must be after start time.'
    }
  }
  return errors
}

/**
 * Per-category day/time schedule editor.
 *
 * Presentational: the caller owns the write, so this stays beside
 * toggleCatDiscountExempt rather than reaching for supabase itself.
 *
 * @param {object} category - the menu_categories row (name + availability)
 * @param {(value: object|null) => Promise<void>} onSave
 * @param {() => void} onClose
 */
export default function CategoryAvailabilityModal({ category, onSave, onClose }) {
  const [draft, setDraft] = useState(() => seedDraft(category.availability))
  const [saving, setSaving] = useState(false)

  const errors = validateDraft(draft)
  const hasErrors = Object.keys(errors).length > 0

  // Recomputed every render from the draft, so the operator reads the same
  // sentence the customer will see on the menu — through the same function.
  const previewLabel = formatAvailabilityLabel(draftToPayload(draft))

  function updateDay(dow, field, value) {
    setDraft(prev => ({
      ...prev,
      [String(dow)]: { ...prev[String(dow)], [field]: value },
    }))
  }

  // isClear distinguishes the two ways a null reaches this function. Disabling
  // every day and pressing Save reads as "never available" but writes null,
  // which means the opposite — always available — so that path confirms first.
  // "Clear schedule" already says what it does on the button, so it does not.
  async function handleSave(value, isClear = false) {
    if (saving) return
    if (!isClear && value === null) {
      const ok = window.confirm(
        'No days are enabled. This clears the schedule and makes the category available at all times. Continue?'
      )
      if (!ok) return // modal stays open, draft untouched
    }
    setSaving(true)
    try {
      await onSave(value)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-5 border-b">
          <div className="min-w-0">
            <h3 className="font-bold text-lg truncate">{category.name}</h3>
            <p className="text-xs text-gray-500">Availability schedule</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none shrink-0">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <p className="text-xs text-gray-500">
            Turn on the days this category can be ordered. Leave both times blank for all day.
          </p>

          {WEEK_ORDER.map(dow => {
            const day = draft[String(dow)]
            const rowError = errors[String(dow)]
            return (
              <div key={dow}>
                <div className="flex items-center gap-2">
                  <span className="w-10 text-xs font-medium shrink-0">{DAY_LABEL[dow]}</span>
                  <Toggle
                    value={day.enabled}
                    onChange={val => updateDay(dow, 'enabled', val)}
                  />
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <input
                      type="time"
                      value={day.start}
                      disabled={!day.enabled}
                      onChange={e => updateDay(dow, 'start', e.target.value)}
                      className={`h-10 px-1 border rounded-lg text-xs flex-1 min-w-0 ${rowError ? 'border-red-400' : 'border-gray-300'} ${!day.enabled ? 'bg-gray-50 text-gray-400' : ''}`}
                    />
                    <span className="text-gray-400 text-xs shrink-0">to</span>
                    <input
                      type="time"
                      value={day.end}
                      disabled={!day.enabled}
                      onChange={e => updateDay(dow, 'end', e.target.value)}
                      className={`h-10 px-1 border rounded-lg text-xs flex-1 min-w-0 ${rowError ? 'border-red-400' : 'border-gray-300'} ${!day.enabled ? 'bg-gray-50 text-gray-400' : ''}`}
                    />
                  </div>
                </div>
                {rowError && (
                  <p className="mt-1 ml-12 text-xs text-red-500">{rowError}</p>
                )}
                {day.enabled && !day.start && !day.end && !rowError && (
                  <p className="mt-1 ml-12 text-xs text-gray-400">All day</p>
                )}
              </div>
            )
          })}

          <div className="pt-2 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Customers will see</p>
            <p className="mt-1 text-sm text-gray-700">
              {previewLabel ? `Only available ${previewLabel}` : 'Always available'}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 p-5 border-t">
          <button
            onClick={() => handleSave(null, true)}
            disabled={saving}
            className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
          >
            Clear schedule
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="h-9 px-4 rounded-lg text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => handleSave(draftToPayload(draft))}
              disabled={saving || hasErrors}
              className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-[#16A34A] disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
