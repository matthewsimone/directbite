import { useCallback, useEffect, useRef } from 'react'
import { useCart } from './useCart'

// Drops a reward line that does not belong to the customer who is signed in
// now.
//
// The cart is stored under directbite_cart_{slug} with a two-hour TTL
// (useCart.jsx:10, :21) — keyed by restaurant, never by customer. So on a
// shared device, a second customer signing in within that window inherits the
// first one's reward line, complete with a loyaltyRedemptionId belonging to
// someone else. They cannot cancel it either: cancel_redemption scopes its
// update by customer_id (079_cancel_redemption.sql), so the line is stuck in
// their cart until the cart itself expires.
//
// The comparison is against the server's answer for THIS customer at THIS
// restaurant. 080_one_pending_redemption.sql allows at most one pending
// redemption per pair, so a single equality settles it.
export function useRewardLineReconcile() {
  const { items, removeItem } = useCart()

  // items changes identity on every cart mutation, and this callback is a
  // dependency of the page effects that fetch the profile. Reading through a
  // ref is what keeps the callback stable — depending on items directly would
  // make adding a burger re-run the profile fetch.
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // removeItem rather than updateQuantity(id, 0): both are stable and both
  // filter by id (useCart.jsx:88-90, :92-98), but this is a line being revoked,
  // not a quantity going to zero.
  return useCallback((pendingRedemptionId) => {
    // The server could not determine it — an older deployment of customer-auth,
    // or a failed read. Not an answer, so nothing is destroyed on the strength
    // of it. null IS an answer: this customer has no pending redemption, so any
    // reward line in the cart is someone else's.
    if (pendingRedemptionId === undefined) return

    const rewardLine = itemsRef.current.find(i => i.loyaltyRedemptionId)
    if (!rewardLine) return
    if (rewardLine.loyaltyRedemptionId === pendingRedemptionId) return

    removeItem(rewardLine.id)
  }, [removeItem])
}
