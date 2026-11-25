/**
 * Server-side service hours (CP8, P6). A TIMEZONE-AWARE port of only what checkout enforcement
 * needs from the web's src/utils/serviceHours.js + src/utils/scheduling.js:
 *
 *  - normalizeSchedule / scheduleFromHours / getEffectiveSchedule — byte-for-byte rules
 *    (serviceHours.js:46-132): pickup = pickup_schedule ?? legacy hours; delivery =
 *    delivery_schedule ?? effective pickup; an invalid blob counts as unset; ≤ 2 windows/day.
 *  - isOpenAt — inclusive at open AND close, whole-second resolution (serviceHours.js:161-176).
 *  - isSlotAvailable — a scheduled time must sit inside a window of its local day, no earlier than
 *    window start + OPEN_BUFFER_MINUTES (scheduling.js:16, :122), no later than window end
 *    (:131), on one of the next SCHEDULE_DAYS local days (getAvailableDates daysAhead 7 = today..+6,
 *    :142-151), and not in the past.
 *
 * The web evaluates these on the BROWSER clock and timezone; here every "wall clock" value is the
 * instant seen in the restaurant's IANA timezone (restaurants.timezone, migration 099), so DST and
 * out-of-state customers can't shift the answer. Day keys "0".."6", 0 = Sunday.
 *
 * Deliberately NOT enforced (the web doesn't either, and the page may sit open): the 15-minute slot
 * grid and the "now + lead time" floor. A slot must only be in the future.
 */

export const MAX_WINDOWS = 2;
export const OPEN_BUFFER_MINUTES = 30;
export const SCHEDULE_DAYS = 7;

const DOW_KEYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

export interface Window {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}
export type Schedule = Record<string, Window[]>;

export interface HoursRow {
  day_of_week: number;
  is_open: boolean | null;
  open_time: string | null;
  close_time: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** "HH:MM" (24h) → minutes since midnight; anything else → null. */
export function parseHHMM(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function emptySchedule(): Schedule {
  const out: Schedule = {};
  for (const k of DOW_KEYS) out[k] = [];
  return out;
}

function normalizeWindows(raw: unknown): Window[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_WINDOWS) return null;
  const parsed: { start: number; end: number }[] = [];
  for (const w of raw) {
    if (!isPlainObject(w)) return null;
    const start = parseHHMM(w.start);
    const end = parseHHMM(w.end);
    if (start === null || end === null || start >= end) return null;
    parsed.push({ start, end });
  }
  parsed.sort((a, b) => a.start - b.start);
  for (let i = 1; i < parsed.length; i++) if (parsed[i].start < parsed[i - 1].end) return null;
  return parsed.map((w) => ({ start: toHHMM(w.start), end: toHHMM(w.end) }));
}

/** serviceHours.js normalizeSchedule: one bad enabled day invalidates the blob (→ null). */
export function normalizeSchedule(raw: unknown): Schedule | null {
  if (!isPlainObject(raw)) return null;
  const out = emptySchedule();
  for (const key of DOW_KEYS) {
    const day = raw[key];
    if (day == null) continue;
    if (!isPlainObject(day)) return null;
    if (day.enabled !== true) continue;
    const windows = normalizeWindows(day.windows);
    if (windows === null) return null;
    out[key] = windows;
  }
  return out;
}

function legacyTimeToHHMM(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^24:00(:00)?$/.test(value)) return '23:59';
  const hhmm = value.slice(0, 5);
  return parseHHMM(hhmm) === null ? null : hhmm;
}

/** serviceHours.js scheduleFromHours: FIRST row per day; empty / missing rows → null. */
export function scheduleFromHours(rows: HoursRow[] | null | undefined): Schedule | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = emptySchedule();
  for (const key of DOW_KEYS) {
    const row = rows.find((h) => h.day_of_week === Number(key));
    if (!row?.is_open) continue;
    const start = legacyTimeToHHMM(row.open_time);
    const end = legacyTimeToHHMM(row.close_time);
    if (start === null || end === null) continue;
    if (parseHHMM(start)! >= parseHHMM(end)!) continue;
    out[key] = [{ start, end }];
  }
  return out;
}

export function getEffectiveSchedule(
  restaurant: { pickup_schedule?: unknown; delivery_schedule?: unknown },
  hoursRows: HoursRow[] | null | undefined,
  type: 'pickup' | 'delivery',
): Schedule | null {
  const pickup = normalizeSchedule(restaurant.pickup_schedule) ?? scheduleFromHours(hoursRows);
  return type === 'pickup' ? pickup : normalizeSchedule(restaurant.delivery_schedule) ?? pickup;
}

// ---- timezone ----------------------------------------------------------------------------------

export interface LocalTime {
  /** YYYY-MM-DD in the zone */
  date: string;
  /** 0 = Sunday */
  dow: number;
  /** seconds since local midnight */
  sec: number;
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `instant` in `timeZone`. */
export function localTime(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dow: DOW_NAMES.indexOf(get('weekday')),
    sec: hour * 3600 + Number(get('minute')) * 60 + Number(get('second')),
  };
}

/** Whole local days from `a` to `b` (YYYY-MM-DD), calendar arithmetic (DST-proof). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ---- rules ---------------------------------------------------------------------------------------

/**
 * Open at `instant` (in `timeZone`)? Inclusive at both open and close, whole seconds — close 20:30
 * → open at 20:30:00, closed at 20:30:01 (serviceHours.js isOpenAt). A NULL schedule is CLOSED here:
 * that is what checkout shows (useRestaurant.js:128-130 and the legacy branch :157-161 both end up
 * closed when there are no hours), unlike isOpenAt(null) = "no info = open" in the web helper.
 */
export function isOpenAt(schedule: Schedule | null, instant: Date, timeZone: string): boolean {
  if (!schedule) return false;
  const t = localTime(instant, timeZone);
  return (schedule[String(t.dow)] ?? []).some((w) => t.sec >= parseHHMM(w.start)! * 60 && t.sec <= parseHHMM(w.end)! * 60);
}

export type SlotVerdict = 'ok' | 'past' | 'too_far' | 'outside_hours' | 'no_schedule';

/**
 * Can a scheduled order be placed for `slot` (checked at `now`)? See the file header for the rules.
 */
export function checkSlot(schedule: Schedule | null, slot: Date, now: Date, timeZone: string): SlotVerdict {
  if (!schedule) return 'no_schedule';
  if (slot.getTime() < now.getTime()) return 'past';
  const s = localTime(slot, timeZone);
  const n = localTime(now, timeZone);
  const days = dayDiff(n.date, s.date);
  if (days < 0 || days >= SCHEDULE_DAYS) return 'too_far';
  const ok = (schedule[String(s.dow)] ?? []).some((w) => {
    const earliest = (parseHHMM(w.start)! + OPEN_BUFFER_MINUTES) * 60;
    const latest = parseHHMM(w.end)! * 60;
    return s.sec >= earliest && s.sec <= latest;
  });
  return ok ? 'ok' : 'outside_hours';
}
