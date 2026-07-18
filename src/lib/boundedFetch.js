// ============================================================================
// boundedFetch — bounded, hedged loader for the customer read-path queries
// ============================================================================
//
// Problem: the customer boot queries (useRestaurant / useMenu /
// CustomDomainShell) run on the default Supabase client, which has no
// per-request timeout. A stalled TCP connection never resolves and never
// rejects, so the page's `loading` flag stays true forever and the customer is
// stranded on skeletons with no recovery. A DIFFERENT failure mode — a fast
// transport rejection (wifi→cellular drop, DNS failure, connection refused) —
// resolves instantly with an error; that must NOT be read as a semantic answer.
//
// Policy (bounded — deliberately NOT the reverted indefinite-retry design):
//   - An attempt-group is an ANSWER only if every query either succeeded or
//     returned a DEFINITIVE error (a PostgREST/Supabase error carrying a `code`
//     — PGRST116 no-rows, RLS denial, 4xx, etc.). Those resolve the race and
//     are handed to the caller unchanged.
//   - A TRANSPORT error (TypeError / "Failed to fetch" / "NetworkError" /
//     "Load failed" / any code-less, non-abort error) is NOT an answer. It
//     triggers the hedge IMMEDIATELY (no 2500ms wait) so a fresh attempt can
//     race. Our own deliberate aborts (deadline / supersede / unmount) are not
//     transport failures.
//   - HEDGE at 2500ms (or immediately on a transport failure): fire ONE fresh
//     parallel attempt (new controller → new sockets) and RACE it. First group
//     to return an ANSWER wins; the loser is aborted. Attempt 1 is not aborted
//     at the hedge mark — a slow-but-healthy request must still be able to win.
//   - If BOTH attempts fail without an answer, or the 10s HARD DEADLINE fires,
//     return { timedOut: true } so callers show a connection-error + Retry UI
//     rather than a misleading semantic error.
//   - onStalled() fires once, when the hedge starts.
//
// Operates on a GROUP of query-builder factories sharing one deadline (pass the
// same `deadlineAt` to every call in one load), so a future progressive loader
// can invoke it once per phase. A single query is just a group of one.
//
// Return shape (never throws):
//   { results, timedOut, cancelled }
//     - results:   array of Supabase-style { data, error }, in factory order
//                  (null when timedOut or cancelled)
//     - timedOut:  true if both attempts failed / the hard deadline fired
//     - cancelled: true if the outer signal aborted (caller unmounted/superseded)
//
// A factory is (signal) => <thenable resolving to { data, error }>. Thread the
// signal via .abortSignal(signal) so an abort actually cancels the socket.
// ============================================================================

const DEFAULT_SLOW_MS = 2500
const DEFAULT_HARD_MS = 10000

// Our deliberate aborts (per-attempt deadline, supersede, unmount) surface as
// AbortError — never a transport failure to retry.
function isAbortError(e) {
  if (!e) return false
  if (e.name === 'AbortError') return true
  return (e.message || '').toLowerCase().includes('abort')
}

// A DEFINITIVE Supabase/PostgREST answer-error carries a non-empty `code`
// (PGRST116 no-rows, RLS 42501, 4xx, etc.). Transport failures from supabase-js
// have no code (or code === ''), so they fall through to "transport".
function isDefinitiveError(e) {
  return !!(e && e.code)
}

// Classify a settled attempt-group:
//   'answer'    — every query succeeded or returned a definitive (coded) error
//   'transport' — at least one query hit a code-less, non-abort transport error
//   'aborted'   — no transport error, but at least one query was aborted by us
function classifyGroup(results) {
  let sawTransport = false
  let sawAborted = false
  for (const r of results) {
    const e = r?.error
    if (!e) continue
    if (isAbortError(e)) { sawAborted = true; continue }
    if (isDefinitiveError(e)) continue // coded → part of the answer
    sawTransport = true // code-less, non-abort → transport failure
  }
  if (sawTransport) return 'transport'
  if (sawAborted) return 'aborted'
  return 'answer'
}

// Run one attempt-group: every factory invoked with the same per-attempt
// signal, each normalized so a thrown/rejected query becomes { data, error }.
// Resolves to the results array only when ALL factories in the group settle.
function runGroup(factories, signal) {
  return Promise.all(
    factories.map((fn) =>
      Promise.resolve()
        .then(() => fn(signal))
        .then((r) => r)
        .catch((error) => ({ data: null, error }))
    )
  )
}

export async function boundedFetch(factories, opts = {}) {
  const {
    slowMs = DEFAULT_SLOW_MS,
    hardMs = DEFAULT_HARD_MS,
    // Absolute timestamp (Date.now()-based) for the hard deadline. Pass the SAME
    // value to every boundedFetch call in one load() so the total ceiling is
    // shared across groups (restaurant + hours get 10s together, not 10s each).
    deadlineAt,
    onStalled,
    signal, // optional outer AbortSignal for unmount / supersede
  } = opts

  // Remaining budget for THIS call (clamped ≥ 0 → immediate timeout).
  const effectiveHardMs = deadlineAt != null
    ? Math.max(0, deadlineAt - Date.now())
    : hardMs

  if (signal?.aborted) return { results: null, timedOut: false, cancelled: true }

  return new Promise((resolveOuter) => {
    const c1 = new AbortController()
    let c2 = null
    let slowTimer
    let hardTimer
    let hedgeStarted = false
    let a1Dead = false
    let a2Dead = false
    let settled = false

    const onOuterAbort = () => {
      c1.abort(); c2?.abort()
      finish({ results: null, timedOut: false, cancelled: true })
    }
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true })

    function finish(value) {
      if (settled) return
      settled = true
      clearTimeout(slowTimer)
      clearTimeout(hardTimer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
      resolveOuter(value)
    }

    function finishAnswer(results, loser) {
      loser?.abort()
      if (signal?.aborted) return finish({ results: null, timedOut: false, cancelled: true })
      finish({ results, timedOut: false, cancelled: false })
    }

    function finishTimeout() {
      c1.abort(); c2?.abort()
      if (signal?.aborted) return finish({ results: null, timedOut: false, cancelled: true })
      finish({ results: null, timedOut: true, cancelled: false })
    }

    function startHedge() {
      if (hedgeStarted || settled) return
      hedgeStarted = true
      clearTimeout(slowTimer)
      if (typeof onStalled === 'function') { try { onStalled() } catch { /* ignore */ } }
      c2 = new AbortController()
      if (signal?.aborted) c2.abort()
      runGroup(factories, c2.signal).then((results) => {
        if (settled) return
        if (classifyGroup(results) === 'answer') return finishAnswer(results, c1)
        a2Dead = true
        if (a1Dead) finishTimeout() // both attempts failed without an answer
      })
    }

    // Attempt 1.
    runGroup(factories, c1.signal).then((results) => {
      if (settled) return
      const kind = classifyGroup(results)
      if (kind === 'answer') return finishAnswer(results, c2)
      a1Dead = true
      // Transport failure fast-fails → start the hedge NOW instead of waiting.
      if (kind === 'transport') startHedge()
      if (a2Dead) finishTimeout()
    })

    // Normal slow path: hedge at slowMs.
    slowTimer = setTimeout(startHedge, slowMs)
    // Hard ceiling: covers a true stall where neither attempt ever settles.
    hardTimer = setTimeout(finishTimeout, effectiveHardMs)
  })
}
