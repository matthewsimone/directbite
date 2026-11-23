/**
 * W3 (CP8c): create-payment-intent's update path never 500s on a PI Stripe won't update.
 * Stripe is mocked: errors are plain objects with Stripe's `type` / `code`, and the re-read status is
 * injected.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { classifyUpdateError, isUpdatableStatus, lockedResponse } from '../stripeIntentUpdate.ts';

const stripeErr = (type: string, code?: string, message = 'x') => ({ type, code, message });
// The live error (CP8c): an update after capture.
const AFTER_CAPTURE = stripeErr('StripeInvalidRequestError', undefined, 'application_fee_amount cannot be updated on a PaymentIntent after a capture has already been made.');

Deno.test('status gate: only requires_payment_method / requires_confirmation are updatable', () => {
  for (const s of ['requires_payment_method', 'requires_confirmation']) assertEquals(isUpdatableStatus(s), true, s);
  for (const s of ['succeeded', 'processing', 'requires_capture', 'requires_action', 'canceled', '', null, undefined]) assertEquals(isUpdatableStatus(s), false, String(s));
  assertEquals(lockedResponse('succeeded'), { status: 409, body: { error: 'payment_locked', status: 'succeeded' } });
});

Deno.test('race: the update fails because the PI was captured meanwhile → 409 payment_locked with the current status (never 500)', async () => {
  for (const s of ['succeeded', 'processing', 'requires_capture', 'requires_action', 'canceled']) {
    assertEquals(await classifyUpdateError(AFTER_CAPTURE, () => Promise.resolve(s)), { status: 409, body: { error: 'payment_locked', status: s } }, s);
  }
  // any Stripe error type, as long as the PI is no longer updatable
  assertEquals(await classifyUpdateError(stripeErr('StripeAPIError'), () => Promise.resolve('succeeded')), { status: 409, body: { error: 'payment_locked', status: 'succeeded' } });
});

Deno.test('still updatable (or the re-read failed) → mapped by Stripe error type, never 500', async () => {
  const stillOpen = () => Promise.resolve('requires_payment_method');
  const rereadFails = () => Promise.reject(new Error('network'));
  for (const reread of [stillOpen, rereadFails, null]) {
    assertEquals(await classifyUpdateError(AFTER_CAPTURE, reread), { status: 400, body: { error: 'payment_update_failed', code: null } });
    assertEquals(await classifyUpdateError(stripeErr('StripeInvalidRequestError', 'amount_too_small'), reread), { status: 400, body: { error: 'payment_update_failed', code: 'amount_too_small' } });
    assertEquals(await classifyUpdateError(stripeErr('StripeInvalidRequestError', 'resource_missing'), reread), { status: 409, body: { error: 'payment_intent_stale' } });
    for (const t of ['StripeRateLimitError', 'StripeConnectionError', 'StripeAPIError']) assertEquals(await classifyUpdateError(stripeErr(t), reread), { status: 503, body: { error: 'stripe_unavailable' } }, t);
    for (const t of ['StripeAuthenticationError', 'StripePermissionError']) assertEquals(await classifyUpdateError(stripeErr(t), reread), { status: 503, body: { error: 'restaurant_payments_unavailable' } }, t);
    assertEquals(await classifyUpdateError(stripeErr('StripeIdempotencyError'), reread), { status: 409, body: { error: 'idempotency_conflict' } });
  }
});

Deno.test('a non-Stripe error is not classified (the caller keeps its existing 500) and the PI is not re-read', async () => {
  let reads = 0;
  const reread = () => { reads++; return Promise.resolve('succeeded'); };
  assertEquals(await classifyUpdateError(new Error('boom'), reread), null);
  assertEquals(await classifyUpdateError(null, reread), null);
  assertEquals(await classifyUpdateError({ message: 'no type' }, reread), null);
  assertEquals(reads, 0);
});
