// Pure helpers for the tablet's split-hours editor (split_hours_enabled) and
// the Uber Direct schedule defaults. Node-importable for tests.
//
// Draft shape: { "0".."6": { open: bool, windows: [{ start, end }] } }.
// For an unconfigured restaurant, window 1 holds the `hours` row's values
// as read (raw "HH:MM:SS", or null), so an unedited simple save writes back
// exactly what was read.

import { normalizeSchedule, getEffectiveSchedule, isServiceConfigured, MAX_WINDOWS } from '../../utils/serviceHours.js'

export { MAX_WINDOWS }

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DEFAULT_WINDOW = { start: '09:00', end: '21:00' } // the legacy editor's defaults
const DOWS = [0, 1, 2, 3, 4, 5, 6]
const hhmm = t => (typeof t === 'string' ? t.slice(0, 5) : t)
const cloneDraft = d => JSON.parse(JSON.stringify(d))

export function draftFromRows(rows) {
  const out = {}
  for (const dow of DOWS) {
    const h = (rows || []).find(r => r.day_of_week === dow)
    out[String(dow)] = h
      ? { open: !!h.is_open, windows: [{ start: h.open_time, end: h.close_time }] }
      : { open: false, windows: [{ ...DEFAULT_WINDOW }] }
  }
  return out
}

function draftFromSchedule(schedule) {
  const out = {}
  for (const dow of DOWS) {
    const ws = schedule[String(dow)]
    out[String(dow)] = ws.length
      ? { open: true, windows: ws.map(w => ({ ...w })) }
      : { open: false, windows: [{ ...DEFAULT_WINDOW }] }
  }
  return out
}

// Unconfigured → from raw rows (exact round trip). Configured → from the
// effective schedules; "Same as pickup" = no valid stored delivery_schedule.
export function initialDrafts(restaurant, rows) {
  if (!isServiceConfigured(restaurant)) {
    const pickup = draftFromRows(rows)
    return { pickup, delivery: cloneDraft(pickup), sameAsPickup: true }
  }
  const eff = getEffectiveSchedule(restaurant, rows, 'pickup')
  const pickup = eff ? draftFromSchedule(eff) : draftFromRows([])
  const stored = normalizeSchedule(restaurant.delivery_schedule)
  return {
    pickup,
    delivery: stored ? draftFromSchedule(stored) : cloneDraft(pickup),
    sameAsPickup: stored === null,
  }
}

export const hasSecondWindow = draft =>
  DOWS.some(dow => draft[String(dow)].open && draft[String(dow)].windows.length > 1)

export function draftToStored(draft) {
  const out = {}
  for (const dow of DOWS) {
    const d = draft[String(dow)]
    out[String(dow)] = d.open
      ? { enabled: true, windows: d.windows.map(w => ({ start: hhmm(w.start), end: hhmm(w.end) })) }
      : { enabled: false, windows: [] }
  }
  return out
}

// One legacy row per day from window 1, values passed through untouched.
export const legacyRowsFromDraft = draft => DOWS.map(dow => {
  const d = draft[String(dow)]
  return { day_of_week: dow, is_open: d.open, open_time: d.windows[0].start, close_time: d.windows[0].end }
})

// First problem as an inline sentence, or null if valid.
export function validateDraft(draft, label) {
  for (const dow of DOWS) {
    const d = draft[String(dow)]
    if (!d.open) continue
    const day = DAY_NAMES[dow]
    const ws = d.windows.map(w => ({ start: hhmm(w.start), end: hhmm(w.end) }))
    for (const [i, w] of ws.entries()) {
      const which = ws.length > 1 ? (i === 0 ? 'first' : 'second') : ''
      if (!/^\d\d:\d\d$/.test(w.start || '') || !/^\d\d:\d\d$/.test(w.end || '')) {
        return `${label} – ${day}: set both times${which ? ` for the ${which} window` : ''}.`
      }
      if (w.end === '00:00') {
        return `${label} – ${day}: closing at midnight isn't supported. Use 11:59 PM.`
      }
      if (w.start >= w.end) {
        return `${label} – ${day}: the ${which ? `${which} ` : ''}window must end after it starts.`
      }
    }
    if (ws.length === 2) {
      const [a, b] = [...ws].sort((x, y) => (x.start < y.start ? -1 : 1))
      if (b.start < a.end) return `${label} – ${day}: the two windows overlap.`
    }
  }
  return normalizeSchedule(draftToStored(draft)) === null ? `${label}: these hours can't be saved.` : null
}

// `hours` writes as a plan, so the rules are testable without Supabase.
// Update by id (first row per day) / insert when missing; never deletes.
// preserveClosedTimes: a closed day updates is_open only, keeping the
// stored open_time/close_time.
export function planHoursWrites(rows, existingRows, { preserveClosedTimes = false } = {}) {
  return rows.map(r => {
    const existing = (existingRows || []).find(h => h.day_of_week === r.day_of_week)
    const full = { is_open: r.is_open, open_time: r.open_time, close_time: r.close_time }
    if (existing?.id) {
      return {
        type: 'update',
        id: existing.id,
        values: preserveClosedTimes && !r.is_open ? { is_open: false } : full,
      }
    }
    return { type: 'insert', values: { day_of_week: r.day_of_week, ...full } }
  })
}

// ---- Uber Direct schedule defaults ----------------------------------------
// bufferBeforeClose and defaultsFromHours are moved verbatim from
// SettingsTab.jsx (lines 17-26 and 141-165 on main).

// Default Uber Direct schedule buffer (minutes): stop accepting Uber deliveries
// this long before the restaurant's posted close, so a courier isn't still
// inbound at closing. Applied only to the AUTO-DERIVED default end time — the
// operator can override per day. Clamps at 00:00 (no wrap to the prior day).
const UBER_SCHEDULE_CLOSE_BUFFER_MIN = 30
export function bufferBeforeClose(hhmm, bufferMin = UBER_SCHEDULE_CLOSE_BUFFER_MIN) {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  let total = h * 60 + m - bufferMin
  if (total < 0) total = 0
  const bh = String(Math.floor(total / 60)).padStart(2, '0')
  const bm = String(total % 60).padStart(2, '0')
  return `${bh}:${bm}`
}

// M5b — Derive an uber_schedule jsonb object from the restaurant's
// existing Hours table. If a day is open in hours → enabled with that
// day's open_time/close_time (normalized to HH:MM). Otherwise disabled.
// Returns `fallback` when hours is empty/unloaded (DEFAULT_UBER_SCHEDULE
// is the canonical fallback).
export function defaultsFromHours(hoursArray, fallback) {
  if (!hoursArray || hoursArray.length === 0) return fallback
  const result = {}
  for (let dow = 0; dow <= 6; dow++) {
    const dayHours = hoursArray.find(h => h.day_of_week === dow)
    if (dayHours?.is_open && dayHours.open_time && dayHours.close_time) {
      // hours.open_time/close_time may be stored as "HH:MM:SS"; truncate
      // to "HH:MM" to match the uber_schedule jsonb convention. Default the
      // end 30 min before close (buffer) so Uber isn't dispatching right up
      // to closing — but only if that still leaves a valid window; otherwise
      // fall back to the raw close time.
      const start = dayHours.open_time.slice(0, 5)
      const close = dayHours.close_time.slice(0, 5)
      const buffered = bufferBeforeClose(close)
      result[String(dow)] = {
        enabled: true,
        start,
        end: buffered > start ? buffered : close,
      }
    } else {
      result[String(dow)] = { enabled: false }
    }
  }
  return result
}

// Configured: first window start → last window end, minus the same buffer.
export function defaultsFromSchedule(schedule, fallback) {
  if (!schedule) return fallback
  const result = {}
  for (const dow of DOWS) {
    const ws = schedule[String(dow)]
    if (ws.length > 0) {
      const start = ws[0].start
      const close = ws[ws.length - 1].end
      const buffered = bufferBeforeClose(close)
      result[String(dow)] = { enabled: true, start, end: buffered > start ? buffered : close }
    } else {
      result[String(dow)] = { enabled: false }
    }
  }
  return result
}

// Configured → the SAVED restaurant's effective delivery schedule.
// Unconfigured → today's path on `legacyRows` (the editor's rows).
export function uberScheduleDefaults(restaurant, rows, legacyRows, fallback) {
  if (isServiceConfigured(restaurant)) {
    return defaultsFromSchedule(getEffectiveSchedule(restaurant, rows, 'delivery'), fallback)
  }
  return defaultsFromHours(legacyRows, fallback)
}

// Day-toggle seed for a configured restaurant: delivery's first start / last
// end, with no buffer (matching the legacy toggle path). null when closed or
// unconfigured; the caller then runs its legacy code.
export function configuredDaySeed(restaurant, rows, dow) {
  if (!isServiceConfigured(restaurant)) return null
  const ws = getEffectiveSchedule(restaurant, rows, 'delivery')?.[String(dow)] || []
  return ws.length ? { start: ws[0].start, end: ws[ws.length - 1].end } : null
}
