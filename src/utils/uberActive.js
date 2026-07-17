// ============================================================================
// Uber Direct "is it active right now?" — browser-safe port
// ============================================================================
//
// Client-side mirror of the UD-active determination in
// supabase/functions/_shared/uberMode.ts (resolveMode). Used by the tablet
// header to show a live "Uber Direct Active" badge without a network round
// trip. This is a READ of existing restaurant state — no DB writes, no edge
// calls. It must track resolveMode exactly; if that Deno file changes, update
// this port to match.
//
// Deno file is the source of truth; we cannot import it (Deno-only), so the
// helpers are re-implemented here as local functions.
//
// Time boundary semantics (mirrored): start inclusive, end exclusive —
// "11:00"–"22:00" means active 11:00 through 21:59 (current >= start &&
// current < end). Overnight windows (start > end) are NOT supported — same
// limitation as the edge function; they evaluate as outside-range.
// ============================================================================

/**
 * Extract day-of-week ("0"=Sun.."6"=Sat) and "HH:MM" 24-hour time string in
 * America/New_York. Mirrors getNyTimeComponents in uberMode.ts: build a Date
 * from the NY-localized string, then read local getDay/getHours/getMinutes.
 */
function getNyTimeComponents(date) {
  const nyLocal = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = String(nyLocal.getDay());
  const hour = String(nyLocal.getHours()).padStart(2, '0');
  const minute = String(nyLocal.getMinutes()).padStart(2, '0');
  return { dow, time: `${hour}:${minute}` };
}

/**
 * True if `current` falls in [start, end) — start inclusive, end exclusive.
 * All "HH:MM" 24-hour strings; lexicographic compare is correct for the format.
 * Mirrors isInTimeWindow in uberMode.ts.
 */
function isInTimeWindow(current, start, end) {
  if (!start || !end) return false;
  return current >= start && current < end;
}

/**
 * Is Uber Direct the active fulfillment method for this restaurant right now?
 *
 * Mirrors resolveMode(): returns true iff resolveMode would resolve to
 * 'uber_direct' for the given moment.
 *
 * @param {object} restaurant - needs delivery_fulfillment, uber_billing_mode,
 *   uber_credentials_verified_at, uber_direct_active, uber_schedule.
 * @param {Date} [now] - injectable clock (defaults to real now).
 * @returns {boolean}
 */
export function isUberActiveNow(restaurant, now = new Date()) {
  if (!restaurant) return false;
  const mode = restaurant.delivery_fulfillment;

  // Branch 1: in_house — never Uber.
  if (mode === 'in_house') return false;

  // Platform restaurants share the DirectBite Uber account; their creds live
  // in env vars, so they're never stamped with uber_credentials_verified_at.
  // Treat platform as ready. (Matches uberMode.ts lines 109-110.)
  const isPlatform = (restaurant.uber_billing_mode ?? 'self') === 'platform';
  const credentialsVerified = isPlatform || !!restaurant.uber_credentials_verified_at;

  // Branch 2: uber_direct only.
  if (mode === 'uber_direct') {
    return credentialsVerified;
  }

  // Branch 3: both.
  if (mode === 'both') {
    if (!credentialsVerified) return false;
    // Manual realtime override wins over schedule.
    if (restaurant.uber_direct_active === true) return true;
    try {
      const { dow, time } = getNyTimeComponents(now);
      const daySchedule = restaurant.uber_schedule?.[dow];
      return !!(daySchedule?.enabled && isInTimeWindow(time, daySchedule.start, daySchedule.end));
    } catch (err) {
      // Corrupt schedule → inactive (edge falls back to in_house here).
      return false;
    }
  }

  // Defensive: null / unknown mode.
  return false;
}
