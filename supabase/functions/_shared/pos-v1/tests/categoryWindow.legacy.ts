// TEST-ONLY copy of the removed _shared/pos-v1/categoryWindow.ts (item 4), kept to prove the
// vendored availability.ts gives identical verdicts. Do not import outside tests.
/**
 * Category availability windows (menu_categories.availability, migration 086).
 *
 * Port of src/utils/categoryAvailability.js isCategoryAvailableNow, same
 * semantics: per-day map keyed "0"(Sun).."6"; enabled day with no/partial
 * times = all day; an absent or disabled day = closed that day (if any day is
 * enabled); inclusive "HH:MM" bounds; FAILS OPEN on anything malformed or on
 * a blob with no enabled day.
 *
 * One deliberate difference: the web reads America/New_York hardcoded; this
 * reads the restaurant's timezone (every restaurant is New York today, so the
 * result is identical).
 *
 * The web enforces this only in the browser (ItemModal, MenuPage), at
 * add-to-cart time. Nothing server-side checks it today. pos-v1 does NOT
 * reject on it yet: the loader reports violations as diagnostics and shadow
 * mode logs them (class `category_window`).
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

type Parsed = Record<string, { start: string | null; end: string | null }>;

function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string' || !TIME.test(value)) return null;
  return value.slice(0, 5);
}

/** null = this blob cannot restrict anything (fail open). */
function parseAvailability(availability: unknown): Parsed | null {
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) return null;
  const parsed: Parsed = {};
  let enabled = 0;
  for (const key of Object.keys(availability)) {
    if (!/^[0-6]$/.test(key)) continue;
    const day = (availability as Record<string, unknown>)[key];
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
    parsed[key] = { start, end };
    enabled++;
  }
  return enabled === 0 ? null : parsed;
}

const WEEKDAY: Record<string, string> = { Sun: '0', Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6' };

/** { dow "0".."6", time "HH:MM" } of `now` in `timeZone`. */
export function localDayAndTime(now: Date, timeZone: string): { dow: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { dow: WEEKDAY[get('weekday')] ?? '', time: `${get('hour')}:${get('minute')}` };
}

/** Is a category with this availability blob orderable at `now`? Fails open. */
export function isCategoryAvailableAt(availability: unknown, now: Date, timeZone: string): boolean {
  try {
    const parsed = parseAvailability(availability);
    if (!parsed) return true;
    const { dow, time } = localDayAndTime(now, timeZone);
    const day = parsed[dow];
    if (!day) return false;
    if (!day.start || !day.end) return true;
    return time >= day.start && time <= day.end;
  } catch {
    return true;
  }
}
