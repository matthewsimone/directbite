/**
 * Fakes for Cancel & Refund (tests only): Stripe's refunds.create (idempotency keys honoured like Stripe: the same key
 * returns the same refund), _shared/uberCancel.ts cancelUberDelivery (writes uber_status canceled like the real one,
 * uberCancel.ts :182-198) and _shared/refundUberAppFee.ts refundUberAppFee (recorded only). Every call is recorded in
 * order (`calls`) so tests can check Uber-before-Stripe.
 */
// deno-lint-ignore-file no-explicit-any
import type { FakeSupabase } from './fakeSupabase.ts';

export function moneyFakes(db: FakeSupabase) {
  const calls: string[] = [];
  const refunds = new Map<string, { id: string; amount: number }>();
  const stripeCalls: { params: any; opts: any }[] = [];
  /** per order: what Stripe does next ('ok' default). */
  const stripeOutcome = new Map<string, 'ok' | 'fail'>();
  /** per order: what Uber does ('ok' default; or an uberCancel error code). */
  const uberOutcome = new Map<string, 'ok' | string>();
  const appFee: { order_id: string; fee: number | undefined }[] = [];
  let seq = 0;
  const stripe = {
    refunds: {
      create(params: any, opts: any) {
        stripeCalls.push({ params, opts });
        calls.push(`stripe:${params.payment_intent}`);
        const key = opts?.idempotencyKey;
        if (key && refunds.has(key)) return Promise.resolve(refunds.get(key)!);
        const order = db.rows('orders').find((o) => o.stripe_payment_intent_id === params.payment_intent);
        if (order && stripeOutcome.get(order.id) === 'fail') return Promise.reject(new Error('Your card was declined for this refund.'));
        const r = { id: `re_test_${++seq}`, amount: params.amount ?? Math.round(Number(order?.total_amount ?? 0) * 100) };
        if (key) refunds.set(key, r);
        return Promise.resolve(r);
      },
    },
  };
  const cancelUberDelivery = (_supabase: any, order: any, _restaurant: any) => {
    calls.push(`uber:${order.id}`);
    if (order.uber_status === 'canceled' || !order.uber_delivery_id) return Promise.resolve({ success: true as const, alreadyCanceled: true });
    const out = uberOutcome.get(order.id) ?? 'ok';
    if (out !== 'ok') return Promise.resolve({ success: false as const, error: out, detail: 'fake' });
    const row = db.rows('orders').find((o) => o.id === order.id)!;
    Object.assign(row, { uber_status: 'canceled', uber_status_updated_at: new Date().toISOString() });
    return Promise.resolve({ success: true as const, uberFee: 0 });
  };
  const refundUberAppFee = (_stripe: any, order: any, _restaurant: any, fee?: number) => {
    calls.push(`appfee:${order.id}`);
    appFee.push({ order_id: order.id, fee });
    return Promise.resolve({ ok: true });
  };
  return { stripe, cancelUberDelivery, refundUberAppFee, calls, refunds, stripeCalls, stripeOutcome, uberOutcome, appFee };
}
