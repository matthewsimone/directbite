// Rebuilds cart lines from a historical order against TODAY's menu.
//
// Order rows carry frozen copies of the name and price at order time. Those
// copies are for receipts, not for reordering — a reorder has to reprice and
// re-validate against the live menu, so nothing here reads item_name,
// base_price or price_charged off the order. It matches by id and takes every
// name and price from the menu rows it resolves.
//
// Anything that no longer resolves is skipped and reported rather than
// silently dropped or substituted.

const round2 = n => Math.round(n * 100) / 100

// The date-window test usePromotion applies after its query: perpetual promos
// always count, dated ones only inside an inclusive start/end window.
function activePromotion(rows) {
  const promo = rows && rows.length > 0 ? rows[0] : null
  if (!promo) return null
  if (promo.is_perpetual) return promo
  if (promo.start_date && promo.end_date) {
    const today = new Date().toISOString().split('T')[0]
    if (today >= promo.start_date && today <= promo.end_date) return promo
  }
  return null
}

export async function resolveOrderToCart(supabase, restaurantId, order) {
  // Same shapes useMenu fetches: item_sizes has no restaurant_id of its own,
  // so it filters through an inner join on menu_items; toppings carries one
  // directly. menu_items has no price column and no discount_exempt column —
  // the flag lives on the category, which is why it arrives nested.
  const [itemRes, sizeRes, topRes, promoRes] = await Promise.all([
    supabase
      .from('menu_items')
      .select('id, name, is_available, menu_categories(discount_exempt)')
      .eq('restaurant_id', restaurantId),
    supabase
      .from('item_sizes')
      .select('id, item_id, name, price, menu_items!inner(restaurant_id)')
      .eq('menu_items.restaurant_id', restaurantId),
    supabase
      .from('toppings')
      .select('id, name, price, price_half, is_available')
      .eq('restaurant_id', restaurantId),
    // Same query usePromotion runs; the date window is applied below because
    // it lives in that hook's JS rather than in the query.
    supabase
      .from('promotions')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('is_active', true)
      .limit(1),
  ])

  if (itemRes.error) throw new Error(itemRes.error.message)
  if (sizeRes.error) throw new Error(sizeRes.error.message)
  if (topRes.error) throw new Error(topRes.error.message)

  // A failed promo lookup must not fail the reorder — no promotion just means
  // every line prices at full, which checkout recalculates from fullBasePrice
  // anyway.
  let promotion = null
  if (promoRes.error) {
    console.error('resolveOrderToCart: promotion lookup failed', promoRes.error.message)
  } else {
    promotion = activePromotion(promoRes.data)
  }

  const itemsById = new Map((itemRes.data || []).map(r => [r.id, r]))
  const sizesById = new Map((sizeRes.data || []).map(r => [r.id, r]))
  const toppingsById = new Map((topRes.data || []).map(r => [r.id, r]))

  const lines = []
  const dropped = []
  const droppedToppings = []

  for (const row of order.order_items || []) {
    const menuItem = itemsById.get(row.menu_item_id)
    if (!menuItem || menuItem.is_available === false) {
      dropped.push(row.item_name)
      continue
    }

    // A size id that resolves to a DIFFERENT item means the size was moved or
    // recreated; rebuilding it onto this item would price the wrong thing.
    let size = null
    if (row.item_size_id) {
      size = sizesById.get(row.item_size_id) || null
      if (!size || size.item_id !== menuItem.id) {
        dropped.push(row.item_name)
        continue
      }
    }

    // menu_items carries no price of its own — prices live on item_sizes. A
    // sizeless line rebuilds at 0, which is exactly what ItemModal does.
    const basePrice = size ? Number(size.price) : 0

    // ItemModal.jsx:106-109, reproduced: an exempt category or a zero/absent
    // promo means multiplier 1. fullBasePrice and fullPrice stay undiscounted
    // — checkout reads those and recalculates the discount itself.
    const isExempt = menuItem.menu_categories?.discount_exempt === true
    const hasDiscount =
      promotion && Number(promotion.discount_percentage) > 0 && !isExempt
    const discountMultiplier = hasDiscount
      ? 1 - Number(promotion.discount_percentage) / 100
      : 1

    const toppings = []
    for (const t of row.order_item_toppings || []) {
      const topping = toppingsById.get(t.topping_id)
      if (!topping || topping.is_available === false) {
        droppedToppings.push(t.topping_name)
        continue
      }
      // ItemModal's rule: halves fall back to whole/2 when price_half is null.
      const whole = Number(topping.price) || 0
      const half = topping.price_half != null ? Number(topping.price_half) : whole / 2
      const price = round2(t.placement === 'whole' ? whole : half)
      toppings.push({
        toppingId: topping.id,
        toppingName: topping.name,
        placement: t.placement,
        price: round2(price * discountMultiplier),
        fullPrice: price,
        placementType: t.placement_type || 'pizza',
      })
    }

    lines.push({
      menuItemId: menuItem.id,
      itemSizeId: size ? size.id : null,
      itemName: menuItem.name,
      sizeName: size ? size.name : null,
      basePrice: round2(basePrice * discountMultiplier),
      fullBasePrice: basePrice,
      quantity: Number(row.quantity) || 1,
      discount_exempt: menuItem.menu_categories?.discount_exempt ?? false,
      specialInstructions: row.special_instructions || null,
      toppings,
    })
  }

  return { lines, dropped, droppedToppings }
}
