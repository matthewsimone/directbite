/**
 * Fakes for Cancel & Refund (tests only): Stripe's refunds.create (idempotency keys honoured like Stripe: the same key
 * returns the same refund), _shared/uberCancel.ts cancelUberDelivery (writes uber_status canceled like the real one,
 * uberCancel.ts :265-277) and _shared/refundUberAppFee.ts refundUberAppFee (recorded only), and (CP20)
 * _shared/uberCreateDelivery.ts createUberDelivery: its outcomes + its ONE orders UPDATE (uberCreateDelivery.ts
 * :642-668: uber_delivery_id, uber_tracking_url, uber_status, uber_status_updated_at, uber_dispatched_at,
 * uber_pickup_ready_dt, status = postWriteStatus, accepted_at if null, uber_quote_id / uber_quoted_fee when refreshed).
 * Every call is recorded in order (`calls`) so tests can check Uber-before-Stripe.
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
    if (out !== 'ok') return Promise.resolve({ success: false as const, error: out, detail: 'fake', ...(out === 'rate_limited' ? { retry_after: 7 } : {}) });
    const row = db.rows('orders').find((o) => o.id === order.id)!;
    Object.assign(row, { uber_status: 'canceled', uber_status_updated_at: new Date().toISOString() });
    return Promise.resolve({ success: true as const, uberFee: 0 });
  };
  const refundUberAppFee = (_stripe: any, order: any, _restaurant: any, fee?: number) => {
    calls.push(`appfee:${order.id}`);
    appFee.push({ order_id: order.id, fee });
    return Promise.resolve({ ok: true });
  };
  /** per order: what createUberDelivery answers ('ok' default). */
  const dispatchOutcome = new Map<string, 'ok' | 'no_uber_available' | 'bad_address' | 'rate_limited' | 'uber_unavailable' | 'db_error_after_booking' | { requote: { original_fee_cents: number; new_fee_cents: number; new_quote_id: string } }>();
  const dispatchCalls: { order_id: string; opts: any }[] = [];
  let del = 0;
  const createUberDelivery = (_supabase: any, order: any, _restaurant: any, opts: any) => {
    dispatchCalls.push({ order_id: order.id, opts: structuredClone(opts) });
    calls.push(`dispatch:${order.id}`);
    if (order.delivery_fulfillment_method !== 'uber_direct') return Promise.resolve({ status: 200, body: { success: false, error: 'not_uber_direct' } });
    if (order.uber_delivery_id) return Promise.resolve({ status: 200, body: { success: true, idempotent: true, delivery_id: order.uber_delivery_id } });
    if (order.status !== 'new' && order.status !== 'scheduled') return Promise.resolve({ status: 200, body: { success: false, error: 'invalid_status' } });
    const out = dispatchOutcome.get(order.id) ?? 'ok';
    let refreshedQuote: string | null = null;
    if (typeof out === 'object') {
      if (opts.acceptedQuoteId !== out.requote.new_quote_id) {
        return Promise.resolve({ status: 200, body: { success: false, error: 'quote_price_changed', new_fee_cents: out.requote.new_fee_cents, original_fee_cents: out.requote.original_fee_cents, delta_cents: out.requote.new_fee_cents - out.requote.original_fee_cents, new_quote_id: out.requote.new_quote_id } });
      }
      refreshedQuote = out.requote.new_quote_id;
    } else if (out === 'rate_limited') return Promise.resolve({ status: 200, body: { success: false, error: 'rate_limited', retry_after: 7 } });
    else if (out === 'no_uber_available' || out === 'bad_address') return Promise.resolve({ status: 200, body: { success: false, error: out, status: 400, detail: 'fake' } });
    else if (out === 'uber_unavailable') return Promise.resolve({ status: 200, body: { success: false, error: 'uber_unavailable', detail: 'fake' } });
    const deliveryId = `del_fake_${++del}`;
    if (out === 'db_error_after_booking') return Promise.resolve({ status: 500, body: { success: false, step: 'persist', error: 'db_error', detail: 'fake', delivery_id: deliveryId, tracking_url: null } });
    const nowIso = new Date().toISOString();
    const pickupMs = opts.pickupReadyDt ? Date.parse(opts.pickupReadyDt) : Date.now() + opts.pickupReadyMinutes * 60_000;
    const row = db.rows('orders').find((o) => o.id === order.id)!;
    const updates: Record<string, unknown> = {
      uber_delivery_id: deliveryId, uber_tracking_url: `https://track.example/${deliveryId}`, uber_status: 'pending', uber_status_updated_at: nowIso,
      uber_dispatched_at: nowIso, uber_pickup_ready_dt: new Date(pickupMs).toISOString(), status: opts.postWriteStatus,
    };
    if (opts.stampAcceptedAt !== false && !order.accepted_at) updates.accepted_at = nowIso;
    if (refreshedQuote) Object.assign(updates, { uber_quote_id: refreshedQuote, uber_quoted_fee: 9.99 });
    Object.assign(row, updates);
    return Promise.resolve({ status: 200, body: { success: true, delivery_id: deliveryId, tracking_url: updates.uber_tracking_url, status: 'pending', refreshed_quote: !!refreshedQuote } });
  };
  return { stripe, cancelUberDelivery, refundUberAppFee, createUberDelivery, calls, refunds, stripeCalls, stripeOutcome, uberOutcome, appFee, dispatchOutcome, dispatchCalls };
}
