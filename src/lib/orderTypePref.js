import { IS_NATIVE } from './native'

// Native shell only: the Pickup/Delivery choice shared by the Menu hero and
// Checkout, per restaurant, in memory (resets on app kill → restaurant default).
// Web: read returns null, write is a no-op — web behaviour unchanged.
const picked = {}

export function readOrderTypePref(restaurantId) {
  if (!IS_NATIVE || !restaurantId) return null
  const v = picked[restaurantId]
  return v === 'pickup' || v === 'delivery' ? v : null
}

export function writeOrderTypePref(restaurantId, type) {
  if (!IS_NATIVE || !restaurantId) return
  if (type === 'pickup' || type === 'delivery') picked[restaurantId] = type
}

// Preference if valid for this restaurant, else the restaurant default, else pickup.
export function resolveOrderType(pref, restaurant) {
  const canDeliver = restaurant?.delivery_available === true
  if (pref === 'delivery' && canDeliver) return 'delivery'
  if (pref === 'pickup') return 'pickup'
  return restaurant?.default_order_type === 'delivery' && canDeliver ? 'delivery' : 'pickup'
}
