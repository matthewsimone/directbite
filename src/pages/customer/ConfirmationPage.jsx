import { useState, useEffect } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { formatCurrency, formatPhone } from '../../utils/format'

export default function ConfirmationPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { state } = useLocation()

  // If no state (direct navigation), send back to menu
  if (!state) {
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

  const {
    orderNumber: initialOrderNumber,
    customerName,
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
    restaurantName,
    restaurantPhone,
  } = state

  const [orderNumber, setOrderNumber] = useState(initialOrderNumber || null)

  // Poll for order number if it wasn't available immediately (webhook may be delayed)
  useEffect(() => {
    if (orderNumber || !state?.paymentIntentId || !supabase) return

    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      const { data } = await supabase
        .from('orders')
        .select('order_number')
        .eq('stripe_payment_intent_id', state.paymentIntentId)
        .single()

      if (data?.order_number) {
        setOrderNumber(data.order_number)
        clearInterval(interval)
      }

      if (attempts >= 15) clearInterval(interval) // stop after ~30s
    }, 2000)

    return () => clearInterval(interval)
  }, [orderNumber, state?.paymentIntentId])

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

        <h1 className="text-3xl font-bold text-gray-900 text-center">Order Confirmed!</h1>
        <p className="text-lg text-gray-500 text-center mt-2">
          Thank you, {customerName}!
        </p>

        {/* Order meta */}
        <div className="mt-6 bg-gray-50 rounded-2xl p-5 space-y-2 text-center">
          <p className="text-sm text-gray-500">{restaurantName}</p>
          <p className="text-2xl font-bold text-gray-900">
            {orderNumber ? `#${orderNumber}` : (
              <span className="flex items-center justify-center gap-2 text-base text-gray-500">
                <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                Confirming...
              </span>
            )}
          </p>
          <p className="text-sm text-gray-600">
            {orderType === 'pickup'
              ? `Estimated pickup in ~${estimatedTime} mins`
              : `Estimated delivery in ~${estimatedTime} mins`}
          </p>
        </div>

        {/* Receipt */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
            Receipt
          </h2>

          <div className="space-y-3">
            {items.map(item => {
              const toppingsTotal = (item.toppings || []).reduce(
                (s, t) => s + Number(t.price),
                0
              )
              const lineTotal = (Number(item.basePrice) + toppingsTotal) * item.quantity

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
                  {item.toppings?.map((t, i) => (
                    <div key={i} className="flex justify-between text-sm text-gray-500 ml-4 mt-0.5">
                      <span>
                        {t.placement.toUpperCase()}: {t.toppingName}
                      </span>
                      <span>+{formatCurrency(t.price)}</span>
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
            <div className="flex justify-between text-lg font-bold text-gray-900 pt-3 border-t border-gray-200">
              <span>Total</span>
              <span>{formatCurrency(total)}</span>
            </div>
          </div>
        </div>

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
