/**
 * The ready email, sent EXACTLY as the web tablet sends it (src/pages/tablet/OrdersTab.jsx :711-718 — confirmReadyTime):
 *   POST {SUPABASE_URL}/functions/v1/send-ready-email
 *   Content-Type: application/json, Authorization: Bearer <anon key>, body {"order_id": "…"}
 * fire-and-forget (the tablet doesn't await it; send-ready-email makes every send / skip decision itself, incl. its
 * own ready_email_sent_at guard). The POS caller adds once-per-order (pos_online_actions.ready_email_sent) and never
 * calls it on a duplicate. Handed to EdgeRuntime.waitUntil so the answer to the register is not delayed.
 */
export interface ReadyEmailOptions {
  supabaseUrl: string;
  anonKey: string;
  fetch?: typeof fetch;
  /** Defaults to EdgeRuntime.waitUntil when present (Supabase edge runtime). */
  waitUntil?: (p: Promise<unknown>) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export function sendReadyEmailRequest(o: Pick<ReadyEmailOptions, 'supabaseUrl' | 'anonKey'>, orderId: string): { url: string; init: RequestInit } {
  return {
    url: `${o.supabaseUrl.replace(/\/+$/, '')}/functions/v1/send-ready-email`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.anonKey}` },
      body: JSON.stringify({ order_id: orderId }),
    },
  };
}

function defaultWaitUntil(): ((p: Promise<unknown>) => void) | undefined {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  return rt && typeof rt.waitUntil === 'function' ? (p) => rt.waitUntil(p) : undefined;
}

/** (orderId) => void — never throws; failures are logged (the tablet's .catch(() => {}) logs nothing). */
export function makeReadyEmail(o: ReadyEmailOptions): (orderId: string) => void {
  const f = o.fetch ?? fetch;
  return (orderId: string) => {
    try {
      const { url, init } = sendReadyEmailRequest(o, orderId);
      const p = f(url, init)
        .then(async (r) => {
          if (!r.ok) o.log('online_ready_email_failed', { order_id: orderId, status: r.status });
          await r.body?.cancel();
        })
        .catch((e) => o.log('online_ready_email_failed', { order_id: orderId, error: String(e) }));
      try {
        (o.waitUntil ?? defaultWaitUntil())?.(p);
      } catch {
        // waitUntil unavailable: the promise still runs
      }
    } catch (e) {
      o.log('online_ready_email_failed', { order_id: orderId, error: String(e) });
    }
  };
}
