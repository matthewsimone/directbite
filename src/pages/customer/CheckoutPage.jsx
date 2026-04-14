import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { loadStripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import toast from 'react-hot-toast'
import { useRestaurant } from '../../hooks/useRestaurant'
import { usePromotion } from '../../hooks/usePromotion'
import { useCart } from '../../hooks/useCart'
import { formatCurrency } from '../../utils/format'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '')

// ---------- Tip Selector ----------
function TipSelector({ subtotal, onTipChange }) {
  const [tipType, setTipType] = useState(null)
  const [customTip, setCustomTip] = useState('')

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
      <div className="flex gap-2 flex-wrap">
        {presets.map(pct => (
          <button
            key={pct}
            onClick={() => selectPreset(pct)}
            className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors min-w-[60px] ${
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
          className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
            tipType === 'custom'
              ? 'bg-[#16A34A] text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Custom
        </button>
        <button
          onClick={selectNone}
          className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
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
            className="w-full pl-8 pr-4 py-3 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
          />
        </div>
      )}
    </div>
  )
}

// ---------- Payment Form (inside Stripe Elements) ----------
function PaymentForm({ onSuccess, total, customerInfo, orderData, slug, restaurant }) {
  const stripe = useStripe()
  const elements = useElements()
  const [loading, setLoading] = useState(false)
  const [paymentType, setPaymentType] = useState(null) // 'card', 'apple_pay', 'google_pay', etc.

  function handlePaymentElementChange(event) {
    if (event.value?.type) {
      setPaymentType(event.value.type)
    }
  }

  const isWalletPayment = paymentType === 'apple_pay' || paymentType === 'google_pay' || paymentType === 'link'

  async function handleSubmit(e) {
    e.preventDefault()
    if (!stripe || !elements) return

    // Validate contact fields for card payments
    if (!isWalletPayment) {
      if (!customerInfo.name.trim() || !customerInfo.phone.trim() || !customerInfo.email.trim()) {
        toast.error('Please fill in all contact fields')
        return
      }
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

    // Payment succeeded without redirect
    if (paymentIntent && paymentIntent.status === 'succeeded') {
      onSuccess(paymentIntent.id)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement
        onChange={handlePaymentElementChange}
        options={{
          layout: 'tabs',
          wallets: { applePay: 'auto', googlePay: 'auto' },
          fields: {
            billingDetails: {
              name: isWalletPayment ? 'auto' : 'never',
              email: isWalletPayment ? 'auto' : 'never',
              phone: isWalletPayment ? 'auto' : 'never',
            },
          },
        }}
      />

      {/* Contact fields shown only for card payments */}
      {!isWalletPayment && (
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
              className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
            />
            <input
              type="tel"
              value={customerInfo.phone}
              onChange={e => customerInfo.setPhone(e.target.value)}
              placeholder="Phone Number"
              className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
            />
            <input
              type="email"
              value={customerInfo.email}
              onChange={e => customerInfo.setEmail(e.target.value)}
              placeholder="Email Address"
              className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
            />
          </div>
        </div>
      )}

      {/* Floating payment bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 px-5 py-4">
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-3">
            <span className="text-2xl font-bold text-gray-900">{formatCurrency(total)}</span>
          </div>
          <button
            type="submit"
            disabled={!stripe || loading}
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
  const [tip, setTip] = useState(0)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryApt, setDeliveryApt] = useState('')
  const [deliveryCity, setDeliveryCity] = useState('')
  const [deliveryZip, setDeliveryZip] = useState('')
  const [clientSecret, setClientSecret] = useState(null)
  const [paymentIntentId, setPaymentIntentId] = useState(null)
  const [initError, setInitError] = useState(null)

  const discountPercentage = promotion ? Number(promotion.discount_percentage) : 0
  const discountAmount = Math.round(subtotal * (discountPercentage / 100) * 100) / 100
  const discountedSubtotal = subtotal - discountAmount
  const deliveryFee = orderType === 'delivery' ? Number(restaurant?.delivery_fee || 0) : 0
  const taxRate = Number(restaurant?.tax_rate || 0)
  const taxAmount = Math.round(discountedSubtotal * taxRate * 100) / 100
  const serviceFee = 1.50
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
    subtotal,
    discount_amount: discountAmount,
    discount_percentage: discountPercentage,
    delivery_fee: deliveryFee,
    tax_amount: taxAmount,
    tip_amount: tip,
    service_fee: serviceFee,
    total_amount: total,
    items: items.map(item => ({
      menu_item_id: item.menuItemId,
      item_size_id: item.itemSizeId || null,
      item_name: item.itemName,
      size_name: item.sizeName || null,
      base_price: item.basePrice,
      quantity: item.quantity,
      special_instructions: item.specialInstructions || null,
      toppings: (item.toppings || []).map(t => ({
        topping_id: t.toppingId,
        topping_name: t.toppingName,
        placement: t.placement,
        price_charged: t.price,
        placement_type: t.placementType || 'pizza',
      })),
    })),
  }), [restaurant?.id, orderType, customerName, customerPhone, customerEmail, fullDeliveryAddress, subtotal, discountAmount, discountPercentage, deliveryFee, taxAmount, tip, serviceFee, total, items])

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
    // Order will be written by the webhook, but we navigate immediately for good UX
    clearCart()
    navigate(`/${slug}/confirmation`, {
      state: {
        orderNumber: null, // Will show "Processing..." until webhook writes it
        customerName: customerName.trim(),
        orderType,
        estimatedTime,
        items,
        subtotal,
        discountAmount,
        discountPercentage,
        deliveryFee,
        taxAmount,
        tip,
        serviceFee,
        total,
        restaurantName: restaurant.name,
        restaurantPhone: restaurant.phone,
        paymentIntentId: piId,
      },
    })
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
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <input
                type="text"
                value={deliveryApt}
                onChange={e => setDeliveryApt(e.target.value)}
                placeholder="Apt/Unit (optional)"
                className="w-full px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
              />
              <div className="flex gap-3">
                <input
                  type="text"
                  value={deliveryCity}
                  onChange={e => setDeliveryCity(e.target.value)}
                  placeholder="City"
                  className="flex-1 px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
                />
                <input
                  type="text"
                  value={deliveryZip}
                  onChange={e => setDeliveryZip(e.target.value)}
                  placeholder="Zip"
                  className="w-28 px-4 py-3.5 bg-gray-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40"
                />
              </div>
            </div>
            {restaurant.delivery_note && (
              <p className="mt-2 text-sm text-gray-500">{restaurant.delivery_note}</p>
            )}
          </div>
        )}

        {/* Tip */}
        <TipSelector subtotal={discountedSubtotal} onTipChange={setTip} />

        {/* Order Summary */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Order Summary
          </h3>
          <div className="space-y-3">
            {items.map(item => {
              const toppingsTotal = (item.toppings || []).reduce((s, t) => s + Number(t.price), 0)
              const lineTotal = (Number(item.basePrice) + toppingsTotal) * item.quantity

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
                      <span>{Number(t.price) === 0 ? 'Free' : `+${formatCurrency(t.price)}`}</span>
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
              <span>{formatCurrency(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-[#16A34A] font-medium">
                <span>Discount ({discountPercentage}%)</span>
                <span>-{formatCurrency(discountAmount)}</span>
              </div>
            )}
            {deliveryFee > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Delivery Fee</span>
                <span>{formatCurrency(deliveryFee)}</span>
              </div>
            )}
            <div className="flex justify-between text-gray-600">
              <span>Tax</span>
              <span>{formatCurrency(taxAmount)}</span>
            </div>
            {tip > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Tip</span>
                <span>{formatCurrency(tip)}</span>
              </div>
            )}
            <div className="flex justify-between text-gray-600">
              <span>Service Fee</span>
              <span>{formatCurrency(serviceFee)}</span>
            </div>
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
              />
            </Elements>
          )}
        </div>
      </div>
    </div>
  )
}
