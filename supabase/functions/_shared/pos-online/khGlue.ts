/**
 * KitchenHub actions for marketplace orders from a register (CP21): ext_accept / ext_ready / ext_cancel =
 * kh-order-action's logic UNCHANGED. The shared modules are IMPORTED UNCHANGED: _shared/khNormalize.ts
 * (normalizeStatus, resolveStatus — imported here) and _shared/khToken.ts khFetch (passed in by the entry point, so
 * tests need no KitchenHub credentials).
 *
 * COPIED web handler glue, each range pinned by hash (_shared/pos-online/webPins.json; scripts/check-ordr-core.mjs
 * fails if a range changes or this file stops citing its hash — then re-copy, re-review, re-pin):
 *   kh-order-action/index.ts :59-72    sha256 1d5a262f05bf280ee3aab342efd27fb73fa0b31fe3046fab19aa0e6d4be80f54
 *     (action → target status, the status each action needs, the "not main account" message)
 *   kh-order-action/index.ts :81-126   sha256 ea2d2bd718a991151a3c69ef8ec4d861940e19d0e7acefbd4ba2edfc125004ac
 *     (writeStatus: the forward-only compare-and-set status write + timestamps; readKhError)
 *   kh-order-action/index.ts :207-219  sha256 76599213e7cc732d6caf5a575df1bf3d82f831cae9e9a1d969f9cbc3dac4c52f
 *     (the store gate: kitchenhub_stores.enabled)
 *   kh-order-action/index.ts :228-304  sha256 2707efa1f8c22798baee79102e763f897b4e63762eb0f8a879530a62413f2274
 *     (PUT /v2/orders/{id}/status/ → 200 write / 409 GET + sync / 403 not main account / else kitchenhub_error)
 *
 * The copies differ from the web lines ONLY in:
 *   1. every `return jsonResponse(…)` → a typed result (handlers.ts maps it to the §3c wire);
 *   2. console.log / warn / error → the injected log (same facts, event names kh_action_*);
 *   3. `new Date()` → the injected clock (tests); the module-level `supabase` client → the injected one;
 *   4. the tablet's request fields (external_order_id, action, prep_time) are the register's (order id, the ext_*
 *      action, prep_minutes).
 * The web handler's auth (tablet email) is replaced by the device middleware + the restaurant check, its body
 * validation (prep_time 1–240) by the contract's (prep_minutes 1–240, handlers.ts), and its status precondition by
 * the §3c compare-and-set on expected_status + REQUIRED_STATUS below (handlers.ts).
 */
import { normalizeStatus, resolveStatus, type OrderStatus } from '../khNormalize.ts';

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

export interface KhGlueDeps {
  supabase: Db;
  /** _shared/khToken.ts khFetch, imported unchanged by the entry point. */
  khFetch: (supabase: Db, path: string, init?: RequestInit) => Promise<Response>;
  log: (event: string, data?: Record<string, unknown>) => void;
  now: () => number;
}

// ---- kh-order-action/index.ts :59-72 -----------------------------------------------------------------------------

export type Action = 'accept' | 'complete' | 'cancel';
export const TARGET: Record<Action, OrderStatus> = {
  accept: 'accepted',
  complete: 'completed',
  cancel: 'cancelled',
};
// DSPs reject cancel after accept, so cancel is only offered on 'new'.
export const REQUIRED_STATUS: Record<Action, string> = {
  accept: 'new',
  complete: 'accepted',
  cancel: 'new',
};
export const NOT_MAIN_ACCOUNT_MESSAGE =
  'This provider is connected elsewhere (read-only). Disconnect the provider tablet or other integration.';

// ---- kh-order-action/index.ts :81-126 ----------------------------------------------------------------------------

// Compare-and-set status write. Re-reads the current status, resolves it
// forward-only against `target`, and updates only if the row still holds the
// status we read — so a webhook landing mid-request (e.g. a provider cancel)
// is never overwritten. Two attempts; returns the stored status, or null on a
// DB failure. Timestamps are written only when the target status is reached.
async function writeStatus(
  d: KhGlueDeps,
  id: string,
  target: OrderStatus,
  stamps: Record<string, unknown>,
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: cur, error: readErr } = await d.supabase
      .from('external_orders')
      .select('status')
      .eq('id', id)
      .maybeSingle();
    if (readErr || !cur) {
      d.log('kh_action_status_reread_failed', { id, error: readErr?.message ?? null });
      return null;
    }
    const next = resolveStatus(cur.status, target);
    const patch: Record<string, unknown> = {
      status: next,
      updated_at: new Date(d.now()).toISOString(),
      ...(next === target ? stamps : {}),
    };
    const { data: rows, error } = await d.supabase
      .from('external_orders')
      .update(patch)
      .eq('id', id)
      .eq('status', cur.status)
      .select('status');
    if (error) {
      d.log('kh_action_status_write_failed', { id, error: error.message });
      return null;
    }
    if (rows && rows.length > 0) return next;
  }
  d.log('kh_action_status_write_lost_two_races', { id });
  return null;
}

async function readKhError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 500);
}

// ---- kh-order-action/index.ts :207-219 ---------------------------------------------------------------------------

/** The store gate. */
export async function storeEnabled(d: KhGlueDeps, restaurantId: string): Promise<{ kind: 'enabled' } | { kind: 'store_not_enabled' } | { kind: 'db_error'; detail: string }> {
  const { data: store, error: storeErr } = await d.supabase
    .from('kitchenhub_stores')
    .select('enabled')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (storeErr) {
    d.log('kh_action_store_lookup_failed', { restaurant_id: restaurantId, error: storeErr.message });
    return { kind: 'db_error', detail: storeErr.message };
  }
  if (!store?.enabled) {
    return { kind: 'store_not_enabled' };
  }
  return { kind: 'enabled' };
}

// ---- kh-order-action/index.ts :228-304 ---------------------------------------------------------------------------

export type KhActionResult =
  | { kind: 'applied'; status: string; db_synced: boolean }
  | { kind: 'conflict'; status: string }
  | { kind: 'not_main_account'; message: string }
  | { kind: 'kitchenhub_error'; http: number | null; detail: string };

/** The KitchenHub status change + the mirror write. `row` = external_orders {id, kh_order_id, status}. */
export async function khStatusChange(
  d: KhGlueDeps,
  row: { id: string; kh_order_id: number | string; status: string },
  act: Action,
  prep_time: number | null,
): Promise<KhActionResult> {
  const logCtx = { external_order_id: row.id, kh_order_id: row.kh_order_id, action: act };

  // -------- KitchenHub status change --------
  const khBody = act === 'accept' ? { status: 'accept', prep_time } : { status: act };
  let res: Response;
  try {
    res = await d.khFetch(d.supabase, `/v2/orders/${row.kh_order_id}/status/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(khBody),
    });
  } catch (err) {
    // deno-lint-ignore no-explicit-any
    const e = err as any;
    d.log('kh_action_request_failed', { ...logCtx, error: e?.message ?? String(err), http: e?.http ?? null });
    return { kind: 'kitchenhub_error', http: e?.http ?? null, detail: e?.message ?? 'request_failed' };
  }

  if (res.ok) {
    await res.body?.cancel();
    const nowIso = new Date(d.now()).toISOString();
    const target = TARGET[act];
    const stamps =
      act === 'accept' ? { accepted_at: nowIso, prep_time_minutes: prep_time }
      : act === 'complete' ? { completed_at: nowIso }
      : { cancelled_at: nowIso, cancelled_by: 'restaurant' };
    const stored = await writeStatus(d, row.id, target, stamps);
    // KitchenHub already applied the change; a failed mirror write is
    // reconciled by the webhook KitchenHub sends for this transition.
    d.log('kh_action_applied', { ...logCtx, http: res.status, stored });
    return { kind: 'applied', status: stored ?? target, db_synced: stored !== null };
  }

  if (res.status === 409) {
    await res.body?.cancel();
    let synced: string = row.status;
    try {
      const getRes = await d.khFetch(d.supabase, `/v2/orders/${row.kh_order_id}/`, { method: 'GET' });
      if (getRes.ok) {
        const kh = await getRes.json().catch(() => null);
        const incoming = normalizeStatus(kh?.order?.status);
        if (incoming) {
          const ts = kh?.timestamps ?? {};
          const stamps: Record<string, unknown> = {};
          for (const k of ['accepted_at', 'completed_at', 'cancelled_at']) {
            if (ts[k]) stamps[k] = ts[k];
          }
          if (kh?.order?.cancelled_by) stamps.cancelled_by = kh.order.cancelled_by;
          synced = (await writeStatus(d, row.id, incoming, stamps)) ?? resolveStatus(row.status, incoming);
        }
      } else {
        d.log('kh_action_conflict_refetch_failed', { ...logCtx, http: getRes.status });
        await getRes.body?.cancel();
      }
    } catch (err) {
      d.log('kh_action_conflict_refetch_exception', { ...logCtx, error: String(err) });
    }
    d.log('kh_action_conflict', { ...logCtx, synced });
    return { kind: 'conflict', status: synced };
  }

  if (res.status === 403) {
    await res.body?.cancel();
    d.log('kh_action_not_main_account', logCtx);
    return { kind: 'not_main_account', message: NOT_MAIN_ACCOUNT_MESSAGE };
  }

  const detail = await readKhError(res);
  d.log('kh_action_kitchenhub_error', { ...logCtx, http: res.status, detail });
  return { kind: 'kitchenhub_error', http: res.status, detail };
}
