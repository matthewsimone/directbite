// Node-runnable assertions for khNormalize (no test runner required):
//   node supabase/functions/_shared/khNormalize.test.mjs
//
// Imports the .ts module directly via Node's built-in type stripping
// (default-on since Node 23.6 / 22.18). khNormalize.ts uses only erasable
// type syntax so no build step is needed.

import {
  normalizeStatus,
  resolveStatus,
  extractOrder,
  isSafeOrderId,
  parseOrderId,
  toRow,
} from './khNormalize.ts';

const cases = [];
function eq(name, got, expect) {
  cases.push({ name, got, expect });
}

// ---- normalizeStatus ----
eq('normalize: new', normalizeStatus('new'), 'new');
eq('normalize: accepted', normalizeStatus('accepted'), 'accepted');
eq('normalize: completed', normalizeStatus('completed'), 'completed');
eq('normalize: cancelled', normalizeStatus('cancelled'), 'cancelled');
eq('normalize: canceled (one L)', normalizeStatus('canceled'), 'cancelled');
eq('normalize: unknown string', normalizeStatus('ready'), null);
eq('normalize: undefined', normalizeStatus(undefined), null);
eq('normalize: null', normalizeStatus(null), null);
eq('normalize: case-sensitive', normalizeStatus('NEW'), null);

// ---- resolveStatus ----
eq('resolve: no existing, new', resolveStatus(null, 'new'), 'new');
eq('resolve: no existing, accepted', resolveStatus(undefined, 'accepted'), 'accepted');
eq('resolve: new -> accepted', resolveStatus('new', 'accepted'), 'accepted');
eq('resolve: accepted -> completed', resolveStatus('accepted', 'completed'), 'completed');
eq('resolve: cancelled beats completed', resolveStatus('completed', 'cancelled'), 'cancelled');
eq('resolve: cancelled beats new', resolveStatus('new', 'cancelled'), 'cancelled');
eq('resolve: completed not downgraded by late accepted', resolveStatus('completed', 'accepted'), 'completed');
eq('resolve: accepted not downgraded by late new', resolveStatus('accepted', 'new'), 'accepted');
eq('resolve: existing cancelled stays vs completed', resolveStatus('cancelled', 'completed'), 'cancelled');
eq('resolve: existing cancelled stays vs new', resolveStatus('cancelled', 'new'), 'cancelled');
eq('resolve: null incoming keeps existing', resolveStatus('accepted', null), 'accepted');
eq('resolve: null incoming keeps cancelled', resolveStatus('cancelled', null), 'cancelled');
eq('resolve: null incoming, no existing -> new', resolveStatus(null, null), 'new');
eq('resolve: same status idempotent', resolveStatus('accepted', 'accepted'), 'accepted');

// ---- extractOrder ----
const v2 = {
  version: 2,
  event_data: { event_type: 'Order', status: 'new' },
  order: {
    order: { id: 123, status: 'new', asap: true },
    provider: { id: 1, name: 'doordash' },
    store: { id: 'st_1' },
  },
};
const flat = {
  order: { id: 456, status: 'accepted' },
  provider: { id: 2, name: 'grubhub' },
  store: { id: 'st_2' },
};
eq('extract: v2 returns envelope', extractOrder(v2), v2.order);
eq('extract: v2 order id', extractOrder(v2)?.order?.id, 123);
eq('extract: flat returns payload', extractOrder(flat), flat);
eq('extract: flat order id', extractOrder(flat)?.order?.id, 456);
eq('extract: null payload', extractOrder(null), null);
eq('extract: empty object', extractOrder({}), null);
eq('extract: order without id', extractOrder({ order: { status: 'new' } }), null);

// ---- isSafeOrderId ----
eq('safeId: positive int', isSafeOrderId(123), true);
eq('safeId: zero', isSafeOrderId(0), false);
eq('safeId: negative', isSafeOrderId(-5), false);
eq('safeId: float', isSafeOrderId(1.5), false);
eq('safeId: numeric string', isSafeOrderId('123'), false);
eq('safeId: beyond 2^53', isSafeOrderId(2 ** 53), false);
eq('safeId: undefined', isSafeOrderId(undefined), false);

// ---- parseOrderId ----
eq('parseId: number 123', parseOrderId(123), 123);
eq('parseId: string "123"', parseOrderId('123'), 123);
eq('parseId: string "12a"', parseOrderId('12a'), null);
eq('parseId: empty string', parseOrderId(''), null);
eq('parseId: zero', parseOrderId(0), null);
eq('parseId: string beyond safe', parseOrderId('9007199254740993'), null);
eq('parseId: null', parseOrderId(null), null);

// ---- toRow ----
eq('toRow: empty envelope does not throw', typeof toRow({}), 'object');
eq('toRow: undefined does not throw', toRow(undefined).kh_order_id, null);
eq('toRow: items default []', JSON.stringify(toRow({}).items), '[]');
eq('toRow: total missing -> null', toRow({ charges: {} }).total, null);
eq('toRow: total null -> null (not 0)', toRow({ charges: { total: null } }).total, null);
eq('toRow: total string', toRow({ charges: { total: '12.50' } }).total, 12.5);
eq('toRow: total garbage -> null', toRow({ charges: { total: 'abc' } }).total, null);
eq('toRow: scheduled_for when asap=false',
  toRow({ order: { asap: false }, timestamps: { scheduled_for: 'T1' } }).scheduled_for, 'T1');
eq('toRow: scheduled_for null when asap=true',
  toRow({ order: { asap: true }, timestamps: { scheduled_for: 'T1' } }).scheduled_for, null);
eq('toRow: scheduled_for null when asap missing',
  toRow({ timestamps: { scheduled_for: 'T1' } }).scheduled_for, null);
eq('toRow: v2 mapping kh_order_id', toRow(extractOrder(v2)).kh_order_id, 123);
eq('toRow: v2 mapping provider_name', toRow(extractOrder(v2)).provider_name, 'doordash');
eq('toRow: customer phone', toRow({ customer: { name: 'A', phone_number: '555', phone_code: '+1' } }).customer_phone, '555');
eq('toRow: excludes status', 'status' in toRow(extractOrder(v2)), false);
eq('toRow: excludes restaurant_id', 'restaurant_id' in toRow(extractOrder(v2)), false);
eq('toRow: excludes print_status', 'print_status' in toRow(extractOrder(v2)), false);
eq('toRow: excludes acknowledged_at', 'acknowledged_at' in toRow(extractOrder(v2)), false);
eq('toRow: paid true', toRow({ order: { paid: true } }).paid, true);
eq('toRow: paid false kept (not null)', toRow({ order: { paid: false } }).paid, false);
eq('toRow: paid missing -> null', toRow({ order: {} }).paid, null);
eq('toRow: paid null -> null', toRow({ order: { paid: null } }).paid, null);
eq('toRow: paid "false" string -> null', toRow({ order: { paid: 'false' } }).paid, null);
eq('toRow: paid from v2 envelope',
  toRow(extractOrder({ order: { order: { id: 9, paid: false }, store: { id: 's' } } })).paid, false);

let failures = 0;
for (const c of cases) {
  const pass = c.got === c.expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(c.got)})`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
