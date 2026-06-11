import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { loadStripe } from '@stripe/stripe-js/pure'
import {
  Elements,
  PaymentElement,
  PaymentRequestButtonElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import toast from 'react-hot-toast'
import { useRestaurant } from '../../hooks/useRestaurant'
import { usePromotion } from '../../hooks/usePromotion'
import { useCart } from '../../hooks/useCart'
import { supabase } from '../../lib/supabase'
import { formatCurrency } from '../../utils/format'
import { haversineDistanceMiles, calculateDeliveryFeeCents } from '../../utils/haversine'
import { getAvailableDates, getAvailableTimeSlots, formatScheduledLabel } from '../../utils/scheduling'
import TimePickerModal from '../../components/TimePickerModal'
// @googlemaps/js-api-loader is dynamically imported when needed
import applePayLogo from '../../assets/payment-marks/apple-pay.svg'
import googlePayLogo from '../../assets/payment-marks/google-pay.svg'

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''

// ---------- Tip Selector ----------
// Order-type-dependent default: pickup → "No Tip"; delivery → 15%. Once the
// user taps any option, userSelectedRef latches on for the session and
// further orderType switches no longer reset the selection.
function TipSelector({ subtotal, orderType, onTipChange }) {
  const [tipType, setTipType] = useState(orderType === 'delivery' ? '15' : 'none')
  const [customTip, setCustomTip] = useState('')
  const userSelectedRef = useRef(false)

  // Apply default whenever orderType (or subtotal) changes, unless the
  // user has manually selected. Replaces the prior mount-only effect.
  useEffect(() => {
    if (userSelectedRef.current) return
    if (orderType === 'delivery') {
      setTipType('15')
      onTipChange(subtotal > 0 ? Math.round(subtotal * 0.15 * 100) / 100 : 0)
    } else {
      setTipType('none')
      onTipChange(0)
    }
  }, [orderType, subtotal])

  function selectPreset(pct) {
    userSelectedRef.current = true
    setTipType(pct)
    setCustomTip('')
    onTipChange(Math.round(subtotal * (Number(pct) / 100) * 100) / 100)
  }

  function selectCustom() {
    userSelectedRef.current = true
    setTipType('custom')
    onTipChange(Number(customTip) || 0)
  }

  function selectNone() {
    userSelectedRef.current = true
    setTipType('none')
    setCustomTip('')
    onTipChange(0)
  }

  function handleCustomChange(val) {
    setCustomTip(val)
    if (tipType === 'custom') {
      onTipChange(Number(val) || 0)
    }
  }

  const presets = ['10', '15', '20']

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
        Add a Tip
      </h3>
      <div className="flex flex-row flex-nowrap gap-1">
        {presets.map(pct => (
          <button
            key={pct}
            onClick={() => selectPreset(pct)}
            className={`flex-1 py-2 px-1 rounded-xl text-xs font-semibold transition-colors ${
              tipType === pct
                ? 'bg-[#16A34A] text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {pct}%
          </button>
        ))}
        <button
          onClick={selectCustom}
          className={`flex-1 py-2 px-1 rounded-xl text-xs font-semibold transition-colors ${
            tipType === 'custom'
              ? 'bg-[#16A34A] text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Custom
        </button>
        <button
          onClick={selectNone}
          className={`flex-1 py-2 px-1 rounded-xl text-xs font-semibold transition-colors ${
            tipType === 'none'
              ? 'bg-[#16A34A] text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          No Tip
        </button>
      </div>

      {tipType === 'custom' && (
        <div className="mt-3 relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-medium">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={customTip}
            onChange={e => handleCustomChange(e.target.value)}
            placeholder="0.00"
            autoFocus
            className="w-full pl-8 pr-4 py-3 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
          />
        </div>
      )}
    </div>
  )
}

function friendlyPaymentError(error) {
  console.error('[Payment] Stripe error:', { type: error.type, code: error.code, decline_code: error.decline_code, message: error.message })
  if (error.type === 'card_error' || error.type === 'validation_error') {
    if (error.code === 'card_declined') return 'Your card was declined. Please try a different card or contact your bank.'
    if (error.code === 'expired_card') return 'Your card has expired. Please use a different card.'
    if (error.code === 'processing_error') return 'There was a problem processing your card. Please try again.'
    return 'We couldn\'t process your card. Please check your card number, expiration date, security code, and ZIP code, then try again.'
  }
  return 'Something went wrong. Please try again.'
}

// ---------- Payment Form (inside Stripe Elements) ----------
function PaymentForm({ onSuccess, total, customerInfo, orderData, slug, restaurant, disabled: externalDisabled, clientSecret, paymentIntentId, onWalletCustomer, onValidateDelivery, feeCalculating, needsAddress, showPlaceholder }) {
  const stripe = useStripe()
  const elements = useElements()
  const [loading, setLoading] = useState(false)
  const submittedRef = useRef(false)

  // Wallet detection via PaymentRequest API — pre-seed from sessionStorage cache
  const [paymentRequest, setPaymentRequest] = useState(null)
  const cachedWallet = useRef(() => {
    try { return JSON.parse(sessionStorage.getItem('walletAvailability') || 'null')?.result } catch { return null }
  })
  const hasCachedWallet = cachedWallet.current?.applePay || cachedWallet.current?.googlePay
  const [walletChecked, setWalletChecked] = useState(hasCachedWallet) // skip loading if cache exists
  const [walletType, setWalletType] = useState(() => {
    if (cachedWallet.current?.applePay) return 'applePay'
    if (cachedWallet.current?.googlePay) return 'googlePay'
    return null
  })
  const [payMethod, setPayMethod] = useState(() => {
    if (cachedWallet.current?.applePay || cachedWallet.current?.googlePay) return 'wallet'
    return 'card'
  })

  // Refs for values needed in paymentmethod event handler (avoids stale closures)
  const clientSecretRef = useRef(clientSecret)
  const onSuccessRef = useRef(onSuccess)
  const onWalletCustomerRef = useRef(onWalletCustomer)
  const paymentIntentIdRef = useRef(paymentIntentId)
  const onValidateDeliveryRef = useRef(onValidateDelivery)
  useEffect(() => { clientSecretRef.current = clientSecret }, [clientSecret])
  useEffect(() => { onSuccessRef.current = onSuccess }, [onSuccess])
  useEffect(() => { onWalletCustomerRef.current = onWalletCustomer }, [onWalletCustomer])
  useEffect(() => { paymentIntentIdRef.current = paymentIntentId }, [paymentIntentId])
  useEffect(() => { onValidateDeliveryRef.current = onValidateDelivery }, [onValidateDelivery])

  // Create PaymentRequest ONCE when stripe is ready
  useEffect(() => {
    if (!stripe || !total || total <= 0) return

    const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''
    console.log('[PaymentRequest] Creating once. Key prefix:', pk.slice(0, 8) + '..., total:', total)

    const pr = stripe.paymentRequest({
      country: 'US',
      currency: 'usd',
      total: { label: 'DirectBite Order', amount: Math.round(total * 100) },
      requestPayerName: true,
      requestPayerEmail: true,
      requestPayerPhone: true,
    })

    pr.canMakePayment().then(result => {
      console.log('[PaymentRequest] canMakePayment result:', JSON.stringify(result))
      if (result) {
        setPaymentRequest(pr)
        if (result.applePay) {
          setWalletType('applePay')
          setPayMethod('wallet')
        } else if (result.googlePay) {
          setWalletType('googlePay')
          setPayMethod('wallet')
        }
      }
      setWalletChecked(true)
    }).catch(err => {
      console.error('[PaymentRequest] canMakePayment error:', err)
      setWalletChecked(true)
    })

    // Handle wallet payment confirmation
    pr.on('paymentmethod', async (ev) => {
      console.log('[PAYMENTMETHOD] event fired — this means user authenticated in wallet sheet')
      if (submittedRef.current) { ev.complete('fail'); return }

      // Validate delivery address before proceeding (now async — M5c silent re-quote)
      const validateFn = onValidateDeliveryRef.current
      console.log('[PAYMENTMETHOD] validateFn exists:', !!validateFn)
      if (validateFn) {
        const isValid = await validateFn()
        console.log('[PAYMENTMETHOD] validation result:', isValid)
        if (!isValid) {
          console.log('[PAYMENTMETHOD] BLOCKED — delivery validation failed')
          ev.complete('fail')
          submittedRef.current = false
          toast.error('Please enter a delivery address before paying')
          return
        }
      }

      submittedRef.current = true

      const secret = clientSecretRef.current
      if (!secret) {
        ev.complete('fail')
        submittedRef.current = false
        toast.error('Payment not ready. Please try again.')
        return
      }

      // Extract customer data from wallet (Apple Pay / Google Pay)
      const walletName = ev.payerName || ''
      const walletEmail = ev.payerEmail || ''
      const walletPhone = (ev.payerPhone || '').replace(/\D/g, '') // strip non-digits

      // Update pending_orders with wallet customer data before confirming payment
      if (onWalletCustomerRef.current) {
        try {
          await onWalletCustomerRef.current(walletName, walletEmail, walletPhone)
        } catch (err) {
          console.error('[Wallet] Failed to update customer data:', err)
          ev.complete('fail')
          submittedRef.current = false
          toast.error('Failed to save customer info. Please try again.')
          return
        }
      }

      const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
        secret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      )

      if (confirmError) {
        ev.complete('fail')
        submittedRef.current = false
        toast.error(friendlyPaymentError(confirmError))
      } else {
        ev.complete('success')
        if (paymentIntent.status === 'requires_action') {
          const { error } = await stripe.confirmCardPayment(secret)
          if (error) {
            toast.error(friendlyPaymentError(error))
          } else {
            onSuccessRef.current(paymentIntent.id)
          }
        } else {
          onSuccessRef.current(paymentIntent.id)
        }
      }
    })
    console.log('[PaymentRequest] paymentmethod listener registered on pr')
  }, [stripe]) // eslint-disable-line react-hooks/exhaustive-deps

  // Update payment request amount when total changes (does NOT re-create)
  useEffect(() => {
    if (paymentRequest && total > 0) {
      paymentRequest.update({
        total: { label: 'DirectBite Order', amount: Math.round(total * 100) },
      })
    }
  }, [paymentRequest, total])

  // Card payment submit
  async function handleSubmit(e) {
    e.preventDefault()
    if (!stripe || !elements || payMethod === 'wallet') return
    if (submittedRef.current) return
    submittedRef.current = true

    if (!customerInfo.name.trim() || !customerInfo.phone.trim()) {
      toast.error('Please fill in your name and phone number')
      submittedRef.current = false
      return
    }
    if (!customerInfo.email.trim()) {
      toast.error('Please enter your email address')
      submittedRef.current = false
      return
    }

    if (onValidateDelivery) {
      const isValid = await onValidateDelivery()
      if (!isValid) {
        submittedRef.current = false
        return
      }
    }

    setLoading(true)

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/${slug}/confirmation`,
        payment_method_data: {
          billing_details: {
            name: customerInfo.name.trim() || undefined,
            email: customerInfo.email.trim() || undefined,
            phone: customerInfo.phone.trim() || undefined,
          },
        },
      },
      redirect: 'if_required',
    })

    if (error) {
      toast.error(friendlyPaymentError(error))
      setLoading(false)
      submittedRef.current = false
      return
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      onSuccess(paymentIntent.id)
    }
  }

  // Determine wallet label and icon
  const walletLabel = walletType === 'applePay' ? 'Apple Pay' : walletType === 'googlePay' ? 'Google Pay' : null

  if (!walletChecked) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-6 h-6 border-2 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
        <span className="ml-3 text-sm text-gray-500">Loading payment options...</span>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* Payment method selection */}
      <div className="space-y-3 mb-5">
        {/* Wallet option — only if available */}
        {paymentRequest && walletLabel && (
          <label
            className={`flex items-center justify-between p-4 rounded-xl border-2 cursor-pointer transition-colors ${
              payMethod === 'wallet' ? 'border-[#16A34A] bg-green-50/50' : 'border-gray-200'
            }`}
          >
            <div className="flex items-center gap-3">
              <input type="radio" name="payMethod" checked={payMethod === 'wallet'} onChange={() => setPayMethod('wallet')} className="accent-[#16A34A] w-4 h-4" />
              <div className="flex items-center gap-2.5">
                <img src={walletType === 'applePay' ? applePayLogo : googlePayLogo} alt={walletLabel} style={{ height: 20 }} />
                <span className="font-medium text-gray-900">{walletLabel}</span>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#16A34A] bg-green-50 px-2 py-0.5 rounded-full">
              <svg viewBox="0 0 24 24" fill="#16a34a" width="12" height="12"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
              Express
            </span>
          </label>
        )}

        {/* Credit Card option — always shown */}
        <label
          className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
            payMethod === 'card' ? 'border-[#16A34A] bg-green-50/50' : 'border-gray-200'
          }`}
        >
          <input type="radio" name="payMethod" checked={payMethod === 'card'} onChange={() => setPayMethod('card')} className="accent-[#16A34A] w-4 h-4" />
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <span className="font-medium text-gray-900">Credit Card</span>
          </div>
        </label>
      </div>

      {/* Card form — contact fields above card, Link signup inline below */}
      {payMethod === 'card' && (
        <div className="space-y-4">
          {/* 1. Email */}
          <input
            type="email"
            value={customerInfo.email}
            onChange={e => customerInfo.setEmail(e.target.value)}
            placeholder="Email Address"
            className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
          />
          {/* 2. Full Name */}
          <input
            type="text"
            value={customerInfo.name}
            onChange={e => customerInfo.setName(e.target.value)}
            placeholder="Full Name"
            className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
          />
          {/* 3. Phone */}
          <input
            type="tel"
            value={customerInfo.phone}
            onChange={e => customerInfo.setPhone(e.target.value)}
            placeholder="Phone Number"
            className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
          />

          {/* 4. Card details — card only */}
          <PaymentElement
            options={{
              wallets: { applePay: 'never', googlePay: 'never' },
              paymentMethodOrder: ['card'],
              fields: {
                billingDetails: { name: 'never', email: 'never', phone: 'never' },
              },
            }}
          />
        </div>
      )}

      <p className="text-xs text-gray-500 text-center mt-4">
        By placing your order, you agree to the{' '}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline">
          Terms of Service
        </a>{' '}
        and{' '}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">
          Privacy Policy
        </a>
      </p>

      {/* Floating payment bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 px-5 py-4">
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-3">
            <span className="text-2xl font-bold text-gray-900">{showPlaceholder ? '—' : formatCurrency(total)}</span>
          </div>

          {payMethod === 'wallet' && paymentRequest && !showPlaceholder ? (
            <div
              onClickCapture={() => {
                console.log('[WRAPPER] click captured on wallet button wrapper (may not fire for iframe)')
              }}
            >
              <PaymentRequestButtonElement
                options={{
                  paymentRequest,
                  style: {
                    paymentRequestButton: {
                      type: 'default',
                      theme: 'dark',
                      height: '56px',
                    },
                  },
                }}
              />
            </div>
          ) : (
            <button
              type="submit"
              disabled={!stripe || loading || externalDisabled || showPlaceholder}
              className="w-full bg-[#16A34A] text-white font-bold text-lg py-4 rounded-xl disabled:opacity-50 active:scale-[0.98] transition-transform"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Processing...
                </span>
              ) : needsAddress ? (
                'Enter Address'
              ) : feeCalculating ? (
                'Calculating...'
              ) : (
                `Pay ${formatCurrency(total)}`
              )}
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

// ---------- Main Checkout Page ----------
export default function CheckoutPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { restaurant, hours, isOpen, loading: restLoading } = useRestaurant(slug)
  const { promotion } = usePromotion(restaurant?.id)
  const { items, subtotal, clearCart } = useCart()

  const [orderType, setOrderType] = useState('pickup')
  // null = ASAP order; ISO timestamp = scheduled future order. The button
  // label reflects this directly; the modal handles its own internal
  // selection state and only writes back on Update.
  const [scheduledFor, setScheduledFor] = useState(null)
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [includeUtensils, setIncludeUtensils] = useState(false)
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [tip, setTip] = useState(0)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryApt, setDeliveryApt] = useState('')
  const [deliveryLat, setDeliveryLat] = useState(null)
  const [deliveryLon, setDeliveryLon] = useState(null)
  const [deliveryDistance, setDeliveryDistance] = useState(null)
  const [deliveryFeeCents, setDeliveryFeeCents] = useState(null)
  const [addressError, setAddressError] = useState(null)
  // M5c — Uber Direct quote state (only populated when delivery_fulfillment != 'in_house')
  const [resolvedMode, setResolvedMode] = useState(null) // null | 'in_house' | 'uber_direct'
  const [uberQuoteId, setUberQuoteId] = useState(null)
  const [uberQuotedFeeCents, setUberQuotedFeeCents] = useState(null)
  const [uberCustomerFeeCents, setUberCustomerFeeCents] = useState(null)
  const [quoteExpiresAt, setQuoteExpiresAt] = useState(null)
  const [uberEnvironment, setUberEnvironment] = useState(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const quoteAbortController = useRef(null)
  const [mapsLoaded, setMapsLoaded] = useState(false)
  const autocompleteRef = useRef(null)
  const inputRef = useRef(null)
  const deliveryMinimum = Number(
    (resolvedMode === 'uber_direct'
      ? restaurant?.delivery_minimum_uber_direct
      : restaurant?.delivery_minimum_in_house) || 0
  )
  const belowMinimum = orderType === 'delivery' && deliveryMinimum > 0 && subtotal < deliveryMinimum
  const [clientSecret, setClientSecret] = useState(null)
  const [paymentIntentId, setPaymentIntentId] = useState(null)
  const [stripeAccount, setStripeAccount] = useState(null)
  const [initError, setInitError] = useState(null)
  const idempotencyKey = useRef(Math.random().toString(36).slice(2) + Date.now().toString(36))

  // Compute full (undiscounted) subtotal from cart items' fullBasePrice/fullPrice
  const discountPercentage = promotion ? Number(promotion.discount_percentage) : 0
  const fullSubtotal = items.reduce((sum, item) => {
    const base = parseFloat(item.fullBasePrice ?? item.basePrice) || 0
    const tops = (item.toppings || []).reduce((s, t) => s + (parseFloat(t.fullPrice ?? t.price) || 0), 0)
    return sum + (base + tops) * (item.quantity || 1)
  }, 0)
  const discountAmount = Math.round(fullSubtotal * (discountPercentage / 100) * 100) / 100
  const discountedSubtotal = fullSubtotal - discountAmount
  const defaultFeeCents = restaurant?.delivery_tier1_fee_cents ?? 0
  // M6.5b: Restructured to keep uber_direct path exclusive of in_house
  // fallbacks. Prevents the deliveryFee from flashing the in_house default
  // (e.g., "Free" or a stale haversine value) during the place_changed →
  // E5 render gap. Three explicit modes: in_house always uses in_house fee;
  // uber_direct uses uber fee when resolved; 'both' uses whichever resolved.
  // During the unresolved window, falls back to 0 (display layer shows "—"
  // via showPlaceholder).
  const deliveryFee = orderType === 'delivery'
    ? (restaurant?.delivery_fulfillment === 'in_house'
        ? (deliveryFeeCents != null ? deliveryFeeCents : defaultFeeCents) / 100
        : (resolvedMode === 'uber_direct' && uberCustomerFeeCents != null
            ? uberCustomerFeeCents / 100
            : (resolvedMode === 'in_house' && deliveryFeeCents != null
                ? deliveryFeeCents / 100
                : 0)))
    : 0
  // M6.5: Show — during quote loading to prevent showing stale fee during
  // the uber-quote async window. The number above stays a valid Number so
  // the math and Stripe amounts stay correct underneath; the UI just
  // renders "—" / "Calculating..." while feeCalculating is true.
  const feeCalculating = quoteLoading && orderType === 'delivery'
  // M6.5 refinement: distinguish "no address yet" from "quote in flight".
  // Without an address, deliveryFee falls to defaultFeeCents/100 — a
  // wrong-but-non-null number that would silently power a Pay button with
  // an incorrect amount. Treat both states as "show placeholder" for the
  // UI, but render distinct button labels ("Enter Address" vs
  // "Calculating...") so the customer knows what to do next.
  const needsAddress = orderType === 'delivery' && !deliveryLat
  const showPlaceholder = needsAddress || feeCalculating
  const taxRate = Number(restaurant?.tax_rate || 0)
  const serviceFee = 1.50
  const taxableAmount = discountedSubtotal + deliveryFee + serviceFee
  const taxAmount = Math.round(taxableAmount * taxRate * 100) / 100
  const total = Math.round((discountedSubtotal + deliveryFee + taxAmount + tip + serviceFee) * 100) / 100

  const estimatedTime =
    orderType === 'pickup'
      ? restaurant?.estimated_pickup_minutes
      : restaurant?.estimated_delivery_minutes

  // Schedule lead time floors at 30 min (locked spec) but honors longer
  // prep estimates so we don't offer slots the kitchen can't honor.
  const leadTimeMinutes = Math.max(Number(estimatedTime) || 30, 30)

  // Pre-populate scheduledFor with the first available slot when the
  // restaurant is closed — there's no ASAP option in that state, so the
  // button must already show a real future time.
  useEffect(() => {
    if (!restaurant) return
    if (isOpen) return
    if (scheduledFor) return
    const dates = getAvailableDates(hours, { leadTimeMinutes })
    if (dates.length === 0) return
    const slots = getAvailableTimeSlots(dates[0].date, hours, { leadTimeMinutes })
    if (slots.length === 0) return
    setScheduledFor(slots[0].value)
  }, [restaurant, isOpen, hours, leadTimeMinutes, scheduledFor])

  // Build full delivery address string
  const fullDeliveryAddress = orderType === 'delivery' && deliveryAddress.trim()
    ? `${deliveryAddress.trim()}${deliveryApt.trim() ? `, Apt ${deliveryApt.trim()}` : ''}`
    : null

  // Build order_data to pass to edge function (and ultimately to webhook)
  const buildOrderData = useCallback(() => ({
    restaurant_id: restaurant?.id,
    order_type: orderType,
    scheduled_for: scheduledFor,
    customer_name: customerName.trim(),
    customer_phone: customerPhone.trim(),
    customer_email: customerEmail.trim(),
    delivery_address: fullDeliveryAddress,
    // M9a: dropoff coordinates persisted on the orders row so
    // uber-create-delivery can re-quote if the cached quote has expired
    // at Accept time. NULL for pickup orders.
    dropoff_lat: orderType === 'delivery' ? deliveryLat : null,
    dropoff_lng: orderType === 'delivery' ? deliveryLon : null,
    subtotal: fullSubtotal,
    discount_amount: discountAmount,
    discount_percentage: discountPercentage,
    delivery_fee: deliveryFee,
    tax_amount: taxAmount,
    tip_amount: tip,
    service_fee: serviceFee,
    total_amount: total,
    include_utensils: includeUtensils,
    special_instructions: specialInstructions.trim() || null,
    // M5c: Uber Direct fields. NULL when in_house — stripe-webhook (M5d)
    // writes these to orders.delivery_fulfillment_method / uber_quote_id /
    // uber_quoted_fee / uber_environment on payment success.
    delivery_fulfillment_method: resolvedMode || 'in_house',
    uber_quote_id: resolvedMode === 'uber_direct' ? uberQuoteId : null,
    uber_quoted_fee: resolvedMode === 'uber_direct' && uberQuotedFeeCents != null
      ? uberQuotedFeeCents / 100 // cents → dollars per D3 (orders.uber_quoted_fee is numeric dollars)
      : null,
    uber_environment: resolvedMode === 'uber_direct' ? uberEnvironment : null,
    items: items.map(item => ({
      menu_item_id: item.menuItemId,
      item_size_id: item.itemSizeId || null,
      item_name: item.itemName,
      size_name: item.sizeName || null,
      base_price: item.fullBasePrice ?? item.basePrice,
      quantity: item.quantity,
      special_instructions: item.specialInstructions || null,
      toppings: (item.toppings || []).map(t => ({
        topping_id: t.toppingId,
        topping_name: t.toppingName,
        placement: t.placement,
        price_charged: t.fullPrice ?? t.price,
        placement_type: t.placementType || 'pizza',
      })),
    })),
  }), [restaurant?.id, orderType, scheduledFor, customerName, customerPhone, customerEmail, fullDeliveryAddress, deliveryLat, deliveryLon, fullSubtotal, discountAmount, discountPercentage, deliveryFee, taxAmount, tip, serviceFee, total, includeUtensils, specialInstructions, items, resolvedMode, uberQuoteId, uberQuotedFeeCents, uberEnvironment])

  // M6: handle quote_validation_failed errors from create-payment-intent.
  // Reset uber quote state so the existing fee-computation useEffect re-fires
  // and fetches a fresh quote. The customer sees the new price and can re-Pay.
  function handleQuoteValidationFailure(reason) {
    console.warn('[Checkout] quote validation failed; forcing re-quote', { reason })
    toast.error('Delivery quote changed. Please try again.')
    setResolvedMode(null)
    setUberQuoteId(null)
    setUberQuotedFeeCents(null)
    setUberCustomerFeeCents(null)
    setQuoteExpiresAt(null)
    setUberEnvironment(null)
  }

  // Load Google Maps JS API when delivery selected
  useEffect(() => {
    if (orderType !== 'delivery' || !restaurant?.delivery_available || mapsLoaded) return
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
    if (!apiKey) return
    import('@googlemaps/js-api-loader').then(({ importLibrary, setOptions }) => {
      setOptions({ key: apiKey })
      return importLibrary('places')
    }).then(() => setMapsLoaded(true)).catch(err => console.error('[Maps] Load failed:', err))
  }, [orderType, restaurant?.delivery_available])

  // Attach Places Autocomplete when Maps loaded and input exists
  useEffect(() => {
    if (!mapsLoaded || !inputRef.current || orderType !== 'delivery') return
    // Reset autocomplete if input element changed (pickup→delivery remount)
    autocompleteRef.current = null
    const ac = new window.google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: 'us' },
      types: ['address'],
      fields: ['formatted_address', 'geometry'],
    })
    ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (place?.geometry?.location) {
        // M6.5b: Force quoteLoading=true synchronously so feeCalculating
        // becomes true on the same render as the address change. Without
        // this, there's a one-render-frame gap where uber state is cleared
        // but quoteLoading hasn't yet been set by E5, causing the delivery
        // fee to flash through the in_house fallback.
        setQuoteLoading(true)
        // M6.5: Clear uber state on address change — prevents fee flip
        // during the uber-quote async window. Without these resets, the
        // ternary at L569 reads stale uber state and shows the prior
        // address's fee until the new quote response arrives.
        setUberQuoteId(null)
        setUberQuotedFeeCents(null)
        setUberCustomerFeeCents(null)
        setResolvedMode(null)
        setQuoteExpiresAt(null)
        setDeliveryAddress(place.formatted_address || '')
        setDeliveryLat(place.geometry.location.lat())
        setDeliveryLon(place.geometry.location.lng())
        setAddressError(null)
      } else {
        setAddressError('Could not verify this address. Please try a different one.')
      }
    })
    autocompleteRef.current = ac
  }, [mapsLoaded, orderType])

  // Log restaurant delivery config when it loads
  useEffect(() => {
    if (!restaurant) return
    console.log('[FEE] restaurant delivery config:', {
      tier1_fee_cents: restaurant.delivery_tier1_fee_cents,
      tier1_max_miles: restaurant.delivery_tier1_max_miles,
      tier2_fee_cents: restaurant.delivery_tier2_fee_cents,
      max_radius: restaurant.delivery_max_radius_miles,
      lat: restaurant.latitude,
      lon: restaurant.longitude,
    })
  }, [restaurant?.id])

  // M5c — Pure haversine calculation extracted from the existing fee-computation
  // useEffect. Used by both the in_house branch (byte-equivalent behavior) and
  // the uber-quote fallback path (when uber-quote returns resolved_mode='in_house'
  // due to credentials_not_verified / schedule_inactive / etc).
  // Returns the values the useEffect needs to call setters with; does no setState
  // itself (keeps it pure + reusable).
  function runHaversineCalc() {
    if (!restaurant?.latitude || !restaurant?.longitude) {
      return {
        distance: null,
        feeCents: null,
        errorMsg: 'This restaurant hasn\'t configured delivery yet. Please choose pickup.',
      }
    }
    const dist = haversineDistanceMiles(
      Number(restaurant.latitude), Number(restaurant.longitude),
      deliveryLat, deliveryLon
    )
    const feeCents = calculateDeliveryFeeCents(dist, restaurant)
    if (feeCents === null) {
      return {
        distance: Math.round(dist * 10) / 10,
        feeCents: null,
        errorMsg: `Sorry, delivery is not available to your address. Distance: ${dist.toFixed(1)} miles, maximum: ${restaurant.delivery_max_radius_miles} miles.`,
      }
    }
    return {
      distance: Math.round(dist * 10) / 10,
      feeCents,
      errorMsg: null,
    }
  }

  // M5c — POST to the uber-quote edge function. Accepts an AbortSignal for
  // cancellation when the delivery address changes mid-flight. Returns the
  // parsed JSON response on success, or a structured { success: false, error }
  // shape on network/fetch failure. AbortErrors are re-thrown so the caller
  // can distinguish stale responses from real failures.
  async function fetchUberQuote(signal) {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/uber-quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          restaurant_id: restaurant.id,
          dropoff_lat: deliveryLat,
          dropoff_lng: deliveryLon,
          dropoff_address: deliveryAddress,
          dropoff_phone: customerPhone || null,
          cart_subtotal_cents: Math.round(fullSubtotal * 100),
          // M-sched: when the customer picked a future slot, send it so
          // uber-quote prices against the scheduled pickup window. null for
          // ASAP — the field is harmlessly ignored by the function (and the
          // ASAP request stays byte-identical aside from this null key).
          scheduled_for: scheduledFor,
        }),
        signal,
      })
      if (!res.ok) {
        return { success: false, error: 'network', detail: `HTTP ${res.status}` }
      }
      return await res.json()
    } catch (err) {
      if (err.name === 'AbortError') throw err
      console.error('[Uber] quote fetch error', err)
      return { success: false, error: 'network', detail: String(err) }
    }
  }

  // Calculate distance and fee when delivery coordinates change.
  // M5c: branches on restaurant.delivery_fulfillment. in_house path is
  // byte-equivalent to the pre-M5c behavior; uber path calls uber-quote
  // and falls back to haversine when uber returns resolved_mode='in_house'.
  useEffect(() => {
    if (orderType !== 'delivery' || !deliveryLat || !deliveryLon) {
      setDeliveryDistance(null)
      setDeliveryFeeCents(null)
      setAddressError(null)
      setResolvedMode(null)
      setUberQuoteId(null)
      setUberQuotedFeeCents(null)
      setUberCustomerFeeCents(null)
      setQuoteExpiresAt(null)
      setUberEnvironment(null)
      setQuoteLoading(false)
      return
    }

    const fulfillment = restaurant?.delivery_fulfillment || 'in_house'

    if (fulfillment === 'in_house') {
      // In-house path: existing haversine logic, byte-equivalent behavior.
      // Zero impact on the 8 production restaurants currently in this mode.
      const result = runHaversineCalc()
      setDeliveryDistance(result.distance)
      setDeliveryFeeCents(result.feeCents)
      setAddressError(result.errorMsg)
      setResolvedMode('in_house')
      setUberQuoteId(null)
      setUberQuotedFeeCents(null)
      setUberCustomerFeeCents(null)
      setQuoteExpiresAt(null)
      setUberEnvironment(null)
      setQuoteLoading(false)
      return
    }

    // Uber path (delivery_fulfillment is 'uber_direct' or 'both').
    // Cancel any in-flight quote from a previous address change.
    if (quoteAbortController.current) {
      quoteAbortController.current.abort()
    }
    const controller = new AbortController()
    quoteAbortController.current = controller

    setQuoteLoading(true)
    setAddressError(null)

    fetchUberQuote(controller.signal)
      .then(result => {
        if (controller.signal.aborted) return // stale response, ignore

        if (!result || !result.success) {
          // delivery_unavailable, uber_unavailable, network failure, etc.
          // Per D7: generic customer-facing message; Uber-side detail logged server-side.
          setAddressError("Delivery isn't available for this address. Please try pickup or a different address.")
          setResolvedMode(null)
          setUberQuoteId(null)
          setUberQuotedFeeCents(null)
          setUberCustomerFeeCents(null)
          setQuoteExpiresAt(null)
          setUberEnvironment(null)
          setDeliveryFeeCents(null)
          setDeliveryDistance(null)
          setQuoteLoading(false)
          return
        }

        if (result.resolved_mode === 'uber_direct') {
          // Use the Uber quote; clear haversine state so the display branch
          // chooses the uber path cleanly.
          setResolvedMode('uber_direct')
          setUberQuoteId(result.uber_quote_id)
          setUberQuotedFeeCents(result.uber_quoted_fee_cents)
          setUberCustomerFeeCents(result.customer_delivery_fee_cents)
          setQuoteExpiresAt(result.expires_at)
          setUberEnvironment(result.uber_environment)
          setDeliveryFeeCents(null)
          setDeliveryDistance(null)
          setAddressError(null)
        } else {
          // resolved_mode === 'in_house' (fallback: credentials_not_verified,
          // schedule_inactive, etc). Run haversine and use that fee.
          const hav = runHaversineCalc()
          setResolvedMode('in_house')
          setUberQuoteId(null)
          setUberQuotedFeeCents(null)
          setUberCustomerFeeCents(null)
          setQuoteExpiresAt(null)
          setUberEnvironment(null)
          setDeliveryDistance(hav.distance)
          setDeliveryFeeCents(hav.feeCents)
          setAddressError(hav.errorMsg)
        }
        setQuoteLoading(false)
      })
      .catch(err => {
        if (err.name === 'AbortError') return
        console.error('[Uber] quote fetch unexpected error', err)
        setAddressError("Couldn't calculate delivery fee. Please try a different address or pickup.")
        setQuoteLoading(false)
      })

    // Cleanup: abort the in-flight quote on unmount or dep change
    return () => {
      controller.abort()
    }
  }, [orderType, deliveryLat, deliveryLon, restaurant, scheduledFor])

  // Redirect to menu if cart is empty
  useEffect(() => {
    if (!restLoading && items.length === 0) {
      navigate(`/${slug}`, { replace: true })
    }
  }, [items.length, restLoading, navigate, slug])

  // Create payment intent on page load (once restaurant is ready)
  const intentCreated = useRef(false)
  useEffect(() => {
    // M6.5b: Skip create-payment-intent when server-side resolveMode would
    // reject this request shape. Avoids the invalid POST that produces a
    // toast for the customer. Conservatively handles 'both' mode by predicting
    // uber_direct when client hasn't yet resolved.
    const wouldRejectOnServer =
      orderType === 'delivery' &&
      !uberQuoteId &&
      (restaurant?.delivery_fulfillment === 'uber_direct' ||
       (restaurant?.delivery_fulfillment === 'both' &&
        (resolvedMode === 'uber_direct' || resolvedMode === null)))
    if (wouldRejectOnServer) return
    if (!restaurant || items.length === 0 || intentCreated.current) return
    intentCreated.current = true

    async function createIntent() {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

        // Initial payment intent — we'll update order_data via metadata before confirm
        const res = await fetch(
          `${supabaseUrl}/functions/v1/create-payment-intent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseAnonKey}`,
            },
            body: JSON.stringify({
              restaurant_id: restaurant.id,
              amount: Math.round(total * 100),
              order_data: buildOrderData(),
              idempotency_key: idempotencyKey.current,
            }),
          }
        )

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          // M6: server-side quote validation rejection — reset uber state
          // so the existing useEffect re-quotes. Customer sees the new
          // price and can re-Pay.
          if (errData.error === 'quote_validation_failed') {
            // M6.5: Suppress toast on initial load — paymentIntentId is null
            // on first attempt, meaning no prior quote existed to "change
            // from". Only show toast on subsequent failures (e.g., after
            // the customer had a valid quote that then went stale).
            if (paymentIntentId) {
              handleQuoteValidationFailure(errData.reason)
            } else {
              console.warn('[Checkout] initial createIntent rejected; suppressing toast', { reason: errData.reason })
            }
            intentCreated.current = false // allow retry after re-quote
            setInitError(null)
            return
          }
          throw new Error(errData.error || 'Failed to create payment')
        }

        const data = await res.json()
        setClientSecret(data.clientSecret)
        setPaymentIntentId(data.paymentIntentId)
        setStripeAccount(data.stripeAccount)
      } catch (err) {
        console.error('Payment init error:', err)
        setInitError(err.message)
      }
    }

    createIntent()
  }, [restaurant, items.length, total, buildOrderData])

  // Update payment intent metadata when order details change
  const updateTimer = useRef(null)
  useEffect(() => {
    // M6.5b: Skip create-payment-intent when server-side resolveMode would
    // reject this request shape. Avoids the invalid POST that produces a
    // toast for the customer. Conservatively handles 'both' mode by predicting
    // uber_direct when client hasn't yet resolved.
    const wouldRejectOnServer =
      orderType === 'delivery' &&
      !uberQuoteId &&
      (restaurant?.delivery_fulfillment === 'uber_direct' ||
       (restaurant?.delivery_fulfillment === 'both' &&
        (resolvedMode === 'uber_direct' || resolvedMode === null)))
    if (wouldRejectOnServer) return
    if (!paymentIntentId || !restaurant) return

    // Debounce updates
    clearTimeout(updateTimer.current)
    updateTimer.current = setTimeout(async () => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

        const res = await fetch(
          `${supabaseUrl}/functions/v1/create-payment-intent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseAnonKey}`,
            },
            body: JSON.stringify({
              restaurant_id: restaurant.id,
              amount: Math.round(total * 100),
              order_data: buildOrderData(),
              payment_intent_id: paymentIntentId,
            }),
          }
        )
        // M6: server-side quote validation rejection — surface as a
        // re-quote prompt. Other failures stay silent (per pre-M6 behavior).
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          if (errData.error === 'quote_validation_failed') {
            handleQuoteValidationFailure(errData.reason)
            return
          }
          console.warn('Failed to update payment intent metadata:', errData.error || res.status)
        }
      } catch (err) {
        // Silent fail on metadata update — the initial data is already stored
        console.warn('Failed to update payment intent metadata:', err)
      }
    }, 800)

    return () => clearTimeout(updateTimer.current)
  }, [paymentIntentId, orderType, tip, customerName, customerPhone, customerEmail, fullDeliveryAddress, restaurant, total, includeUtensils, specialInstructions, buildOrderData])

  function handlePaymentSuccess(piId) {
    // Navigate FIRST, then clear cart — otherwise the empty-cart guard redirects to menu
    navigate(`/${slug}/confirmation`, {
      state: {
        orderNumber: null, // Will show "Processing..." until webhook writes it
        customerName: customerName.trim(),
        orderType,
        scheduledFor,
        estimatedTime,
        items,
        subtotal: fullSubtotal,
        discountAmount,
        discountPercentage,
        deliveryFee,
        taxAmount,
        tip,
        serviceFee,
        total,
        restaurantName: restaurant.name,
        restaurantPhone: restaurant.phone,
        includeUtensils,
        specialInstructions: specialInstructions.trim() || null,
        paymentIntentId: piId,
        // M8: Uber Direct attribution on confirmation page
        deliveryFulfillmentMethod: resolvedMode || 'in_house',
        uberEnvironment: resolvedMode === 'uber_direct' ? uberEnvironment : null,
        // M9a: forward dropoff coordinates so the confirmation page (or any
        // future feature there) doesn't need to re-derive them from address.
        dropoffLat: orderType === 'delivery' ? deliveryLat : null,
        dropoffLng: orderType === 'delivery' ? deliveryLon : null,
      },
    })
    // Cart is cleared on the confirmation page, not here — clearing here triggers
    // the empty-cart useEffect which redirects back to menu before navigation completes
  }

  // M5c — Validate the delivery address + (if uber_direct) silently re-quote
  // if the existing quote has expired. Returns true if the order can proceed
  // to payment, false if validation failed (caller should bail out).
  // Async because re-quoting takes a network round-trip. Both PaymentForm
  // callsites (card path in handleSubmit, wallet path in pr.on('paymentmethod'))
  // await this.
  async function onValidateDelivery() {
    if (orderType === 'delivery' && !deliveryLat) {
      setAddressError('Please enter a delivery address')
      return false
    }
    if (addressError) return false

    if (resolvedMode === 'uber_direct' && quoteExpiresAt) {
      const expiresMs = new Date(quoteExpiresAt).getTime()
      if (expiresMs < Date.now()) {
        // Silent re-quote, one-shot (no AbortController — this is a terminal action)
        const fresh = await fetchUberQuote(null)
        if (!fresh || !fresh.success) {
          toast.error("Delivery quote expired and couldn't be refreshed. Please try again.")
          return false
        }
        if (fresh.resolved_mode === 'uber_direct') {
          setResolvedMode('uber_direct')
          setUberQuoteId(fresh.uber_quote_id)
          setUberQuotedFeeCents(fresh.uber_quoted_fee_cents)
          setUberCustomerFeeCents(fresh.customer_delivery_fee_cents)
          setQuoteExpiresAt(fresh.expires_at)
          setUberEnvironment(fresh.uber_environment)
        } else {
          // Mode transitioned to in_house mid-checkout (schedule lapsed etc).
          // Fall back to haversine; bail out if haversine produces an error.
          const hav = runHaversineCalc()
          setResolvedMode('in_house')
          setUberQuoteId(null)
          setUberQuotedFeeCents(null)
          setUberCustomerFeeCents(null)
          setQuoteExpiresAt(null)
          setUberEnvironment(null)
          setDeliveryDistance(hav.distance)
          setDeliveryFeeCents(hav.feeCents)
          if (hav.errorMsg) {
            setAddressError(hav.errorMsg)
            return false
          }
        }
      }
    }

    return true
  }

  // Stripe instance scoped to connected account for direct charges
  // Must be before any early returns to maintain hook order
  const stripePromise = useMemo(() => {
    if (!stripeAccount) return loadStripe(STRIPE_PK)
    return loadStripe(STRIPE_PK, { stripeAccount })
  }, [stripeAccount])

  if (restLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!restaurant || items.length === 0) return null

  const stripeOptions = clientSecret
    ? {
        clientSecret,
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#16A34A',
            borderRadius: '12px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
        },
      }
    : null

  const customerInfo = {
    name: customerName,
    phone: customerPhone,
    email: customerEmail,
    setName: setCustomerName,
    setPhone: setCustomerPhone,
    setEmail: setCustomerEmail,
  }

  return (
    <div className="min-h-screen bg-white pb-40">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-white border-b border-gray-200 px-5 py-4 flex items-center gap-3">
        <button
          onClick={() => navigate(`/${slug}`)}
          className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-gray-100 transition-colors"
        >
          <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold text-gray-900">Review Your Order</h1>
      </div>

      <div className="max-w-lg mx-auto px-5 pt-6 space-y-8">
        {/* Order Type */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Order Type
          </h3>
          <div className="flex gap-3">
            <button
              onClick={() => { setOrderType('pickup'); setSpecialInstructions(''); setDeliveryLat(null); setDeliveryLon(null); setDeliveryFeeCents(null); setAddressError(null) }}
              className={`flex-1 py-4 rounded-xl font-semibold text-base transition-colors ${
                orderType === 'pickup'
                  ? 'bg-[#16A34A] text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Pickup
            </button>
            {restaurant.delivery_available && (
              <button
                onClick={() => setOrderType('delivery')}
                className={`flex-1 py-4 rounded-xl font-semibold text-base transition-colors ${
                  orderType === 'delivery'
                    ? 'bg-[#16A34A] text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Delivery
              </button>
            )}
          </div>
          {!scheduledFor && isOpen && (
            <p className="mt-2 text-sm text-gray-500">
              {orderType === 'pickup'
                ? `Ready in approximately ${restaurant.estimated_pickup_minutes} mins`
                : `Delivery in approximately ${restaurant.estimated_delivery_minutes} mins`}
            </p>
          )}
        </div>

        {/* When */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            When
          </h3>
          <button
            type="button"
            onClick={() => setShowTimePicker(true)}
            className="w-full flex items-center gap-3 px-4 py-3.5 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors"
          >
            <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-base text-gray-900 font-medium text-left">
              {scheduledFor ? formatScheduledLabel(scheduledFor) : 'ASAP'}
            </span>
            <svg className="ml-auto w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Delivery Address */}
        {orderType === 'delivery' && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
              Delivery Address
            </h3>
            <div className="space-y-3">
              <input
                ref={inputRef}
                type="text"
                placeholder="Search for your address..."
                onChange={() => {
                  if (deliveryLat) {
                    // M6.5: Clear uber state on address change — prevents fee
                    // flip during the uber-quote async window. Mirrors the
                    // place_changed callback's cleanup so manual edits and
                    // dropdown selections behave identically.
                    setUberQuoteId(null)
                    setUberQuotedFeeCents(null)
                    setUberCustomerFeeCents(null)
                    setResolvedMode(null)
                    setQuoteExpiresAt(null)
                    setDeliveryLat(null)
                    setDeliveryLon(null)
                    setDeliveryDistance(null)
                    setDeliveryFeeCents(null)
                    setDeliveryAddress('')
                    setAddressError(null)
                  }
                }}
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <input
                type="text"
                value={deliveryApt}
                onChange={e => setDeliveryApt(e.target.value)}
                placeholder="Apt/Unit (optional)"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
            </div>
            {quoteLoading && (
              <p className="mt-2 text-sm text-gray-500 italic">Calculating delivery fee...</p>
            )}
            {!quoteLoading && resolvedMode === 'uber_direct' && uberCustomerFeeCents != null && !addressError && (
              <p className="mt-2 text-sm text-gray-600">
                Delivery fee: {formatCurrency(deliveryFee)} (via Uber Direct)
              </p>
            )}
            {!quoteLoading && resolvedMode !== 'uber_direct' && deliveryDistance != null && !addressError && (
              <p className="mt-2 text-sm text-gray-600">
                Distance: {deliveryDistance} mi — Delivery fee: {formatCurrency(deliveryFee)}
              </p>
            )}
            {addressError && (
              <p className="mt-2 text-sm text-red-500">{addressError}</p>
            )}
            {belowMinimum && (
              <p className="mt-2 text-sm text-red-500">
                Minimum order for delivery is {formatCurrency(deliveryMinimum)}. Add more items or select pickup.
              </p>
            )}
            {restaurant.delivery_note && (
              <p className="mt-2 text-sm text-gray-500">{restaurant.delivery_note}</p>
            )}
            <textarea
              value={specialInstructions}
              onChange={e => {
                setSpecialInstructions(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px'
              }}
              placeholder="Delivery Instructions (optional)"
              rows={1}
              maxLength={200}
              className="mt-3 w-full px-4 py-3 bg-gray-100 rounded-xl text-base resize-none focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              style={{ overflow: 'auto' }}
            />
            {specialInstructions.length > 0 && (
              <p className="text-xs text-gray-400 text-right mt-1">{specialInstructions.length}/200</p>
            )}
          </div>
        )}

        {/* Tip */}
        {/* Napkins & Utensils */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Include napkins & utensils</span>
          <button
            onClick={() => setIncludeUtensils(!includeUtensils)}
            className={`relative w-12 h-7 rounded-full transition-colors ${includeUtensils ? 'bg-[#16A34A]' : 'bg-gray-300'}`}
          >
            <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${includeUtensils ? 'left-5.5' : 'left-0.5'}`} />
          </button>
        </div>

        <TipSelector subtotal={discountedSubtotal} orderType={orderType} onTipChange={setTip} />
        {resolvedMode === 'uber_direct' && tip > 5 && (
          <p className="mt-2 text-sm text-gray-500">
            Uber caps delivery driver tips at $5.00. Amounts above that support the restaurant.
          </p>
        )}

        {/* Order Summary */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Order Summary
          </h3>
          <div className="space-y-3">
            {items.map(item => {
              // Show full (undiscounted) prices in the summary
              const fullBase = parseFloat(item.fullBasePrice ?? item.basePrice) || 0
              const toppingsTotal = (item.toppings || []).reduce((s, t) => s + (parseFloat(t.fullPrice ?? t.price) || 0), 0)
              const lineTotal = (fullBase + toppingsTotal) * (item.quantity || 1)

              return (
                <div key={item.id} className="border-b border-gray-100 pb-3">
                  <div className="flex justify-between">
                    <span className="font-semibold text-gray-900">
                      {item.quantity}x {item.itemName}
                      {item.sizeName ? ` (${item.sizeName})` : ''}
                    </span>
                    <span className="font-semibold text-gray-900">
                      {formatCurrency(lineTotal)}
                    </span>
                  </div>
                  {item.toppings?.map((t, i) => (
                    <div key={i} className="flex justify-between text-sm text-gray-500 ml-4 mt-0.5">
                      <span>
                        {t.placementType === 'addon'
                          ? t.toppingName
                          : `${t.placement.toUpperCase()}: ${t.toppingName}`}
                      </span>
                      <span>{Number(t.fullPrice ?? t.price) === 0 ? 'Free' : `+${formatCurrency(t.fullPrice ?? t.price)}${item.quantity > 1 ? ' ea' : ''}`}</span>
                    </div>
                  ))}
                  {item.specialInstructions && (
                    <p className="text-sm text-gray-400 italic ml-4 mt-0.5">
                      {item.specialInstructions}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Totals */}
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>Subtotal</span>
              <span>{formatCurrency(fullSubtotal)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>Tax</span>
              <span>{formatCurrency(taxAmount)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>Service Fee</span>
              <span>{formatCurrency(serviceFee)}</span>
            </div>
            {orderType === 'delivery' && (
              <div className="flex justify-between text-gray-600">
                <span>Delivery Fee{deliveryDistance ? ` (${deliveryDistance} mi)` : ''}</span>
                <span>{showPlaceholder ? '—' : (deliveryFee === 0 ? 'Free' : formatCurrency(deliveryFee))}</span>
              </div>
            )}
            {discountAmount > 0 && (
              <div className="flex justify-between text-[#16A34A] font-medium">
                <span>Discount ({discountPercentage}%)</span>
                <span>-{formatCurrency(discountAmount)}</span>
              </div>
            )}
            {tip > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Tip</span>
                <span>{formatCurrency(tip)}</span>
              </div>
            )}
            <div className="flex justify-between text-lg font-bold text-gray-900 pt-2 border-t border-gray-200">
              <span>Total</span>
              <span>{showPlaceholder ? '—' : formatCurrency(total)}</span>
            </div>
          </div>
        </div>

        {/* Payment */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Payment
          </h3>

          {initError ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm text-red-700 font-medium">Unable to load payment</p>
              <p className="text-sm text-red-600 mt-1">{initError}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-3 text-sm font-semibold text-[#16A34A] hover:underline"
              >
                Try again
              </button>
            </div>
          ) : !clientSecret ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
              <span className="ml-3 text-sm text-gray-500">Loading payment...</span>
            </div>
          ) : (
            <Elements stripe={stripePromise} options={stripeOptions}>
              <PaymentForm
                onSuccess={handlePaymentSuccess}
                total={total}
                customerInfo={customerInfo}
                orderData={{ order_type: orderType, delivery_address: fullDeliveryAddress }}
                slug={slug}
                restaurant={restaurant}
                disabled={belowMinimum}
                onValidateDelivery={onValidateDelivery}
                clientSecret={clientSecret}
                paymentIntentId={paymentIntentId}
                feeCalculating={feeCalculating}
                needsAddress={needsAddress}
                showPlaceholder={showPlaceholder}
                onWalletCustomer={async (name, email, phone) => {
                  // Update customer state for confirmation page
                  setCustomerName(name)
                  setCustomerEmail(email)
                  setCustomerPhone(phone)
                  // Immediately update pending_orders via edge function
                  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
                  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
                  await fetch(`${supabaseUrl}/functions/v1/create-payment-intent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}` },
                    body: JSON.stringify({
                      restaurant_id: restaurant.id,
                      amount: Math.round(total * 100),
                      order_data: { ...buildOrderData(), customer_name: name, customer_email: email, customer_phone: phone },
                      payment_intent_id: paymentIntentId,
                    }),
                  })
                }}
              />
            </Elements>
          )}
        </div>
      </div>

      <TimePickerModal
        open={showTimePicker}
        onClose={() => setShowTimePicker(false)}
        onUpdate={value => setScheduledFor(value)}
        orderType={orderType}
        hours={hours}
        isOpen={isOpen}
        leadTimeMinutes={leadTimeMinutes}
        scheduledFor={scheduledFor}
      />
    </div>
  )
}
