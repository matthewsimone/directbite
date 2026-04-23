import { useState, useEffect, useCallback, useRef } from 'react'
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

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '')

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

// ---------- Payment Form (inside Stripe Elements) ----------
function PaymentForm({ onSuccess, total, customerInfo, orderData, slug, restaurant, disabled: externalDisabled, clientSecret }) {
  const stripe = useStripe()
  const elements = useElements()
  const [loading, setLoading] = useState(false)

  // Wallet detection via PaymentRequest API
  const [paymentRequest, setPaymentRequest] = useState(null)
  const [walletType, setWalletType] = useState(null) // 'applePay' | 'googlePay' | null
  const [payMethod, setPayMethod] = useState('card') // 'wallet' | 'card'

  useEffect(() => {
    if (!stripe || !total) return

    const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''
    console.log('[PaymentRequest] Stripe loaded, key prefix:', pk.slice(0, 8) + '...')

    const pr = stripe.paymentRequest({
      country: 'US',
      currency: 'usd',
      total: { label: 'DirectBite Order', amount: Math.round(total * 100) },
      requestPayerName: true,
      requestPayerEmail: true,
      requestPayerPhone: true,
    })

    console.log('[PaymentRequest] Created:', pr)

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
    }).catch(err => {
      console.error('[PaymentRequest] canMakePayment error:', err)
    })

    // Handle wallet payment confirmation
    pr.on('paymentmethod', async (ev) => {
      const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
        clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      )

      if (confirmError) {
        ev.complete('fail')
        toast.error(confirmError.message || 'Payment failed')
      } else {
        ev.complete('success')
        if (paymentIntent.status === 'requires_action') {
          const { error } = await stripe.confirmCardPayment(clientSecret)
          if (error) {
            toast.error(error.message || 'Payment failed')
          } else {
            onSuccess(paymentIntent.id)
          }
        } else {
          onSuccess(paymentIntent.id)
        }
      }
    })
  }, [stripe, total, clientSecret])

  // Update payment request amount when total changes
  useEffect(() => {
    if (paymentRequest && total) {
      paymentRequest.update({
        total: { label: 'DirectBite Order', amount: Math.round(total * 100) },
      })
    }
  }, [paymentRequest, total])

  // Card payment submit
  async function handleSubmit(e) {
    e.preventDefault()
    if (!stripe || !elements || payMethod === 'wallet') return

    if (!customerInfo.name.trim() || !customerInfo.phone.trim() || !customerInfo.email.trim()) {
      toast.error('Please fill in all contact fields')
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
      toast.error(error.message || 'Payment failed')
      setLoading(false)
      return
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      onSuccess(paymentIntent.id)
    }
  }

  const walletLabel = walletType === 'applePay' ? 'Apple Pay' : 'Google Pay'

  return (
    <form onSubmit={handleSubmit}>
      {/* Payment method selection */}
      {paymentRequest && (
        <div className="space-y-3 mb-5">
          {/* Wallet option */}
          <label
            className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
              payMethod === 'wallet' ? 'border-[#16A34A] bg-green-50/50' : 'border-gray-200'
            }`}
          >
            <input
              type="radio"
              name="payMethod"
              checked={payMethod === 'wallet'}
              onChange={() => setPayMethod('wallet')}
              className="accent-[#16A34A] w-4 h-4"
            />
            <div className="flex items-center gap-2">
              {walletType === 'applePay' ? (
                <svg className="h-5" viewBox="0 0 50 20" fill="currentColor"><path d="M9.6 4.1c-.6.7-1.5 1.3-2.4 1.2-.1-1 .4-2 .9-2.6C8.7 2 9.7 1.4 10.5 1.4c.1 1-.3 2-.9 2.7zm.9 1.4c-1.3-.1-2.5.8-3.1.8-.7 0-1.7-.7-2.8-.7-1.4 0-2.8.8-3.5 2.1-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.1 1.1 0 1.5-.7 2.8-.7 1.3 0 1.6.7 2.8.7 1.2 0 2-1 2.7-2.1.9-1.2 1.2-2.4 1.2-2.5-.1 0-2.4-.9-2.4-3.6 0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7l-.2.4z"/><path d="M21.6 2.3c3.2 0 5.4 2.2 5.4 5.4 0 3.2-2.3 5.4-5.5 5.4h-3.5v5.6h-2.5V2.3h6.1zm-3.6 8.7h2.9c2.2 0 3.5-1.2 3.5-3.3 0-2.1-1.3-3.3-3.5-3.3h-2.9v6.6zm10.2 3c0-2.1 1.6-3.4 4.5-3.5l3.3-.2v-.9c0-1.3-.9-2.1-2.4-2.1-1.4 0-2.3.7-2.5 1.7h-2.3c.1-2.2 2-3.8 4.9-3.8 2.9 0 4.7 1.5 4.7 3.9v8.2h-2.3v-2h-.1c-.7 1.3-2.1 2.2-3.7 2.2-2.3 0-4.1-1.4-4.1-3.5zm7.8-1.1v-.9l-3 .2c-1.5.1-2.3.7-2.3 1.7 0 1 .9 1.7 2.2 1.7 1.7 0 3.1-1.2 3.1-2.7zm4.4 7.6v-1.9c.2 0 .6.1.8.1 1.1 0 1.8-.5 2.1-1.7l.2-.7-4.5-12.5h2.6l3.1 10.2h.1l3.1-10.2H50l-4.7 13.1c-1.1 3-2.3 4-4.8 4-.2 0-.7 0-.9-.1v-.3z"/></svg>
              ) : (
                <svg className="h-5" viewBox="0 0 50 20" fill="currentColor"><path d="M23.7 10.3V15h-1.6V4.4h4.3c1 0 1.9.3 2.6.9.7.6 1.1 1.4 1.1 2.4s-.4 1.8-1.1 2.4c-.7.6-1.6.9-2.6.9h-2.7v-.7zm0-4.5v3.2h2.7c.6 0 1.1-.2 1.5-.6.4-.4.6-.9.6-1.5 0-.5-.2-1-.6-1.4-.4-.4-.9-.6-1.5-.6l-2.7-.1v1zM33.5 7.5c1.2 0 2.1.3 2.8 1 .7.7 1 1.6 1 2.7V15h-1.5v-1h-.1c-.6 1-1.5 1.4-2.6 1.4-.9 0-1.7-.3-2.3-.8-.6-.5-.9-1.2-.9-2 0-.8.3-1.5.9-2 .6-.5 1.5-.7 2.5-.7.9 0 1.6.2 2.1.5v-.4c0-.6-.2-1-.7-1.4-.4-.4-1-.6-1.5-.6-.9 0-1.6.4-2.1 1.1l-1.4-.9c.8-1.1 1.9-1.6 3.4-1.6l.4-.1zm-2 5.7c0 .4.2.8.5 1.1.4.3.8.4 1.2.4.7 0 1.3-.3 1.8-.8.5-.5.8-1.1.8-1.8-.4-.4-1.1-.6-1.9-.6-.6 0-1.1.2-1.5.4-.6.3-.9.7-.9 1.3zm10.5-5.3l-4.4 10.1h-1.6l1.6-3.5-2.8-6.6h1.7l1.9 4.7 1.8-4.7h1.8z"/><path d="M12.4 10.3c0-.5 0-.9-.1-1.4H6.3v2.6h3.4c-.1.9-.6 1.6-1.2 2.1v1.7h2c1.2-1.1 1.9-2.7 1.9-5zM6.3 15.6c1.6 0 3-.5 4-1.4l-2-1.5c-.5.4-1.2.6-2 .6-1.5 0-2.8-1-3.3-2.5H1.1V13c1 2 3 3.3 5.2 3.3v-.7zM3 11.2c-.1-.4-.2-.8-.2-1.2s.1-.8.2-1.2V7.1H1.1C.7 7.9.5 8.8.5 9.8s.2 1.9.6 2.8L3 11.2zM6.3 5.7c.9 0 1.6.3 2.2.9l1.7-1.6c-1-.9-2.3-1.5-3.9-1.5-2.2 0-4.2 1.3-5.2 3.2l1.9 1.5c.5-1.5 1.8-2.5 3.3-2.5z" fill="#4285F4"/></svg>
              )}
              <span className="font-medium text-gray-900">{walletLabel}</span>
            </div>
          </label>

          {/* Card option */}
          <label
            className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
              payMethod === 'card' ? 'border-[#16A34A] bg-green-50/50' : 'border-gray-200'
            }`}
          >
            <input
              type="radio"
              name="payMethod"
              checked={payMethod === 'card'}
              onChange={() => setPayMethod('card')}
              className="accent-[#16A34A] w-4 h-4"
            />
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              <span className="font-medium text-gray-900">Credit Card</span>
            </div>
          </label>
        </div>
      )}

      {/* Card form — shown when card is selected */}
      {payMethod === 'card' && (
        <>
          <PaymentElement
            options={{
              layout: 'tabs',
              wallets: { applePay: 'never', googlePay: 'never' },
              paymentMethodOrder: ['card'],
              fields: {
                billingDetails: { name: 'never', email: 'never', phone: 'never' },
              },
            }}
          />

          {/* Contact fields */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
              Contact Information
            </h3>
            <div className="space-y-3">
              <input
                type="text"
                value={customerInfo.name}
                onChange={e => customerInfo.setName(e.target.value)}
                placeholder="Full Name"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <input
                type="tel"
                value={customerInfo.phone}
                onChange={e => customerInfo.setPhone(e.target.value)}
                placeholder="Phone Number"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <input
                type="email"
                value={customerInfo.email}
                onChange={e => customerInfo.setEmail(e.target.value)}
                placeholder="Email Address"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
            </div>
          </div>
        </>
      )}

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
  const [initError, setInitError] = useState(null)

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
  }), [restaurant?.id, orderType, customerName, customerPhone, customerEmail, fullDeliveryAddress, subtotal, discountAmount, discountPercentage, deliveryFee, taxAmount, tip, serviceFee, total, items])

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
  }, [paymentIntentId, orderType, tip, customerName, customerPhone, customerEmail, fullDeliveryAddress, restaurant, total, buildOrderData])

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
        paymentIntentId: piId,
      },
    })
    // Cart is cleared on the confirmation page, not here — clearing here triggers
    // the empty-cart useEffect which redirects back to menu before navigation completes
  }

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
              onClick={() => setOrderType('pickup')}
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
              />
            </Elements>
          )}
        </div>
      </div>
    </div>
  )
}
