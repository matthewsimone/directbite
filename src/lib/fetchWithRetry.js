// ============================================================================
// fetchWithRetry — silent, indefinite retry wrapper for Supabase boot queries
// ============================================================================
//
// Problem this solves: the customer boot-chain queries (useRestaurant /
// useMenu / CustomDomainShell) have no per-request timeout. A stalled TCP
// connection never rejects, so the page's `loading` stays true forever and the
// user is stranded on the green spinner with no recovery but a manual reload.
//
// Policy (locked by design):
//   - Per-attempt deadline: 3000ms. If an attempt hasn't resolved in 3s, abort
//     it (via AbortController → Supabase .abortSignal) and start a fresh one.
//   - Backoff between attempts: 500ms.
//   - Retry INDEFINITELY on stall, abort, or transport/5xx error. Never give
//     up, never surface an error for a stall/failure. The spinner keeps
//     spinning while we silently retry until the fetch succeeds.
//   - HARD STOP only on a definitive answer:
//       (a) success (no transport error) — including success-empty, AND
//       (b) PostgREST "no rows" (PGRST116) from .single()/.maybeSingle(),
//           which is a real "not found" the caller should surface — NOT a
//           retryable failure.
//
// Return shape is backwards-compatible: it resolves to a Supabase-style
// `{ data, error }` object — the exact result of the first definitive attempt.
// On outer-signal cancel (caller unmounted) it resolves to a cancelled
// sentinel `{ data: null, error: { __cancelled: true, ... } }` so callers can
// skip both success and not-found handling; this is still `{ data, error }`
// shaped and never throws.
//
// Usage:
//   const res = await fetchWithRetry(
//     (signal) => supabase.from('restaurants').select('*').eq('slug', slug).single().abortSignal(signal),
//     { signal: outerAbortController.signal }
//   )
//   // res === { data, error } — handle exactly like a normal Supabase result.
//
// queryFn receives the per-attempt AbortSignal. Threading it into the builder
// via .abortSignal(signal) is what lets the 3s deadline actually cancel the
// in-flight socket. A queryFn that ignores the arg still works (the race +
// backoff still advances), it just can't hard-cancel the dead socket.
// ============================================================================

const DEFAULT_DEADLINE_MS = 3000
const DEFAULT_BACKOFF_MS = 500

// A Supabase/PostgREST result is a DEFINITIVE "no rows" answer when .single()
// (or .maybeSingle() coercion) finds zero matching rows. PostgREST returns
// code 'PGRST116' for this. We treat it as a stop-and-surface answer (genuine
// "restaurant not found"), NOT a retryable transport failure. The textual
// fallbacks guard against SDK/proxy variations that drop the code.
function isDefinitiveNoRows(error) {
  if (!error) return false
  if (error.code === 'PGRST116') return true
  const msg = (error.message || '').toLowerCase()
  return (
    msg.includes('no rows') ||
    msg.includes('0 rows') ||
    msg.includes('multiple (or no) rows')
  )
}

// Resolve-after-ms that also short-circuits if the outer signal aborts, so a
// cancelled caller doesn't sit through the backoff before bailing.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => { clearTimeout(t); resolve() },
        { once: true }
      )
    }
  })
}

function cancelledResult() {
  return {
    data: null,
    error: { name: 'AbortError', message: 'fetchWithRetry cancelled', __cancelled: true },
  }
}

export async function fetchWithRetry(queryFn, opts = {}) {
  const {
    deadlineMs = DEFAULT_DEADLINE_MS,
    backoffMs = DEFAULT_BACKOFF_MS,
    signal, // optional outer AbortSignal for unmount/route-change cancel
  } = opts

  // Loop forever until a definitive answer (success, no-rows) or outer cancel.
  for (;;) {
    if (signal?.aborted) return cancelledResult()

    const attempt = new AbortController()
    // Propagate an outer cancel into the in-flight attempt.
    const onOuterAbort = () => attempt.abort()
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true })

    let timer
    try {
      // Fresh builder per attempt — each call to queryFn is independent.
      const queryPromise = Promise.resolve(queryFn(attempt.signal))
      // Swallow a LATE rejection: if the deadline wins the race, the query may
      // still reject afterward (AbortError); without this it becomes an
      // unhandled promise rejection.
      queryPromise.catch(() => {})

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          attempt.abort() // cancel the in-flight socket
          reject(new Error('attempt_deadline'))
        }, deadlineMs)
      })

      const result = await Promise.race([queryPromise, timeoutPromise])
      const error = result?.error

      if (!error) {
        // Definitive success (data may be empty, e.g. maybeSingle no-match).
        return result
      }
      if (isDefinitiveNoRows(error)) {
        // Definitive "not found" — surface to caller, do not retry.
        return result
      }
      // Any other error (transport / 5xx / RLS / etc.) → retryable.
    } catch {
      // Thrown error, abort, or deadline → retryable. Fall through to backoff.
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
    }

    // Outer cancel happened during the attempt → bail before sleeping.
    if (signal?.aborted) return cancelledResult()

    await sleep(backoffMs, signal)
  }
}
