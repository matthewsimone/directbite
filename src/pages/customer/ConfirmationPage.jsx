import { useState, useEffect } from 'react'
import { useParams, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useCart } from '../../hooks/useCart'
import { formatCurrency, formatPhone } from '../../utils/format'
import { formatScheduledLabel } from '../../utils/scheduling'

// Fetch a single order (scoped, non-PII) by Stripe payment intent via the
// get-order-by-pi edge function. Replaces the former direct anon reads of
// orders / order_items / restaurants. Returns the parsed { order, items,
// restaurant } on success, or null when the order isn't found yet (404) or
// on any error — callers treat null as "keep polling".
async function fetchOrderByPi(paymentIntentId) {
  try {
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-order-by-pi`,
      {
        method: 'POST',
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payment_intent_id: paymentIntentId }),
      }
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export default function ConfirmationPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { clearCart } = useCart()

  // Clear cart on mount — payment was successful
  useEffect(() => {
    clearCart()
    setTimeout(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }, 50)
  }, [])
  const { state } = useLocation()
  const [searchParams] = useSearchParams()

  // Check for Stripe redirect params
  const stripePaymentIntentId = searchParams.get('payment_intent')
  const redirectStatus = searchParams.get('redirect_status')
  const isStripeRedirect = stripePaymentIntentId && redirectStatus === 'succeeded'


  // If no state AND no Stripe redirect, show not found
  if (!state && !isStripeRedirect) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">No order found</h1>
        <button
          onClick={() => navigate(`/${slug}`)}
          className="mt-4 px-6 py-3 bg-[#16A34A] text-white rounded-xl font-semibold"
        >
          Back to Menu
        </button>
      </div>
    )
  }

  // If we have router state, use that (SPA navigation after non-redirect payment)
  if (state) {
    return <ConfirmationWithState state={state} slug={slug} navigate={navigate} />
  }

  // Stripe redirect — fetch order from Supabase using payment_intent ID
  return <ConfirmationFromStripe paymentIntentId={stripePaymentIntentId} slug={slug} navigate={navigate} />
}

// ── Confirmation with router state (existing flow) ──
function ConfirmationWithState({ state, slug, navigate }) {
  const {
    orderNumber: initialOrderNumber,
    customerName,
    orderType,
    scheduledFor,
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
    restaurantName,
    restaurantPhone,
    includeUtensils,
    specialInstructions,
    // M8: Uber Direct attribution (Path A — SPA navigation from CheckoutPage)
    deliveryFulfillmentMethod = 'in_house',
    uberEnvironment = null,
  } = state

  const [orderNumber, setOrderNumber] = useState(initialOrderNumber || null)

  useEffect(() => {
    if (orderNumber || !state?.paymentIntentId || !supabase) return

    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      const result = await fetchOrderByPi(state.paymentIntentId)

      if (result?.order?.order_number) {
        setOrderNumber(result.order.order_number)
        clearInterval(interval)
      }

      if (attempts >= 15) clearInterval(interval)
    }, 2000)

    return () => clearInterval(interval)
  }, [orderNumber, state?.paymentIntentId])

  return (
    <ConfirmationLayout
      orderNumber={orderNumber}
      customerName={customerName}
      orderType={orderType}
      scheduledFor={scheduledFor}
      estimatedTime={estimatedTime}
      items={items}
      subtotal={subtotal}
      discountAmount={discountAmount}
      discountPercentage={discountPercentage}
      deliveryFee={deliveryFee}
      taxAmount={taxAmount}
      tip={tip}
      serviceFee={serviceFee}
      total={total}
      restaurantName={restaurantName}
      restaurantPhone={restaurantPhone}
      includeUtensils={includeUtensils}
      specialInstructions={specialInstructions}
      slug={slug}
      navigate={navigate}
      deliveryFulfillmentMethod={deliveryFulfillmentMethod}
      uberEnvironment={uberEnvironment}
      uberStatus={null}
      uberTrackingUrl={null}
      uberCourierInfo={null}
    />
  )
}

// ── Confirmation from Stripe redirect (fetch order from DB) ──
function ConfirmationFromStripe({ paymentIntentId, slug, navigate }) {
  const [order, setOrder] = useState(null)
  const [restaurant, setRestaurant] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return

    let attempts = 0
    const interval = setInterval(async () => {
      attempts++

      const result = await fetchOrderByPi(paymentIntentId)

      if (result?.order) {
        setOrder(result.order)
        clearInterval(interval)

        setRestaurant(result.restaurant)
        setItems(result.items || [])

        setLoading(false)
      }

      if (attempts >= 20) {
        clearInterval(interval)
        setLoading(false)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [paymentIntentId])

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
        <p className="mt-4 text-gray-500">Confirming your order...</p>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Order processing</h1>
        <p className="text-gray-500 mb-4">Your payment was successful. Your order is being prepared.</p>
        <button
          onClick={() => navigate(`/${slug}`)}
          className="px-6 py-3 bg-[#16A34A] text-white rounded-xl font-semibold"
        >
          Back to Menu
        </button>
      </div>
    )
  }

  const estimatedTime = order.order_type === 'pickup'
    ? restaurant?.estimated_pickup_minutes
    : restaurant?.estimated_delivery_minutes

  // Map DB items to display format
  const displayItems = items.map(item => ({
    id: item.id,
    itemName: item.item_name,
    sizeName: item.size_name,
    basePrice: item.base_price,
    quantity: item.quantity,
    discount_exempt: item.discount_exempt === true,
    specialInstructions: item.special_instructions,
    toppings: (item.order_item_toppings || []).map(t => ({
      toppingName: t.topping_name,
      placement: t.placement,
      price: t.price_charged,
      placementType: t.placement_type || 'pizza',
    })),
  }))

  return (
    <ConfirmationLayout
      orderNumber={order.order_number}
      customerName={order.customer_name}
      orderType={order.order_type}
      scheduledFor={order.scheduled_for}
      estimatedTime={estimatedTime}
      items={displayItems}
      subtotal={order.subtotal}
      discountAmount={order.discount_amount}
      discountPercentage={order.discount_percentage}
      deliveryFee={order.delivery_fee}
      taxAmount={order.tax_amount}
      tip={order.tip_amount}
      serviceFee={order.service_fee}
      total={order.total_amount}
      restaurantName={restaurant?.name}
      restaurantPhone={restaurant?.phone}
      includeUtensils={order.include_utensils}
      specialInstructions={order.special_instructions}
      slug={slug}
      navigate={navigate}
      // M8: Uber Direct attribution (Path B — Stripe redirect, fetched from DB)
      deliveryFulfillmentMethod={order.delivery_fulfillment_method || 'in_house'}
      uberEnvironment={order.uber_environment || null}
      uberStatus={order.uber_status || null}
      uberTrackingUrl={order.uber_tracking_url || null}
      uberCourierInfo={order.uber_courier_info || null}
    />
  )
}

// ── Shared confirmation layout ──
function ConfirmationLayout({
  orderNumber, customerName, orderType, scheduledFor, estimatedTime,
  items, subtotal, discountAmount, discountPercentage,
  deliveryFee, taxAmount, tip, serviceFee, total,
  restaurantName, restaurantPhone, includeUtensils, specialInstructions, slug, navigate,
  // M8: Uber Direct attribution (gated below by showUberSection)
  deliveryFulfillmentMethod = 'in_house',
  uberEnvironment = null,
  // M9-future fields — all null in M8. The card JSX below uses truthy
  // gates so each block progressively activates as M9 ships.
  uberStatus = null,
  uberTrackingUrl = null,
  uberCourierInfo = null,
}) {
  const isScheduled = !!scheduledFor
  const scheduledLabel = isScheduled ? formatScheduledLabel(scheduledFor) : null
  const [showUberTooltip, setShowUberTooltip] = useState(false)
  // M8: gate the Uber attribution section. Only renders for delivery
  // orders dispatched via Uber Direct; pickup and in_house never show this.
  const showUberSection =
    orderType === 'delivery' &&
    deliveryFulfillmentMethod === 'uber_direct'
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-lg mx-auto px-5 py-10">
        {/* Green checkmark */}
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 rounded-full bg-[#16A34A] flex items-center justify-center">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        <h1 className="text-3xl font-bold text-gray-900 text-center">
          {isScheduled ? 'Order Scheduled!' : 'Order Confirmed!'}
        </h1>
        <p className="text-lg text-gray-500 text-center mt-2">
          Thank you, {customerName}!
        </p>

        {/* Order meta */}
        <div className="mt-6 bg-gray-50 rounded-2xl p-5 space-y-2 text-center">
          {restaurantName && <p className="text-sm text-gray-500">{restaurantName}</p>}
          <p className="text-2xl font-bold text-gray-900">
            {orderNumber ? `#${orderNumber}` : (
              <span className="flex items-center justify-center gap-2 text-base text-gray-500">
                <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                Confirming...
              </span>
            )}
          </p>
          {isScheduled ? (
            <p className="text-sm text-gray-600">
              Your order will be ready at {scheduledLabel}
            </p>
          ) : estimatedTime && (
            <p className="text-sm text-gray-600">
              {orderType === 'pickup'
                ? `Estimated pickup in ~${estimatedTime} mins`
                : `Estimated delivery in ~${estimatedTime} mins`}
            </p>
          )}
        </div>

        {/* M8: Uber Direct attribution. Only renders for delivery orders
            dispatched via Uber. The "Delivered by Uber Direct" text lives
            in an isolated span (marked SWAP POINT) so a future swap to an
            Uber wordmark image is a one-line change. M9-future fields
            (status pill, tracking URL, courier name) are pre-wired with
            truthy gates — they hide today and progressively appear as M9
            populates the corresponding columns. */}
        {showUberSection && (
          <div className="mt-6 bg-gray-50 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              {/* SWAP POINT: replace this <span> with <img src="/uber-direct-logo.svg" alt="..." /> once brand assets land in M9 */}
              <span className="text-sm font-semibold text-gray-700">
                Delivered by Uber Direct
              </span>
              <button
                type="button"
                onClick={() => setShowUberTooltip(!showUberTooltip)}
                aria-expanded={showUberTooltip}
                aria-label="What is Uber Direct?"
                className="p-2 -m-2 text-gray-400 hover:text-gray-600 transition-colors rounded-full"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </div>

            {showUberTooltip && (
              <p className="text-xs text-gray-600 leading-relaxed">
                Lower cost than UberEats. This restaurant uses Uber's delivery
                network directly without paying marketplace fees.
              </p>
            )}

            {/* M9-future: status pill (color-coded). Hides in M8 (uber_status NULL). */}
            {uberStatus && (
              <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${
                uberStatus === 'delivered' ? 'bg-green-100 text-green-800'
                : uberStatus === 'canceled' || uberStatus === 'failed' ? 'bg-red-100 text-red-800'
                : 'bg-blue-100 text-blue-800'
              }`}>
                {uberStatus.replace(/_/g, ' ')}
              </div>
            )}

            {/* M9-future: tracking link. Hides in M8 (uber_tracking_url NULL). */}
            {uberTrackingUrl && (
              <a
                href={uberTrackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm font-medium text-[#16A34A] hover:underline"
              >
                Track delivery →
              </a>
            )}

            {/* M9-future: courier name. Hides in M8 (uber_courier_info NULL). */}
            {uberCourierInfo?.name && (
              <p className="text-xs text-gray-500">
                Your courier: {uberCourierInfo.name}
              </p>
            )}
          </div>
        )}

        {/* Special Instructions */}
        {specialInstructions && (
          <div className="mt-6 bg-amber-50 border border-amber-300 rounded-xl p-4">
            <p className="text-sm font-semibold text-amber-800 mb-1">Instructions</p>
            <p className="text-base text-amber-900">{specialInstructions}</p>
          </div>
        )}

        {/* Receipt */}
        {items && items.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
              Receipt
            </h2>

            <div className="space-y-3">
              {items.map(item => {
                const fullBase = parseFloat(item.fullBasePrice ?? item.basePrice) || 0
                const toppingsTotal = (item.toppings || []).reduce(
                  (s, t) => s + (parseFloat(t.fullPrice ?? t.price) || 0),
                  0
                )
                const lineTotal = (fullBase + toppingsTotal) * (item.quantity || 1)

                return (
                  <div key={item.id} className="border-b border-gray-100 pb-3">
                    <div className="flex justify-between">
                      <span className="font-bold text-gray-900">
                        {item.quantity}x {item.itemName}
                        {item.sizeName ? ` (${item.sizeName})` : ''}
                      </span>
                      <span className="font-bold text-gray-900">
                        {formatCurrency(lineTotal)}
                      </span>
                    </div>
                    {Number(discountPercentage) > 0 && item.discount_exempt === true && (
                      <div className="text-[11px] text-gray-400 mt-0.5">*already discounted*</div>
                    )}
                    {item.toppings?.map((t, i) => {
                      const tFullPrice = parseFloat(t.fullPrice ?? t.price) || 0
                      return (
                        <div key={i} className="flex justify-between text-sm text-gray-500 ml-4 mt-0.5">
                          <span>
                            {t.placementType === 'addon'
                              ? t.toppingName
                              : `${t.placement.toUpperCase()}: ${t.toppingName}`}
                          </span>
                          <span>{tFullPrice === 0 ? 'Free' : `+${formatCurrency(tFullPrice)}${Number(item.quantity) > 1 ? ' ea' : ''}`}</span>
                        </div>
                      )
                    })}
                    {item.specialInstructions && (
                      <p className="text-sm text-gray-400 italic ml-4 mt-0.5">
                        {item.specialInstructions}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>

            {includeUtensils && (
              <p className="text-sm text-[#16A34A] font-medium mt-3">✓ Include napkins & utensils</p>
            )}

            {/* Totals */}
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-gray-600">
                <span>Subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between text-gray-600">
                <span>Tax</span>
                <span>{formatCurrency(taxAmount)}</span>
              </div>
              <div className="flex justify-between text-gray-600">
                <span>Service Fee</span>
                <span>{formatCurrency(serviceFee)}</span>
              </div>
              {Number(deliveryFee) > 0 && (
                <div className="flex justify-between text-gray-600">
                  <span>Delivery Fee</span>
                  <span>{formatCurrency(deliveryFee)}</span>
                </div>
              )}
              {Number(discountAmount) > 0 && (
                <div className="flex justify-between text-[#16A34A] font-medium">
                  <span>Discount ({discountPercentage}%)</span>
                  <span>-{formatCurrency(discountAmount)}</span>
                </div>
              )}
              {Number(tip) > 0 && (
                <div className="flex justify-between text-gray-600">
                  <span>Tip</span>
                  <span>{formatCurrency(tip)}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold text-gray-900 pt-3 border-t border-gray-200">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Restaurant phone */}
        {restaurantPhone && (
          <div className="mt-8 text-center">
            <p className="text-sm text-gray-500">
              Questions? Call{' '}
              <a
                href={`tel:${restaurantPhone}`}
                className="text-[#16A34A] font-semibold hover:underline"
              >
                {formatPhone(restaurantPhone)}
              </a>
            </p>
          </div>
        )}

        {/* Back to menu */}
        <div className="mt-8 text-center">
          <button
            onClick={() => navigate(`/${slug}`)}
            className="px-8 py-3.5 bg-gray-900 text-white rounded-xl font-semibold active:scale-[0.98] transition-transform"
          >
            Back to Menu
          </button>
        </div>
      </div>
    </div>
  )
}
