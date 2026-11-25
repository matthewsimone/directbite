/**
 * Identity rules (SYNC-CONTRACT §1a, DEVICE-AUTH §4.3) — the helpers later device functions use.
 * Ported from ordr-pos deviceAuth.test.ts "identity rules (§4.3)" (fakeServer orderIdentity /
 * entityIdentity), incl. the APPROVED ticket-prefix rule.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import type { Principal } from '../auth.ts';
import { entityIdentity, orderIdentity, restaurantIdentity } from '../identity.ts';
import { err, R1, R2 } from './harness.ts';

const A: Principal = { device_id: crypto.randomUUID(), restaurant_id: R1, prefix: 'A' };
const B: Principal = { device_id: crypto.randomUUID(), restaurant_id: R1, prefix: 'B' };
const order = (pr: Principal, o: Record<string, unknown> = {}) => ({ restaurant_id: pr.restaurant_id, device_id: pr.device_id, ticket: { prefix: pr.prefix }, channel: 'counter', ...o });

Deno.test('submit-order: restaurant ≠ principal → 400 restaurant_mismatch; device ≠ → 403 device_mismatch; ticket prefix ≠ → 400 prefix_mismatch; channel not in person → 400 invalid_payload', () => {
  assertEquals(orderIdentity(order(A), A, null), null);
  for (const ch of ['counter', 'phone', 'dine_in']) assertEquals(orderIdentity(order(A, { channel: ch }), A, null), null);
  assertEquals(err(orderIdentity(order(A, { restaurant_id: R2 }), A, null)!), { status: 400, code: 'restaurant_mismatch', message: "restaurant_id is not this device's restaurant" });
  assertEquals(err(orderIdentity(order(A, { device_id: crypto.randomUUID() }), A, null)!), { status: 403, code: 'device_mismatch', message: 'device_id is not this device' });
  assertEquals(err(orderIdentity(order(A, { ticket: { prefix: 'B' } }), A, null)!).code, 'prefix_mismatch');
  assertEquals(err(orderIdentity(order(A, { ticket: null }), A, null)!).code, 'prefix_mismatch');
  for (const ch of ['online', null, 'Counter']) assertEquals(err(orderIdentity(order(A, { channel: ch }), A, null)!), { status: 400, code: 'invalid_payload', message: `channel ${String(ch)}: a register submits counter | phone | dine_in only` });
});

Deno.test('an order id of another restaurant → 400 restaurant_mismatch "the order belongs to another restaurant"', () => {
  const other: Principal = { device_id: crypto.randomUUID(), restaurant_id: R2, prefix: 'A' };
  assertEquals(err(orderIdentity(order(other), other, { restaurant_id: R1, ticket_prefix: 'A' })!), { status: 400, code: 'restaurant_mismatch', message: 'the order belongs to another restaurant' });
});

Deno.test('APPROVED prefix rule: a NEW order carries the principal prefix; an EXISTING order keeps its stored ticket prefix (another register may write it, never relabel it)', () => {
  const existingA = { restaurant_id: R1, ticket_prefix: 'A' };
  // register B writes A's order under A's ticket → ok
  assertEquals(orderIdentity(order(B, { ticket: { prefix: 'A' } }), B, existingA), null);
  // register B tries to relabel A's order to B → prefix_mismatch
  assertEquals(err(orderIdentity(order(B, { ticket: { prefix: 'B' } }), B, existingA)!), { status: 400, code: 'prefix_mismatch', message: "the order's ticket prefix is A" });
  // a new order from B must carry B
  assertEquals(err(orderIdentity(order(B, { ticket: { prefix: 'A' } }), B, null)!), { status: 400, code: 'prefix_mismatch', message: "ticket prefix A is not this device's (B)" });
});

Deno.test('shift / refund / day close / staff events: restaurant ≠ → 400; device ≠ → 403; an existing id of another restaurant → 400; snapshots: body restaurant ≠ → 400', () => {
  const e = { restaurant_id: R1, device_id: A.device_id };
  assertEquals(entityIdentity(e, A, null), null);
  assertEquals(entityIdentity(e, A, R1), null);
  assertEquals(err(entityIdentity({ ...e, restaurant_id: R2 }, A, null)!).code, 'restaurant_mismatch');
  assertEquals(err(entityIdentity({ ...e, device_id: B.device_id }, A, null)!), { status: 403, code: 'device_mismatch', message: 'device_id is not this device' });
  assertEquals(err(entityIdentity(e, A, R2)!), { status: 400, code: 'restaurant_mismatch', message: 'it belongs to another restaurant' });
  assertEquals(restaurantIdentity({ restaurant_id: R1 }, A), null);
  assertEquals(err(restaurantIdentity({ restaurant_id: R2 }, A)!).code, 'restaurant_mismatch');
});
