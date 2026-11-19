/**
 * Shadow-mode guard for create-payment-intent. ZERO imports on purpose: this
 * is the only pos-v1 file the payment function imports statically, so nothing
 * in the pricing code (or its loading) can break the charge path.
 *
 * Guarantees, each covered by tests/shadowGuard.test.ts:
 *  - never throws (task, logger and waitUntil failures are all swallowed);
 *  - never blocks or delays: the task starts on a later microtask and is
 *    handed to EdgeRuntime.waitUntil; the caller returns its Response at once;
 *  - never changes the charge: withShadow returns the exact Response it was
 *    given, and the task works on a deep-cloned snapshot of the order data;
 *  - bounded: a hanging task is abandoned after `timeoutMs`.
 */

export type ShadowLog = (event: string, data: Record<string, unknown>) => void;

export interface ShadowOptions {
  timeoutMs: number;
  log: ShadowLog;
  /** Defaults to EdgeRuntime.waitUntil when present (Supabase edge runtime). */
  waitUntil?: (p: Promise<unknown>) => void;
}

export const SHADOW_TIMEOUT_MS = 5000;

function safeLog(log: ShadowLog, event: string, data: Record<string, unknown>): void {
  try {
    log(event, data);
  } catch {
    // a broken logger must not escape either
  }
}

function errMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unprintable error';
  }
}

/** Comma-separated restaurant ids (POS_V1_SHADOW_RESTAURANTS). Empty = off. */
export function parseShadowAllowlist(raw: string | undefined | null): Set<string> {
  try {
    return new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Deep copy of the client's order data, taken BEFORE create-payment-intent
 * mutates it (coord backfill, uber-field clearing), or null when shadow mode
 * is off for this restaurant or the copy fails. Never throws.
 */
export function takeShadowSnapshot<T>(allowlist: Set<string>, restaurantId: unknown, value: T): T | null {
  try {
    if (typeof restaurantId !== 'string' || !allowlist.has(restaurantId.toLowerCase())) return null;
    return structuredClone(value);
  } catch {
    return null;
  }
}

function defaultWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    return rt && typeof rt.waitUntil === 'function' ? (p) => rt.waitUntil(p) : undefined;
  } catch {
    return undefined;
  }
}

/** Run `task` in the background, bounded and fully isolated. Returns immediately. */
export function scheduleShadow(task: () => Promise<unknown>, opts: ShadowOptions): void {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
    });
    // .then(task): the task starts on a later microtask, so even a synchronous
    // throw inside it becomes a rejection here, never an exception to the caller.
    const run = Promise.resolve().then(task).then(() => 'done' as const);
    const guarded = Promise.race([run, timeout])
      .then((outcome) => {
        if (outcome === 'timeout') safeLog(opts.log, 'shadow timeout', { timeout_ms: opts.timeoutMs });
      })
      .catch((err) => safeLog(opts.log, 'shadow failed', { error: errMessage(err) }))
      .finally(() => clearTimeout(timer));
    // The abandoned task (on timeout) may still settle later; never let that be unhandled.
    run.catch(() => {});
    const waitUntil = opts.waitUntil ?? defaultWaitUntil();
    if (waitUntil) {
      try {
        waitUntil(guarded);
      } catch (err) {
        safeLog(opts.log, 'shadow waitUntil failed', { error: errMessage(err) });
      }
    }
  } catch (err) {
    safeLog(opts.log, 'shadow schedule failed', { error: errMessage(err) });
  }
}

/**
 * Return `response` unchanged, after scheduling `task` (if any) in the
 * background. The charge path's only touch point with shadow mode.
 */
export function withShadow(response: Response, task: (() => Promise<unknown>) | null, opts: ShadowOptions): Response {
  if (task) scheduleShadow(task, opts);
  return response;
}
