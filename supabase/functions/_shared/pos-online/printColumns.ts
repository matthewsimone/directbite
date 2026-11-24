/**
 * The web tablet's print write, done by the POS server for an Ordr online order (CP17a v2 §2 row 11).
 * Exactly useOrderPolling.js autoPrint:
 *   attempt = (orders.print_attempts || 0) + 1                                   (:220)
 *   print_logs insert { order_id, order_number, restaurant_id, attempt_number,
 *                       status success|failed, error_message, asb_status, status_code }   (:234-245)
 *   orders update { print_status printed|failed, print_attempts: attempt }, up to 3 tries, 300 ms apart  (:252-261)
 * Same columns, same values, same order (log first, then the order). Nothing else on orders is written
 * (not last_print_attempt — the tablet never writes it). Differences, both scoping only:
 *   - the order is read first, scoped to the device's restaurant (order not there → no write at all);
 *   - the update is filtered by id AND restaurant_id.
 * print_logs.asb_status / status_code exist live (the tablet writes them) but not in any repo migration.
 */

export interface TabletPrintResult {
  success: boolean;
  /** The printer's message (error_message when !success). */
  message?: string | null;
  /** Raw ePOS ASB status bitmask, when there is one. */
  status?: number | null;
  /** Printer result code, when there is one. */
  code?: string | number | null;
}

export interface PrintOrderRef { id: string; order_number: number | string | null; print_attempts: number | null }

export function nextPrintAttempt(order: Pick<PrintOrderRef, 'print_attempts'>): number {
  return (order.print_attempts || 0) + 1;
}

/** useOrderPolling.js:234-245, field for field. */
export function printLogRow(order: Pick<PrintOrderRef, 'id' | 'order_number'>, restaurantId: string, attempt: number, result: TabletPrintResult) {
  return {
    order_id: order.id,
    order_number: order.order_number,
    restaurant_id: restaurantId,
    attempt_number: attempt,
    status: result.success ? 'success' : 'failed',
    error_message: result.success ? null : (result.message ?? null),
    asb_status: typeof result.status === 'number' ? result.status : null,
    status_code: result.code != null ? String(result.code) : null,
  };
}

/** useOrderPolling.js:254-257. */
export function orderPrintColumns(attempt: number, result: TabletPrintResult) {
  return { print_status: result.success ? 'printed' : 'failed', print_attempts: attempt } as const;
}

// deno-lint-ignore no-explicit-any
export type PrintClient = { from(table: string): any };

export interface PrintWriteOutcome {
  outcome: 'written' | 'order_not_found';
  attempt: number | null;
  /** print_logs insert error (the tablet logs it and carries on). */
  log_error: string | null;
  /** orders update error after the last try (null = written). */
  status_error: string | null;
}

export const STATUS_WRITE_TRIES = 3;
export const STATUS_WRITE_PAUSE_MS = 300;

/**
 * Record a finished print exactly as the tablet does. The print already happened; this never throws for a
 * DB error (returned in log_error / status_error), like the tablet. A failed restaurant-scoped read throws.
 */
export async function writeTabletPrintColumns(
  db: PrintClient,
  input: { restaurantId: string; orderId: string; result: TabletPrintResult },
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<PrintWriteOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { data: order, error: readErr } = await db
    .from('orders')
    .select('id, order_number, print_attempts')
    .eq('id', input.orderId)
    .eq('restaurant_id', input.restaurantId)
    .maybeSingle();
  if (readErr) throw new Error(`orders read failed: ${readErr.message}`);
  if (!order) return { outcome: 'order_not_found', attempt: null, log_error: null, status_error: null };

  const attempt = nextPrintAttempt(order);
  const { error: logErr } = await db.from('print_logs').insert(printLogRow(order, input.restaurantId, attempt, input.result));

  let statusErr: string | null = null;
  for (let w = 0; w < STATUS_WRITE_TRIES; w++) {
    const { error } = await db
      .from('orders')
      .update(orderPrintColumns(attempt, input.result))
      .eq('id', input.orderId)
      .eq('restaurant_id', input.restaurantId);
    if (!error) { statusErr = null; break; }
    statusErr = error.message ?? String(error);
    if (w < STATUS_WRITE_TRIES - 1) await sleep(STATUS_WRITE_PAUSE_MS);
  }
  return { outcome: 'written', attempt, log_error: logErr ? (logErr.message ?? String(logErr)) : null, status_error: statusErr };
}
