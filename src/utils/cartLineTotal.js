// One cart line's contribution to the subtotal. Shared by useCart (the subtotal
// itself) and MenuPage (the post-add subtotal for the native add-to-cart toast)
// so both use the cart's own math.
export function cartLineTotal(item) {
  const toppingsTotal = (item.toppings || []).reduce((ts, t) => ts + (parseFloat(t.price) || 0), 0)
  return ((parseFloat(item.basePrice) || 0) + toppingsTotal) * (item.quantity || 1)
}
