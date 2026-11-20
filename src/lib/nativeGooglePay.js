import { Capacitor } from '@capacitor/core'
import { IS_NATIVE } from './native'

// Android shell only. Touches @capacitor-community/stripe through a dynamic
// import, so the plugin is never fetched on web. Requires the patched plugin
// (isGooglePayPaymentMethodAvailable / presentGooglePayPaymentMethod), which
// returns a PaymentMethod and never charges — JS confirms.

let pluginPromise = null

function getPlugin() {
  if (!pluginPromise) {
    pluginPromise = import('@capacitor-community/stripe')
      .then((m) => ({ Stripe: m.Stripe }))
      .catch((err) => {
        pluginPromise = null // a failed load must not be memoized; let a later call retry
        throw err
      })
  }
  return pluginPromise
}

export async function isNativeGooglePayAvailable() {
  if (!IS_NATIVE || Capacitor.getPlatform() !== 'android') return false
  try {
    const { Stripe } = await getPlugin()
    const { available } = await Stripe.isGooglePayPaymentMethodAvailable()
    return !!available
  } catch {
    return false
  }
}

// Resolves { status: 'completed', paymentMethodId, name, email, phone }
// | { status: 'canceled' } | { status: 'failed', error }.
export async function presentNativeGooglePay({ amountCents, currency = 'USD' }) {
  try {
    const { Stripe } = await getPlugin()
    return await Stripe.presentGooglePayPaymentMethod({ currency, amount: amountCents })
  } catch (err) {
    return { status: 'failed', error: err?.message || String(err) }
  }
}
