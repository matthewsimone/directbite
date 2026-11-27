import { IS_NATIVE } from './native'

export const MARKETING_POLICY_VERSION = '2026-11-27-email'

// Exact checkout notice wording; {restaurant} = restaurant name. Stored as proof of consent.
export const EMAIL_NOTICE_TEMPLATE =
  'By placing your order, you agree to receive promotional emails from {restaurant} sent through Ordr, and to our Terms and Privacy Policy. You can unsubscribe at any time. We may also text or email you about this order and your account.'

// Fire-and-forget. Never throws, never blocks the confirmation page.
export function recordEmailConsent(paymentIntentId) {
  if (!paymentIntentId) return
  try {
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/marketing-consent`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment_intent_id: paymentIntentId,
        sms: false,
        email_opt: true,
        email_text: EMAIL_NOTICE_TEMPLATE,
        policy_version: MARKETING_POLICY_VERSION,
        source: IS_NATIVE ? 'checkout_app' : 'checkout_web',
      }),
    }).catch(() => {})
  } catch {}
}
