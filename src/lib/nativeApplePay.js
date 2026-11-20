import { Capacitor } from '@capacitor/core'
import { IS_NATIVE, APPLE_MERCHANT_ID } from './native'

// The only module that touches @capacitor-community/stripe, and only through
// a dynamic import, so the plugin is never fetched on web. Every export is a
// no-op (false) outside the iOS shell.

let pluginPromise = null

function getPlugin() {
  if (!pluginPromise) {
    pluginPromise = import('@capacitor-community/stripe')
      .then((m) => ({ Stripe: m.Stripe, ApplePayEventsEnum: m.ApplePayEventsEnum }))
      .catch((err) => {
        pluginPromise = null // a failed load must not be memoized; let a later call retry
        throw err
      })
  }
  return pluginPromise
}

export async function isNativeApplePayAvailable() {
  if (!IS_NATIVE || Capacitor.getPlatform() !== 'ios' || !APPLE_MERCHANT_ID) return false
  try {
    const { Stripe } = await getPlugin()
    await Stripe.isApplePayAvailable()
    return true
  } catch {
    return false
  }
}

// Resolves 'completed' | 'failed' | 'canceled'. onPaymentMethod(contact) runs
// after the customer authorizes and BEFORE Stripe confirms; it returns
// { ok, message? }, and ok:false aborts the payment with no charge.
// Requires the patched plugin (createApplePay waitForContinue + applePayContinue).
export async function payWithNativeApplePay({ publishableKey, stripeAccount, clientSecret, amount, label, onPaymentMethod }) {
  const { Stripe, ApplePayEventsEnum } = await getPlugin()
  const handles = []
  try {
    await Stripe.initialize({ publishableKey, stripeAccount })
    handles.push(await Stripe.addListener(ApplePayEventsEnum.DidCreatePaymentMethod, async ({ contact } = {}) => {
      let r
      try {
        r = await onPaymentMethod(contact || {})
      } catch {
        r = { ok: false, message: 'Payment could not be completed' }
      }
      try {
        await Stripe.applePayContinue({ ok: !!r?.ok, message: r?.message })
      } catch (e) {
        console.error('[NativeApplePay] continue failed', e)
      }
    }))
    await Stripe.createApplePay({
      paymentIntentClientSecret: clientSecret,
      paymentSummaryItems: [{ label, amount }],
      merchantIdentifier: APPLE_MERCHANT_ID,
      countryCode: 'US',
      currency: 'USD',
      requiredShippingContactFields: ['name', 'phoneNumber', 'emailAddress'],
      waitForContinue: true,
    })
    const { paymentResult } = await Stripe.presentApplePay()
    if (paymentResult === ApplePayEventsEnum.Completed) return 'completed'
    if (paymentResult === ApplePayEventsEnum.Canceled) return 'canceled'
    return 'failed'
  } finally {
    await Promise.all(handles.map((h) => h.remove().catch(() => {})))
  }
}
