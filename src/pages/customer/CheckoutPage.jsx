import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { loadStripe } from '@stripe/stripe-js'
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
import applePayLogo from '../../assets/payment-marks/apple-pay.svg'
import googlePayLogo from '../../assets/payment-marks/google-pay.svg'

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''

// ---------- Tip Selector ----------
function TipSelector({ subtotal, onTipChange }) {
  const [tipType, setTipType] = useState('10')
  const [customTip, setCustomTip] = useState('')

  // Set default 10% tip on mount
  useEffect(() => {
    if (subtotal > 0) {
      onTipChange(Math.round(subtotal * 0.1 * 100) / 100)
    }
  }, [])

  function selectPreset(pct) {
    setTipType(pct)
    setCustomTip('')
    onTipChange(Math.round(subtotal * (Number(pct) / 100) * 100) / 100)
  }

  function selectCustom() {
    setTipType('custom')
    onTipChange(Number(customTip) || 0)
  }

  function selectNone() {
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
function PaymentForm({ onSuccess, total, customerInfo, orderData, slug, restaurant, disabled: externalDisabled, clientSecret, paymentIntentId, onWalletCustomer }) {
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
  useEffect(() => { clientSecretRef.current = clientSecret }, [clientSecret])
  useEffect(() => { onSuccessRef.current = onSuccess }, [onSuccess])
  useEffect(() => { onWalletCustomerRef.current = onWalletCustomer }, [onWalletCustomer])
  useEffect(() => { paymentIntentIdRef.current = paymentIntentId }, [paymentIntentId])

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
      if (submittedRef.current) { ev.complete('fail'); return }
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

    if (orderData.order_type === 'delivery') {
      if (!orderData.delivery_address) {
        toast.error('Please fill in delivery address')
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
            <span className="text-2xl font-bold text-gray-900">{formatCurrency(total)}</span>
          </div>

          {payMethod === 'wallet' && paymentRequest ? (
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
          ) : (
            <button
              type="submit"
              disabled={!stripe || loading || externalDisabled}
              className="w-full bg-[#16A34A] text-white font-bold text-lg py-4 rounded-xl disabled:opacity-50 active:scale-[0.98] transition-transform"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Processing...
                </span>
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
  const { restaurant, loading: restLoading } = useRestaurant(slug)
  const { promotion } = usePromotion(restaurant?.id)
  const { items, subtotal, clearCart } = useCart()

  const [orderType, setOrderType] = useState('pickup')
  const [includeUtensils, setIncludeUtensils] = useState(false)
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [tip, setTip] = useState(0)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryApt, setDeliveryApt] = useState('')
  const [deliveryCity, setDeliveryCity] = useState('')
  const [deliveryZip, setDeliveryZip] = useState('')
  const [validZips, setValidZips] = useState(null) // null = not loaded, [] = no restrictions
  const [zipInvalid, setZipInvalid] = useState(false)
  const deliveryMinimum = Number(restaurant?.delivery_minimum || 0)
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
  const deliveryFeeType = restaurant?.delivery_fee_type || 'flat'
  const deliveryFeeRaw = Number(restaurant?.delivery_fee || 0)
  const deliveryFee = orderType === 'delivery'
    ? deliveryFeeType === 'percentage'
      ? Math.round(discountedSubtotal * (deliveryFeeRaw / 100) * 100) / 100
      : deliveryFeeType === 'none' ? 0 : deliveryFeeRaw
    : 0
  const taxRate = Number(restaurant?.tax_rate || 0)
  const serviceFee = 1.50
  const taxableAmount = discountedSubtotal + deliveryFee + serviceFee
  const taxAmount = Math.round(taxableAmount * taxRate * 100) / 100
  const total = Math.round((discountedSubtotal + deliveryFee + taxAmount + tip + serviceFee) * 100) / 100

  const estimatedTime =
    orderType === 'pickup'
      ? restaurant?.estimated_pickup_minutes
      : restaurant?.estimated_delivery_minutes

  // Build full delivery address string
  const fullDeliveryAddress = orderType === 'delivery' && deliveryAddress.trim()
    ? `${deliveryAddress.trim()}${deliveryApt.trim() ? `, ${deliveryApt.trim()}` : ''}, ${deliveryCity.trim()}, ${deliveryZip.trim()}`
    : null

  // Build order_data to pass to edge function (and ultimately to webhook)
  const buildOrderData = useCallback(() => ({
    restaurant_id: restaurant?.id,
    order_type: orderType,
    customer_name: customerName.trim(),
    customer_phone: customerPhone.trim(),
    customer_email: customerEmail.trim(),
    delivery_address: fullDeliveryAddress,
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
  }), [restaurant?.id, orderType, customerName, customerPhone, customerEmail, fullDeliveryAddress, subtotal, discountAmount, discountPercentage, deliveryFee, taxAmount, tip, serviceFee, total, includeUtensils, specialInstructions, items])

  // Fetch valid delivery zip codes
  useEffect(() => {
    if (!restaurant?.id || !supabase) return
    supabase
      .from('delivery_zip_codes')
      .select('zip_code')
      .eq('restaurant_id', restaurant.id)
      .then(({ data }) => {
        setValidZips((data || []).map(d => d.zip_code))
      })
  }, [restaurant?.id])

  // Validate zip code when it changes
  useEffect(() => {
    if (!validZips || validZips.length === 0 || orderType !== 'delivery') {
      setZipInvalid(false)
      return
    }
    const zip = deliveryZip.trim()
    if (zip.length === 5) {
      setZipInvalid(!validZips.includes(zip))
    } else {
      setZipInvalid(false)
    }
  }, [deliveryZip, validZips, orderType])

  // Redirect to menu if cart is empty
  useEffect(() => {
    if (!restLoading && items.length === 0) {
      navigate(`/${slug}`, { replace: true })
    }
  }, [items.length, restLoading, navigate, slug])

  // Create payment intent on page load (once restaurant is ready)
  const intentCreated = useRef(false)
  useEffect(() => {
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
    if (!paymentIntentId || !restaurant) return

    // Debounce updates
    clearTimeout(updateTimer.current)
    updateTimer.current = setTimeout(async () => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

        await fetch(
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
      },
    })
    // Cart is cleared on the confirmation page, not here — clearing here triggers
    // the empty-cart useEffect which redirects back to menu before navigation completes
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
              onClick={() => { setOrderType('pickup'); setSpecialInstructions('') }}
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
          <p className="mt-2 text-sm text-gray-500">
            {orderType === 'pickup'
              ? `Ready in approximately ${restaurant.estimated_pickup_minutes} mins`
              : `Delivery in approximately ${restaurant.estimated_delivery_minutes} mins`}
          </p>
        </div>

        {/* Delivery Address */}
        {orderType === 'delivery' && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
              Delivery Address
            </h3>
            <div className="space-y-3">
              <input
                type="text"
                value={deliveryAddress}
                onChange={e => setDeliveryAddress(e.target.value)}
                placeholder="Street Address"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <input
                type="text"
                value={deliveryApt}
                onChange={e => setDeliveryApt(e.target.value)}
                placeholder="Apt/Unit (optional)"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <div className="flex gap-3">
                <input
                  type="text"
                  value={deliveryCity}
                  onChange={e => setDeliveryCity(e.target.value)}
                  placeholder="City"
                  className="flex-1 px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
                />
                <input
                  type="text"
                  value={deliveryZip}
                  onChange={e => setDeliveryZip(e.target.value)}
                  placeholder="Zip"
                  className="w-28 px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
                />
              </div>
            </div>
            {zipInvalid && (
              <p className="mt-2 text-sm text-red-500">
                Sorry, we don't deliver to this zip code. Please select pickup or enter a different address.
              </p>
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

        <TipSelector subtotal={discountedSubtotal} onTipChange={setTip} />

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
                <span>Delivery Fee{deliveryFeeType === 'percentage' ? ` (${deliveryFeeRaw}%)` : ''}</span>
                <span>{deliveryFee === 0 ? 'Free' : formatCurrency(deliveryFee)}</span>
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
              <span>{formatCurrency(total)}</span>
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
                disabled={zipInvalid || belowMinimum}
                clientSecret={clientSecret}
                paymentIntentId={paymentIntentId}
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
    </div>
  )
}
