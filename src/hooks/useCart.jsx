import { createContext, useContext, useState, useCallback, useEffect } from 'react'

const generateId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })

const CART_EXPIRY_MS = 2 * 60 * 60 * 1000 // 2 hours

function getSlugFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  // Routes: /:slug, /:slug/checkout, /:slug/confirmation
  // Skip: /admin, /
  if (parts.length > 0 && parts[0] !== 'admin') return parts[0]
  return null
}

function getStorageKey(slug) {
  return slug ? `directbite_cart_${slug}` : null
}

function loadCart(slug) {
  const key = getStorageKey(slug)
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const { items, timestamp } = JSON.parse(raw)
    if (Date.now() - timestamp > CART_EXPIRY_MS) {
      localStorage.removeItem(key)
      return []
    }
    return items || []
  } catch {
    return []
  }
}

function saveCart(slug, items) {
  const key = getStorageKey(slug)
  if (!key) return
  if (items.length === 0) {
    localStorage.removeItem(key)
    return
  }
  try {
    localStorage.setItem(key, JSON.stringify({ items, timestamp: Date.now() }))
  } catch { /* storage full — ignore */ }
}

const CartContext = createContext(null)

export function CartProvider({ children }) {
  const [slug, setSlug] = useState(() => getSlugFromPath())
  const [items, setItems] = useState(() => loadCart(getSlugFromPath()))

  // Update slug when URL changes (SPA navigation)
  useEffect(() => {
    function handleNav() {
      const newSlug = getSlugFromPath()
      setSlug(prev => {
        if (prev !== newSlug) {
          setItems(loadCart(newSlug))
          return newSlug
        }
        return prev
      })
    }

    window.addEventListener('popstate', handleNav)
    // Also check on render in case of programmatic navigation
    handleNav()

    return () => window.removeEventListener('popstate', handleNav)
  }, [])

  // Persist to localStorage when items change
  useEffect(() => {
    saveCart(slug, items)
  }, [items, slug])

  const addItem = useCallback((item) => {
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
