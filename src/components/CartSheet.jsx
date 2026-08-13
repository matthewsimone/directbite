import { useState, useEffect } from 'react'
import { formatCurrency } from '../utils/format'
import { calculateLoyaltyPoints, pointsLabel } from '../utils/loyaltyPoints'
import { useCart } from '../hooks/useCart'
// Safe to call here: CartSheet mounts only inside MenuPage, which routes at
// /:slug under CustomerAuthProvider. It never renders on a custom domain.
import { useCustomerAuth } from '../hooks/useCustomerAuth'

// Copied verbatim from src/components/RewardsView.jsx — keep the two in sync.
function withAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

export default function CartSheet({ onClose, onCheckout, promotion, restaurant }) {
  const { items, removeItem, updateQuantity } = useCart()
  const { cancelRedemption } = useCustomerAuth()
  // The restaurant row is selected with '*', so the slug the cancel call needs
  // is already here — no new prop for every caller to thread through.
  const slug = restaurant?.slug || null
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 300)
  }

  function handleCheckout() {
    setVisible(false)
    setTimeout(onCheckout, 300)
  }

  // Mirrors the per-line total computed in the items.map below.
  const cartSubtotal = items.reduce((sum, item) => {
    const toppingsTotal = (item.toppings || []).reduce((t, top) => t + (parseFloat(top.price) || 0), 0)
    return sum + ((parseFloat(item.basePrice) || 0) + toppingsTotal) * (item.quantity || 1)
  }, 0)

  // The reward's floor is measured pre-promotion, matching
  // create-payment-intent's check against order_data.subtotal. cartSubtotal
  // above is post-promotion and would overstate the gap.
  const fullSubtotal = items.reduce((sum, item) => {
    const toppingsTotal = (item.toppings || []).reduce((t, top) => t + (parseFloat(top.fullPrice ?? top.price) || 0), 0)
    return sum + ((parseFloat(item.fullBasePrice ?? item.basePrice) || 0) + toppingsTotal) * (item.quantity || 1)
  }, 0)

  const loyaltyRewardItem = items.find(i => i.loyaltyRedemptionId && i.loyaltyRewardKind === 'discount')
  const loyaltyMinCents = loyaltyRewardItem ? Number(loyaltyRewardItem.loyaltyMinSubtotalCents || 0) : 0
  const loyaltyShortfall = loyaltyMinCents > 0
    ? Math.max(0, Math.round((loyaltyMinCents / 100 - fullSubtotal) * 100) / 100)
    : 0

  // The cart only knows the food subtotal, so this previews the base earn on
  // that figure. Tax, fees and tip are not yet known, and the tier multiplier
  // is not applied — a customer at a higher tier earns MORE than shown, which
  // is the safe direction to be wrong.
  const loyaltyPoints = calculateLoyaltyPoints({ restaurant, subtotal: cartSubtotal })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={handleClose}>
      <div
        className={`absolute inset-0 bg-black transition-opacity duration-300 ${
          visible ? 'opacity-50' : 'opacity-0'
        }`}
      />

      <div
        onClick={e => e.stopPropagation()}
        className={`relative w-full max-w-lg bg-white rounded-t-2xl max-h-[85vh] flex flex-col transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-300 rounded-full" />
        </div>

        <div className="px-5 pt-2 pb-3 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">Your Order</h2>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4">
          {items.length === 0 ? (
            <p className="text-center text-gray-400 py-8">Your cart is empty</p>
          ) : (
            <div className="space-y-4">
              {items.map(item => {
                const toppingsTotal = (item.toppings || []).reduce(
                  (sum, t) => sum + (parseFloat(t.price) || 0),
                  0
                )
                const lineTotal = ((parseFloat(item.basePrice) || 0) + toppingsTotal) * (item.quantity || 1)

                return (
                  <div key={item.id} className="border-b border-gray-100 pb-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <span className="font-semibold text-gray-900">
                          {item.quantity}x {item.itemName}{item.sizeName ? ` (${item.sizeName})` : ''}
                        </span>

                        {/* A reward line is paid for with points, so it has to
                            announce itself — a $0.00 line with no explanation
                            reads as a pricing bug. */}
                        {item.loyaltyRedemptionId && (
                          <div className="text-[11px] font-semibold text-[#16A34A] mt-0.5">
                            ** LOYALTY REWARD — {item.loyaltyPointsSpent} PTS **
                          </div>
                        )}

                        {promotion && item.discount_exempt === true && (
                          <div className="text-[11px] text-gray-400">*already discounted*</div>
                        )}

                        {/* Toppings */}
                        {item.toppings?.map((t, i) => (
                          <div key={i} className="text-sm text-gray-500 ml-3 mt-0.5">
                            {t.placementType === 'addon'
                              ? t.toppingName
                              : `${t.placement.toUpperCase()}: ${t.toppingName}`}{' '}
                            <span className="text-gray-400">{Number(t.price) === 0 ? 'Free' : `+${formatCurrency(t.price)}${item.quantity > 1 ? ' ea' : ''}`}</span>
                          </div>
                        ))}

                        {/* Special instructions */}
                        {item.specialInstructions && (
                          <p className="text-sm text-gray-400 italic mt-1 ml-3">
                            {item.specialInstructions}
                          </p>
                        )}
                      </div>

                      <span className="font-semibold text-gray-900 ml-4">
                        {formatCurrency(lineTotal)}
                      </span>
                    </div>

                    {/* Quantity controls. A reward line is one redemption, so
                        it gets a remove control only — incrementing it would
                        imply a second reward the customer has not paid points
                        for. */}
                    {item.loyaltyRedemptionId ? (
                      <div className="flex items-center gap-3 mt-2">
                        <button
                          onClick={async () => {
                            // Remove the line first so the cart responds immediately; the points
                            // return on the server's own timing. If the cancel fails the expiry
                            // sweep reclaims them within the TTL, so a failure here costs the
                            // customer nothing.
                            const redemptionId = item.loyaltyRedemptionId
                            updateQuantity(item.id, 0)
                            if (redemptionId && slug) {
                              await cancelRedemption(slug, redemptionId)
                            }
                          }}
                          className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center text-gray-500 hover:border-gray-400"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity - 1)}
                        className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center text-gray-500 hover:border-gray-400"
                      >
                        {item.quantity === 1 ? (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                          </svg>
                        )}
                      </button>
                      <span className="font-medium text-gray-900 w-5 text-center">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        className="w-8 h-8 rounded-full border border-[#16A34A] text-[#16A34A] flex items-center justify-center hover:bg-green-50"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                    </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {loyaltyShortfall > 0 && (
          <div className="px-5 py-2.5 text-center bg-amber-50">
            <p className="text-sm text-amber-700">
              Add {formatCurrency(loyaltyShortfall)} more to use your reward
            </p>
          </div>
        )}

        {/* The ordering flow is platform green throughout, so this does NOT
            use the restaurant's brand colour — a red band on a green page
            reads as inconsistent. If the flow is ever rebranded per
            restaurant, this becomes brandColor along with everything else. */}
        {loyaltyPoints > 0 && (
          <div className="px-5 py-2.5 text-center" style={{ backgroundColor: withAlpha('#16A34A', 0.08) }}>
            <p className="text-sm" style={{ color: '#16A34A' }}>
              You'll earn <strong>{pointsLabel(loyaltyPoints)}</strong> with this order
            </p>
          </div>
        )}

        {/* Bottom buttons */}
        {items.length > 0 && (
          <div className="px-5 py-4 border-t border-gray-100 flex gap-3">
            <button
              onClick={handleClose}
              className="flex-1 py-3.5 rounded-xl border-2 border-gray-300 font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              + Add Item
            </button>
            <button
              onClick={handleCheckout}
              className="flex-1 py-3.5 rounded-xl bg-[#16A34A] text-white font-semibold active:scale-[0.98] transition-transform"
            >
              Checkout
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
