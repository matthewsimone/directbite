/**
 * The web tablet's print write, done by the POS server after each STATION result (SYNC-CONTRACT §3c
 * pos-v1-online-print, "Every result ALSO writes the tablet's columns — truthfully"; reference
 * fakeOnline.ts writeTabletPrintColumns :227-240).
 *
 * orders — exactly useOrderPolling.js autoPrint's columns:
 *   attempt = (orders.print_attempts || 0) + 1                                   (:220)
 *   print_logs insert { order_id, order_number, restaurant_id, attempt_number,
 *                       status success|failed, error_message, asb_status, status_code }   (:234-245)
 *   orders update { print_status, print_attempts: attempt }, up to 3 tries, 300 ms apart  (:252-261)
 *   Per station result: one print_logs row, print_attempts + 1, and print_status only when the ORDER's
 *   result over its stations says so (printed once every station printed; failed once any failed / never
 *   confirmed; UNTOUCHED while the others are still printing → the update writes print_attempts only).
 *   reprint + print_trigger in_progress + still new → the print_logs row only (OrdersTab handleReprint).
 *   asb_status / status_code: null — the POS reports no ePOS ASB bitmask (they exist live, not in a repo migration).
 * external_orders — externalPrintStatus.js writeExternalPrintResult: print_status, print_attempts,
 *   printed_at (on success), last_print_error (null on success); same 3 tries / 300 ms. No print_logs row
 *   (the tablet writes none for a DSP order).
 *
 * Same columns, same values, same order (log first, then the order). Nothing else is written. Differences, all
 * scoping: the row is read first scoped to the device's restaurant (not there → no write at all); the update is
 * filtered by id AND restaurant_id.
 */
import type { TabletPrintWrite } from './printRules.ts';

export interface PrintOrderRef { id: string; order_number: number | string | null; print_attempts: number | null }

export function nextPrintAttempt(order: Pick<PrintOrderRef, 'print_attempts'>): number {
  return (order.print_attempts || 0) + 1;
}

/** useOrderPolling.js:234-245, field for field. */
export function printLogRow(order: Pick<PrintOrderRef, 'id' | 'order_number'>, restaurantId: string, attempt: number, w: Pick<TabletPrintWrite, 'ok' | 'error'>) {
  return {
    order_id: order.id,
    order_number: order.order_number,
    restaurant_id: restaurantId,
    attempt_number: attempt,
    status: w.ok ? 'success' : 'failed',
    error_message: w.ok ? null : w.error,
    asb_status: null,
    status_code: null,
  };
}

/** orders: print_attempts always; print_status only when the order's result decides it. */
export function orderPrintColumns(attempt: number, w: Pick<TabletPrintWrite, 'printStatus'>): { print_attempts: number; print_status?: 'printed' | 'failed' } {
  return w.printStatus ? { print_status: w.printStatus, print_attempts: attempt } : { print_attempts: attempt };
}

/**
 * external_orders (externalPrintStatus.js). A station that printed while others are still printing writes
 * print_attempts only (no printed_at; last_print_error left) — the reference writes 'unknown error' there
 * (fakeOnline.ts:239), a deviation listed in the summary.
 */
export function externalPrintColumns(attempt: number, w: Pick<TabletPrintWrite, 'ok' | 'error' | 'printStatus'>, nowIso: string): Record<string, unknown> {
  const cols: Record<string, unknown> = { print_attempts: attempt };
  if (w.printStatus) cols.print_status = w.printStatus;
  if (!w.ok) cols.last_print_error = w.error ?? 'unknown error';
  else if (w.printStatus === 'printed') {
    cols.printed_at = nowIso;
    cols.last_print_error = null;
  }
  return cols;
}

// deno-lint-ignore no-explicit-any
export type PrintClient = { from(table: string): any };

export interface PrintWriteOutcome {
  outcome: 'written' | 'log_only' | 'order_not_found';
  attempt: number | null;
  /** print_logs insert error (the tablet logs it and carries on). */
  log_error: string | null;
  /** orders / external_orders update error after the last try (null = written). */
  status_error: string | null;
}

export const STATUS_WRITE_TRIES = 3;
export const STATUS_WRITE_PAUSE_MS = 300;

/**
 * Record one station's finished print exactly as the tablet does. The print already happened; this never throws
 * for a write error (returned in log_error / status_error), like the tablet. A failed restaurant-scoped read throws.
 */
export async function writeTabletPrintColumns(
  db: PrintClient,
  input: { restaurantId: string; channel: 'ordr' | 'kitchenhub'; orderId: string; write: TabletPrintWrite; nowIso: string },
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<PrintWriteOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const table = input.channel === 'ordr' ? 'orders' : 'external_orders';
  const { data: order, error: readErr } = await db
    .from(table)
    .select(input.channel === 'ordr' ? 'id, order_number, print_attempts' : 'id, print_attempts')
    .eq('id', input.orderId)
    .eq('restaurant_id', input.restaurantId)
    .maybeSingle();
  if (readErr) throw new Error(`${table} read failed: ${readErr.message}`);
  if (!order) return { outcome: 'order_not_found', attempt: null, log_error: null, status_error: null };

  const attempt = nextPrintAttempt(order);
  let logErr: string | null = null;
  if (input.channel === 'ordr') {
    const { error } = await db.from('print_logs').insert(printLogRow(order, input.restaurantId, attempt, input.write));
    logErr = error ? (error.message ?? String(error)) : null;
  }
  if (input.write.logOnly) return { outcome: 'log_only', attempt, log_error: logErr, status_error: null };

  const cols = input.channel === 'ordr' ? orderPrintColumns(attempt, input.write) : externalPrintColumns(attempt, input.write, input.nowIso);
  let statusErr: string | null = null;
  for (let w = 0; w < STATUS_WRITE_TRIES; w++) {
    const { error } = await db.from(table).update(cols).eq('id', input.orderId).eq('restaurant_id', input.restaurantId);
    if (!error) {
      statusErr = null;
      break;
    }
    statusErr = error.message ?? String(error);
    if (w < STATUS_WRITE_TRIES - 1) await sleep(STATUS_WRITE_PAUSE_MS);
  }
  return { outcome: 'written', attempt, log_error: logErr, status_error: statusErr };
}
