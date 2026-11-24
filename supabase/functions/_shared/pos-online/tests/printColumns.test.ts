/**
 * The tablet's print write (useOrderPolling.js:220, :234-245, :252-261), restaurant-scoped.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  nextPrintAttempt, orderPrintColumns, printLogRow, STATUS_WRITE_PAUSE_MS, STATUS_WRITE_TRIES, writeTabletPrintColumns,
} from '../printColumns.ts';
import { fakeId, R1, R2 } from './fixtures.ts';

const ORDER = { id: fakeId(), order_number: -1001, print_attempts: 0 };

Deno.test('attempt = print_attempts + 1 (null / 0 → 1)', () => {
  assertEquals(nextPrintAttempt({ print_attempts: null }), 1);
  assertEquals(nextPrintAttempt({ print_attempts: 0 }), 1);
  assertEquals(nextPrintAttempt({ print_attempts: 2 }), 3);
});

Deno.test('print_logs row: the tablet fields, success', () => {
  assertEquals(printLogRow(ORDER, R1, 1, { success: true, message: 'ignored on success', status: 2, code: 'SUCCESS' }), {
    order_id: ORDER.id,
    order_number: -1001,
    restaurant_id: R1,
    attempt_number: 1,
    status: 'success',
    error_message: null,
    asb_status: 2,
    status_code: 'SUCCESS',
  });
});

Deno.test('print_logs row: failure keeps the message; non-number status → null; numeric code → string', () => {
  assertEquals(printLogRow(ORDER, R1, 2, { success: false, message: 'Printer offline', status: undefined, code: 7 }), {
    order_id: ORDER.id,
    order_number: -1001,
    restaurant_id: R1,
    attempt_number: 2,
    status: 'failed',
    error_message: 'Printer offline',
    asb_status: null,
    status_code: '7',
  });
  assertEquals(printLogRow(ORDER, R1, 1, { success: false }).error_message, null);
  assertEquals(printLogRow(ORDER, R1, 1, { success: false, code: null }).status_code, null);
});

Deno.test('orders columns: exactly print_status + print_attempts', () => {
  assertEquals(orderPrintColumns(1, { success: true }), { print_status: 'printed', print_attempts: 1 });
  assertEquals(orderPrintColumns(3, { success: false }), { print_status: 'failed', print_attempts: 3 });
});

// ---- write sequence ------------------------------------------------------------------------------------

type Op = [string, string, ...unknown[]];
function fakeDb(o: { order?: Record<string, unknown> | null; readError?: { message: string }; logError?: { message: string }; updateErrors?: number }) {
  const ops: Op[] = [];
  let updateFailuresLeft = o.updateErrors ?? 0;
  const db = {
    from(table: string) {
      let kind = '';
      // deno-lint-ignore no-explicit-any
      const q: any = {};
      q.select = (cols: string) => { kind = 'select'; ops.push([table, 'select', cols]); return q; };
      q.insert = (row: unknown) => { ops.push([table, 'insert', row]); return Promise.resolve({ error: o.logError ?? null }); };
      q.update = (vals: unknown) => { kind = 'update'; ops.push([table, 'update', vals]); return q; };
      q.eq = (c: string, v: unknown) => { ops.push([table, 'eq', c, v]); return q; };
      q.maybeSingle = () => Promise.resolve({ data: o.order === undefined ? ORDER : o.order, error: o.readError ?? null });
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        if (kind !== 'update') return Promise.reject(new Error('unexpected await')).then(res, rej);
        const fail = updateFailuresLeft > 0;
        if (fail) updateFailuresLeft--;
        return Promise.resolve({ error: fail ? { message: 'transient' } : null }).then(res, rej);
      };
      return q;
    },
  };
  return { db, ops };
}

function sleeper() {
  const slept: number[] = [];
  return { slept, sleep: (ms: number) => { slept.push(ms); return Promise.resolve(); } };
}

Deno.test('write: read scoped to the restaurant → log insert → orders update by id + restaurant', async () => {
  const { db, ops } = fakeDb({ order: { ...ORDER, print_attempts: 1 } });
  const s = sleeper();
  const r = await writeTabletPrintColumns(db, { restaurantId: R1, orderId: ORDER.id, result: { success: true, status: 6, code: 'SUCCESS' } }, s);
  assertEquals(r, { outcome: 'written', attempt: 2, log_error: null, status_error: null });
  assertEquals(ops, [
    ['orders', 'select', 'id, order_number, print_attempts'],
    ['orders', 'eq', 'id', ORDER.id],
    ['orders', 'eq', 'restaurant_id', R1],
    ['print_logs', 'insert', printLogRow(ORDER, R1, 2, { success: true, status: 6, code: 'SUCCESS' })],
    ['orders', 'update', { print_status: 'printed', print_attempts: 2 }],
    ['orders', 'eq', 'id', ORDER.id],
    ['orders', 'eq', 'restaurant_id', R1],
  ]);
  assertEquals(s.slept, []);
});

Deno.test('write: order not in this restaurant → nothing written', async () => {
  const { db, ops } = fakeDb({ order: null });
  const r = await writeTabletPrintColumns(db, { restaurantId: R2, orderId: ORDER.id, result: { success: true } }, sleeper());
  assertEquals(r, { outcome: 'order_not_found', attempt: null, log_error: null, status_error: null });
  assertEquals(ops.filter((o) => o[1] === 'insert' || o[1] === 'update'), []);
});

Deno.test('write: status update retried 3 times, 300 ms apart (tablet :253-261)', async () => {
  const ok = fakeDb({ updateErrors: 2 });
  const s1 = sleeper();
  const r1 = await writeTabletPrintColumns(ok.db, { restaurantId: R1, orderId: ORDER.id, result: { success: false, message: 'Cover open' } }, s1);
  assertEquals(r1.status_error, null);
  assertEquals(ok.ops.filter((o) => o[1] === 'update').length, 3);
  assertEquals(s1.slept, [STATUS_WRITE_PAUSE_MS, STATUS_WRITE_PAUSE_MS]);

  const bad = fakeDb({ updateErrors: 5 });
  const s2 = sleeper();
  const r2 = await writeTabletPrintColumns(bad.db, { restaurantId: R1, orderId: ORDER.id, result: { success: false } }, s2);
  assertEquals(r2.status_error, 'transient');
  assertEquals(bad.ops.filter((o) => o[1] === 'update').length, STATUS_WRITE_TRIES);
  assertEquals(s2.slept.length, STATUS_WRITE_TRIES - 1);
});

Deno.test('write: a failed log insert is reported and the order is still updated (as the tablet)', async () => {
  const { db, ops } = fakeDb({ logError: { message: 'log down' } });
  const r = await writeTabletPrintColumns(db, { restaurantId: R1, orderId: ORDER.id, result: { success: true } }, sleeper());
  assertEquals([r.outcome, r.log_error, r.status_error], ['written', 'log down', null]);
  assertEquals(ops.filter((o) => o[1] === 'update').length, 1);
});

Deno.test('write: a failed scoped read throws before any write', async () => {
  const { db, ops } = fakeDb({ readError: { message: 'db down' } });
  await assertRejects(() => writeTabletPrintColumns(db, { restaurantId: R1, orderId: ORDER.id, result: { success: true } }, sleeper()), Error, 'orders read failed');
  assertEquals(ops.filter((o) => o[1] === 'insert' || o[1] === 'update'), []);
});
