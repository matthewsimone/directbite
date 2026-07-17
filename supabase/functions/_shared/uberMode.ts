// ============================================================================
// Uber Direct mode resolution — pure function library
// ============================================================================
//
// Single source of truth for "given a restaurant + current time, what
// fulfillment mode applies?" Used by uber-quote (M5a) and any future
// Uber-facing edge function that needs to know whether to dispatch via
// Uber or fall back to in-house.
//
// Pure function — no DB calls, no network. Caller is responsible for
// fetching the restaurant row and passing it in. This makes the function
// unit-testable in isolation.
//
// Decision tree:
//   1. delivery_fulfillment = 'in_house'  → in_house, no quote needed
//   2. delivery_fulfillment = 'uber_direct':
//      - if !credentials_verified → fallback in_house (reason)
//      - else → uber_direct, requires quote
//   3. delivery_fulfillment = 'both':
//      - if !credentials_verified → fallback in_house
//      - if uber_direct_active = true → uber_direct (reason: realtime_toggle)
//      - else evaluate schedule for current NY day/time:
//        - if today enabled AND now in [start, end) → uber_direct (schedule)
//        - else → in_house (schedule_inactive)
//
// Time boundary semantics: start inclusive, end exclusive — i.e., a window
// of "11:00" to "22:00" means 11:00–21:59 (current >= start && current < end).
// Matches "close at 22:00" mental model.
//
// Overnight schedules (start > end, e.g., "22:00" to "02:00") are NOT
// supported in v1. Such windows will always evaluate as outside-range.
// Documented as a known limitation; future enhancement.
//
// Schedule jsonb corruption is handled defensively: any parse/access error
// falls back to in_house with reason 'schedule_error'.
// ============================================================================

export interface ScheduleDay {
  enabled: boolean;
  start?: string; // "HH:MM" 24-hour, required when enabled
  end?: string;   // "HH:MM" 24-hour, required when enabled
}

export type Schedule = Record<string, ScheduleDay>; // keys "0"-"6" (Sun-Sat)

export interface RestaurantForMode {
  delivery_fulfillment: string | null;
  uber_credentials_verified_at: string | null;
  uber_direct_active: boolean | null;
  uber_schedule: Schedule | null;
  uber_billing_mode: string | null;
}

export type ResolveReason =
  | 'credentials_not_verified'
  | 'realtime_toggle'
  | 'schedule'
  | 'schedule_inactive'
  | 'schedule_error'
  | 'unknown_mode';

export interface ModeResolution {
  resolved_mode: 'in_house' | 'uber_direct';
  requires_quote: boolean;
  reason?: ResolveReason;
}

/**
 * Extract day-of-week (0=Sun..6=Sat) and "HH:MM" 24-hour time string in
 * America/New_York timezone.
 *
 * Uses toLocaleString to get a Date object normalized to NY-local time,
 * then reads .getDay()/.getHours()/.getMinutes() from that. Deno's V8
 * has full ICU/CLDR support, so 'America/New_York' resolves correctly
 * including DST.
 */
function getNyTimeComponents(date: Date): { dow: string; time: string } {
  const nyLocal = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = String(nyLocal.getDay());
  const hour = String(nyLocal.getHours()).padStart(2, '0');
  const minute = String(nyLocal.getMinutes()).padStart(2, '0');
  return { dow, time: `${hour}:${minute}` };
}

/**
 * Check if `current` falls in [start, end) — start inclusive, end exclusive.
 * All inputs are "HH:MM" 24-hour strings; lexicographic comparison is
 * correct for this format.
 */
function isInTimeWindow(current: string, start?: string, end?: string): boolean {
  if (!start || !end) return false;
  return current >= start && current < end;
}

export function resolveMode(
  restaurant: RestaurantForMode,
  currentDate?: Date
): ModeResolution {
  const mode = restaurant.delivery_fulfillment;

  // Branch 1: in_house — never quote
  if (mode === 'in_house') {
    return { resolved_mode: 'in_house', requires_quote: false };
  }

  // Platform restaurants use the shared DirectBite Uber account — their creds
  // live in env vars and are validated in uberToken/uberCreds, so they are
  // never stamped with uber_credentials_verified_at. Treat platform as ready.
  const isPlatform = (restaurant.uber_billing_mode ?? 'self') === 'platform';
  const credentialsVerified = isPlatform || !!restaurant.uber_credentials_verified_at;

  // Branch 2: uber_direct only
  if (mode === 'uber_direct') {
    if (!credentialsVerified) {
      return { resolved_mode: 'in_house', requires_quote: false, reason: 'credentials_not_verified' };
    }
    return { resolved_mode: 'uber_direct', requires_quote: true };
  }

  // Branch 3: both
  if (mode === 'both') {
    if (!credentialsVerified) {
      return { resolved_mode: 'in_house', requires_quote: false, reason: 'credentials_not_verified' };
    }
    if (restaurant.uber_direct_active === true) {
      return { resolved_mode: 'uber_direct', requires_quote: true, reason: 'realtime_toggle' };
    }
    try {
      const { dow, time } = getNyTimeComponents(currentDate || new Date());
      const daySchedule = restaurant.uber_schedule?.[dow];
      if (daySchedule?.enabled && isInTimeWindow(time, daySchedule.start, daySchedule.end)) {
        return { resolved_mode: 'uber_direct', requires_quote: true, reason: 'schedule' };
      }
      return { resolved_mode: 'in_house', requires_quote: false, reason: 'schedule_inactive' };
    } catch (err) {
      console.error('[uberMode] schedule parse/access error:', err);
      return { resolved_mode: 'in_house', requires_quote: false, reason: 'schedule_error' };
    }
  }

  // Defensive: unknown / null mode value (e.g., DB row from before M2 migration)
  return { resolved_mode: 'in_house', requires_quote: false, reason: 'unknown_mode' };
}
