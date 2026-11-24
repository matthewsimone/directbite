/**
 * Test Pizza fixtures for pos-online. Order numbers are NEGATIVE (never a real order_number, which starts at
 * 1000001, 001:105). Restaurant id = the pos-device harness's R1 ("Test Pizza").
 */
import { R1, R2 } from '../../pos-device/tests/harness.ts';
import type { FeedRow } from '../feedQuery.ts';

export { R1, R2 };
export const TZ = 'America/New_York';

export const DEV_A = 'd0000000-0000-4000-8000-00000000000a';
export const DEV_B = 'd0000000-0000-4000-8000-00000000000b';
export const DEV_R2 = 'd0000000-0000-4000-8000-0000000000f2';

let seq = 0;
/** Deterministic fake uuid (prefix e…, never a real row). */
export function fakeId(prefix = 'e'): string {
  seq += 1;
  return `${prefix.repeat(8)}-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

// deno-lint-ignore no-explicit-any
export function order(o: Record<string, any> = {}): FeedRow {
  const id = o.id ?? fakeId();
  return {
    id,
    order_number: -(++seq),
    restaurant_id: R1,
    status: 'new',
    order_type: 'pickup',
    customer_name: 'Test Customer',
    subtotal: 12.5,
    total_amount: 15.24,
    print_status: 'pending',
    print_attempts: 0,
    scheduled_for: null,
    refunded_at: null,
    items_written_at: '2026-11-24T14:00:01.000Z',
    created_at: '2026-11-24T14:00:00.000Z',
    order_items: [],
    ...o,
  };
}
