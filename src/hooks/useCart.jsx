import { createContext, useContext, useState, useCallback } from 'react'

const generateId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })

const CartContext = createContext(null)

export function CartProvider({ children }) {
  const [items, setItems] = useState([])

  const addItem = useCallback((item) => {
    // item shape: { id (unique cart id), menuItemId, itemSizeId, itemName, sizeName, basePrice, quantity, specialInstructions, toppings: [{ toppingId, toppingName, placement, price }] }
    setItems(prev => [...prev, { ...item, id: generateId() }])
  }, [])

  const removeItem = useCallback((cartItemId) => {
    setItems(prev => prev.filter(i => i.id !== cartItemId))
  }, [])

  const updateQuantity = useCallback((cartItemId, quantity) => {
    if (quantity <= 0) {
      setItems(prev => prev.filter(i => i.id !== cartItemId))
      return
    }
    setItems(prev => prev.map(i => i.id === cartItemId ? { ...i, quantity } : i))
  }, [])

  const clearCart = useCallback(() => setItems([]), [])

  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0)

  const subtotal = items.reduce((sum, item) => {
    const toppingsTotal = (item.toppings || []).reduce((ts, t) => ts + (parseFloat(t.price) || 0), 0)
    return sum + ((parseFloat(item.basePrice) || 0) + toppingsTotal) * (item.quantity || 1)
  }, 0)

  return (
    <CartContext.Provider value={{ items, addItem, removeItem, updateQuantity, clearCart, itemCount, subtotal }}>
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within CartProvider')
  return ctx
}
