/**
 * The tablet's print write per STATION result (useOrderPolling.js:220, :234-245, :252-261; externalPrintStatus.js;
 * reference fakeOnline.ts writeTabletPrintColumns :227-240), restaurant-scoped.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  externalPrintColumns, nextPrintAttempt, orderPrintColumns, printLogRow, STATUS_WRITE_PAUSE_MS, STATUS_WRITE_TRIES, writeTabletPrintColumns,
} from '../printColumns.ts';
import { tabletWrite, UNCONFIRMED_ERROR, type TabletPrintWrite } from '../printRules.ts';
import { fakeId, R1, R2 } from './fixtures.ts';

const ORDER = { id: fakeId(), order_number: -1001, print_attempts: 0 };
const NOW_ISO = '2026-11-24T15:00:00.000Z';
const W = (o: Partial<TabletPrintWrite>): TabletPrintWrite => ({ ok: true, error: null, logOnly: false, printStatus: 'printed', ...o });

Deno.test('attempt = print_attempts + 1 (null / 0 → 1)', () => {
  assertEquals(nextPrintAttempt({ print_attempts: null }), 1);
  assertEquals(nextPrintAttempt({ print_attempts: 0 }), 1);
  assertEquals(nextPrintAttempt({ print_attempts: 2 }), 3);
});

Deno.test('print_logs row: the tablet fields; success / failed; no ASB status from the POS', () => {
  assertEquals(printLogRow(ORDER, R1, 1, { ok: true, error: null }), {
    order_id: ORDER.id, order_number: -1001, restaurant_id: R1, attempt_number: 1, status: 'success', error_message: null, asb_status: null, status_code: null,
  });
  assertEquals(printLogRow(ORDER, R1, 2, { ok: false, error: 'Printer offline' }).error_message, 'Printer offline');
  assertEquals(printLogRow(ORDER, R1, 2, { ok: false, error: 'Printer offline' }).status, 'failed');
});

Deno.test('orders columns: print_attempts always; print_status only when the order result decides it', () => {
  assertEquals(orderPrintColumns(1, { printStatus: 'printed' }), { print_status: 'printed', print_attempts: 1 });
  assertEquals(orderPrintColumns(3, { printStatus: 'failed' }), { print_status: 'failed', print_attempts: 3 });
  assertEquals(orderPrintColumns(2, { printStatus: null }), { print_attempts: 2 }); // other stations still printing
});

Deno.test('external_orders columns (externalPrintStatus.js): printed / failed / still printing', () => {
  assertEquals(externalPrintColumns(1, { ok: true, error: null, printStatus: 'printed' }, NOW_ISO), { print_attempts: 1, print_status: 'printed', printed_at: NOW_ISO, last_print_error: null });
  assertEquals(externalPrintColumns(2, { ok: false, error: 'Cover open', printStatus: 'failed' }, NOW_ISO), { print_attempts: 2, print_status: 'failed', last_print_error: 'Cover open' });
  // a station printed while another is still printing: attempts only (deviation: the reference writes 'unknown error')
  assertEquals(externalPrintColumns(2, { ok: true, error: null, printStatus: null }, NOW_ISO), { print_attempts: 2 });
});

Deno.test('tabletWrite (reference :91-97): unconfirmed → failed "printer did not confirm"; reprint log-only rule', () => {
  assertEquals(tabletWrite({ variant: 'auto', result: 'printed_unconfirmed', error: null }, 'printed_unconfirmed', 'received', 'new'),
    { ok: false, error: UNCONFIRMED_ERROR, logOnly: false, printStatus: 'failed' });
  assertEquals(tabletWrite({ variant: 'auto', result: 'failed', error: null }, 'failed', 'received', 'new').error, 'did not print');
  assertEquals(tabletWrite({ variant: 'reprint', result: 'printed', error: null }, 'printed', 'in_progress', 'new').logOnly, true);
  assertEquals(tabletWrite({ variant: 'reprint', result: 'printed', error: null }, 'printed', 'in_progress', 'in_progress').logOnly, false);
  assertEquals(tabletWrite({ variant: 'reprint', result: 'printed', error: null }, 'printed', 'received', 'new').logOnly, false);
  assertEquals(tabletWrite({ variant: 'auto', result: 'printed', error: null }, null, 'received', 'new').printStatus, null);
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
const input = (o: { restaurantId?: string; channel?: 'ordr' | 'kitchenhub'; write?: TabletPrintWrite } = {}) =>
  ({ restaurantId: o.restaurantId ?? R1, channel: o.channel ?? 'ordr', orderId: ORDER.id, write: o.write ?? W({}), nowIso: NOW_ISO } as const);

Deno.test('orders: read scoped to the restaurant → print_logs insert → orders update by id + restaurant', async () => {
  const { db, ops } = fakeDb({ order: { ...ORDER, print_attempts: 1 } });
  const s = sleeper();
  const r = await writeTabletPrintColumns(db, input({}), s);
  assertEquals(r, { outcome: 'written', attempt: 2, log_error: null, status_error: null });
  assertEquals(ops, [
    ['orders', 'select', 'id, order_number, print_attempts'],
    ['orders', 'eq', 'id', ORDER.id],
    ['orders', 'eq', 'restaurant_id', R1],
    ['print_logs', 'insert', printLogRow(ORDER, R1, 2, { ok: true, error: null })],
    ['orders', 'update', { print_status: 'printed', print_attempts: 2 }],
    ['orders', 'eq', 'id', ORDER.id],
    ['orders', 'eq', 'restaurant_id', R1],
  ]);
  assertEquals(s.slept, []);
});

Deno.test('orders: a station while others still print → log row + print_attempts only', async () => {
  const { db, ops } = fakeDb({});
  await writeTabletPrintColumns(db, input({ write: W({ printStatus: null }) }), sleeper());
  assertEquals(ops.filter((o) => o[1] === 'update'), [['orders', 'update', { print_attempts: 1 }]]);
  assertEquals(ops.filter((o) => o[1] === 'insert').length, 1);
});

Deno.test('orders: reprint of an untaken order (logOnly) → the print_logs row only', async () => {
  const { db, ops } = fakeDb({});
  const r = await writeTabletPrintColumns(db, input({ write: W({ logOnly: true }) }), sleeper());
  assertEquals(r.outcome, 'log_only');
  assertEquals(ops.filter((o) => o[1] === 'insert').length, 1);
  assertEquals(ops.filter((o) => o[1] === 'update'), []);
});

Deno.test('external_orders: no print_logs row; the four columns; scoped the same way', async () => {
  const { db, ops } = fakeDb({ order: { id: ORDER.id, print_attempts: 0 } });
  await writeTabletPrintColumns(db, input({ channel: 'kitchenhub', write: W({ ok: false, error: 'Paper out', printStatus: 'failed' }) }), sleeper());
  assertEquals(ops, [
    ['external_orders', 'select', 'id, print_attempts'],
    ['external_orders', 'eq', 'id', ORDER.id],
    ['external_orders', 'eq', 'restaurant_id', R1],
    ['external_orders', 'update', { print_attempts: 1, print_status: 'failed', last_print_error: 'Paper out' }],
    ['external_orders', 'eq', 'id', ORDER.id],
    ['external_orders', 'eq', 'restaurant_id', R1],
  ]);
});

Deno.test('order not in this restaurant → nothing written', async () => {
  const { db, ops } = fakeDb({ order: null });
  const r = await writeTabletPrintColumns(db, input({ restaurantId: R2 }), sleeper());
  assertEquals(r, { outcome: 'order_not_found', attempt: null, log_error: null, status_error: null });
  assertEquals(ops.filter((o) => o[1] === 'insert' || o[1] === 'update'), []);
});

Deno.test('status update retried 3 times, 300 ms apart (tablet :253-261)', async () => {
  const ok = fakeDb({ updateErrors: 2 });
  const s1 = sleeper();
  const r1 = await writeTabletPrintColumns(ok.db, input({ write: W({ ok: false, error: 'Cover open', printStatus: 'failed' }) }), s1);
  assertEquals(r1.status_error, null);
  assertEquals(ok.ops.filter((o) => o[1] === 'update').length, 3);
  assertEquals(s1.slept, [STATUS_WRITE_PAUSE_MS, STATUS_WRITE_PAUSE_MS]);

  const bad = fakeDb({ updateErrors: 5 });
  const s2 = sleeper();
  const r2 = await writeTabletPrintColumns(bad.db, input({}), s2);
  assertEquals(r2.status_error, 'transient');
  assertEquals(bad.ops.filter((o) => o[1] === 'update').length, STATUS_WRITE_TRIES);
  assertEquals(s2.slept.length, STATUS_WRITE_TRIES - 1);
});

Deno.test('a failed log insert is reported and the order is still updated (as the tablet)', async () => {
  const { db, ops } = fakeDb({ logError: { message: 'log down' } });
  const r = await writeTabletPrintColumns(db, input({}), sleeper());
  assertEquals([r.outcome, r.log_error, r.status_error], ['written', 'log down', null]);
  assertEquals(ops.filter((o) => o[1] === 'update').length, 1);
});

Deno.test('a failed scoped read throws before any write', async () => {
  const { db, ops } = fakeDb({ readError: { message: 'db down' } });
  await assertRejects(() => writeTabletPrintColumns(db, input({}), sleeper()), Error, 'orders read failed');
  assertEquals(ops.filter((o) => o[1] === 'insert' || o[1] === 'update'), []);
});
