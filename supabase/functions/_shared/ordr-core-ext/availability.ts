/**
 * Category availability windows (SYNC-CONTRACT §4 "categories.availability").
 *
 * Same semantics as the web's `isCategoryAvailableNow`
 * (directbite src/utils/categoryAvailability.js) and pos-v1
 * `_shared/pos-v1/categoryWindow.ts`: per-day map keyed "0"(Sun).."6";
 * inclusive "HH:MM" bounds; an absent day is closed; a day with no/partial
 * times is open all day; overnight windows (start > end) never match; FAIL
 * OPEN on anything malformed. Uses the restaurant's timezone (like pos-v1).
 *
 * Two entry points:
 * - `normalizeAvailability(raw)`: the web jsonb blob → the wire's normalized
 *   form (null = can't restrict). Used by the server side (FakeServer, and the
 *   reference for directbite's snapshot builder) and by dev fixtures.
 * - `isCategoryAvailableAt(normalized, epochMs, timeZone)`: evaluation on the
 *   device (menu browser) and the server (submit-order availability_flag).
 *
 * Pure TypeScript, no imports: usable on device, in node and in Deno.
 */

export type Availability = Record<string, { start: string | null; end: string | null }> | null;

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string' || !TIME.test(value)) return null;
  return value.slice(0, 5);
}

/** Web blob → normalized enabled-days map; null = can't restrict (fail open). */
export function normalizeAvailability(raw: unknown): Availability {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, { start: string | null; end: string | null }> = {};
    let enabled = 0;
    for (const key of Object.keys(raw).sort()) {
      if (!/^[0-6]$/.test(key)) continue;
      const day = (raw as Record<string, unknown>)[key];
      if (day == null) continue;
      if (typeof day !== 'object' || Array.isArray(day)) return null;
      const d = day as Record<string, unknown>;
      if (d.enabled !== true) continue;
      const rawStart = d.start == null || d.start === '' ? null : d.start;
      const rawEnd = d.end == null || d.end === '' ? null : d.end;
      const start = rawStart === null ? null : normalizeTime(rawStart);
      const end = rawEnd === null ? null : normalizeTime(rawEnd);
      if (rawStart !== null && start === null) return null;
      if (rawEnd !== null && end === null) return null;
      out[key] = { start, end };
      enabled += 1;
    }
    return enabled === 0 ? null : out;
  } catch {
    return null;
  }
}

const WEEKDAY: Record<string, string> = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };

/** Day of week "0".."6" and "HH:MM" of `epochMs` in `timeZone`. */
export function localDayAndTime(epochMs: number, timeZone: string): { dow: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { dow: WEEKDAY[get('weekday')] ?? '', time: `${get('hour')}:${get('minute')}` };
}

/** Is a category with this (normalized) availability orderable at `epochMs`? Fails open. */
export function isCategoryAvailableAt(availability: Availability, epochMs: number, timeZone: string): boolean {
  try {
    if (!availability || typeof availability !== 'object') return true;
    if (Object.keys(availability).length === 0) return true;
    const { dow, time } = localDayAndTime(epochMs, timeZone);
    const day = availability[dow];
    if (!day) return false; // enabled elsewhere, not today
    if (!day.start || !day.end) return true; // all day (incl. partial)
    if (!HHMM.test(day.start) || !HHMM.test(day.end)) return true; // malformed -> open
    return time >= day.start && time <= day.end;
  } catch {
    return true;
  }
}
