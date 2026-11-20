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

// pay.js is used ONLY to render Google's official button; payment goes through
// the native plugin (presentNativeGooglePay). No PaymentsClient payment call
// (isReadyToPay / loadPaymentData) is ever made.
const PAY_JS_SRC = 'https://pay.google.com/gp/p/js/pay.js'
let payJsPromise = null

function loadGooglePayJs() {
  if (window.google?.payments?.api) return Promise.resolve()
  if (!payJsPromise) {
    payJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = PAY_JS_SRC
      script.async = true
      const fail = (msg) => {
        clearTimeout(timer)
        script.remove() // so a retry injects a fresh tag
        reject(new Error(msg))
      }
      const timer = setTimeout(() => fail('pay.js load timeout'), 3000)
      script.addEventListener('load', () => {
        clearTimeout(timer)
        if (window.google?.payments?.api) resolve()
        else fail('pay.js loaded without google.payments.api')
      })
      script.addEventListener('error', () => fail('pay.js failed to load'))
      document.head.appendChild(script)
    }).catch((err) => {
      payJsPromise = null // a failed load must not be memoized; let a later call retry
      throw err
    })
  }
  return payJsPromise
}

export async function mountGooglePayButton(container, onClick) {
  if (!IS_NATIVE || Capacitor.getPlatform() !== 'android') return false
  try {
    await loadGooglePayJs()
    const client = new window.google.payments.api.PaymentsClient({
      environment: 'TEST', // only affects payment data, which is never requested here; revisit at Config B
    })
    const btn = client.createButton({
      onClick,
      buttonType: 'plain',
      buttonColor: 'black',
      buttonRadius: 12,
      buttonSizeMode: 'fill',
    })
    container.replaceChildren(btn)
    return true
  } catch (err) {
    console.warn('[NativeGooglePay] button render failed', err)
    return false
  }
}
