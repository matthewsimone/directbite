import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useMenu } from '../../hooks/useMenu'
import { usePromotion } from '../../hooks/usePromotion'
import { getAvailableDates, getAvailableTimeSlots, formatScheduledLabel } from '../../utils/scheduling'
import { useCart } from '../../hooks/useCart'
import { useWalletDetection } from '../../hooks/useWalletDetection'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import HeroSection from '../../components/HeroSection'
import PromotionBanner from '../../components/PromotionBanner'
import CategoryTabs from '../../components/CategoryTabs'
import MenuSearch from '../../components/MenuSearch'
import MenuItemCard from '../../components/MenuItemCard'
import ItemModal from '../../components/ItemModal'
import CartButton from '../../components/CartButton'
import CartSheet from '../../components/CartSheet'

export default function MenuPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { restaurant, hours, isOpen, nextOpenTime, loading: restLoading, error } = useRestaurant(slug)

  // First bookable slot for the closed-state banner. Uses a 30-min lead
  // floor — checkout will recompute against the order-type's prep time.
  const nextSlotLabel = (() => {
    if (isOpen || !hours || hours.length === 0) return null
    const dates = getAvailableDates(hours, { leadTimeMinutes: 30 })
    if (dates.length === 0) return null
    const slots = getAvailableTimeSlots(dates[0].date, hours, { leadTimeMinutes: 30 })
    if (slots.length === 0) return null
    return formatScheduledLabel(slots[0].value)
  })()
  // Pre-detect Apple Pay / Google Pay availability (caches in sessionStorage)
  useWalletDetection(restaurant?.stripe_account_id)
  // Per-restaurant tab branding + Add-to-Home-Screen manifest.
  useRestaurantBranding(restaurant, 'ordering')
  const {
    categories,
    items,
    loading: menuLoading,
    getItemsByCategory,
    getSizesForItem,
    getToppingGroupsForItem,
    getToppingsForGroup,
    getLowestPrice,
  } = useMenu(restaurant?.id)
  const { promotion } = usePromotion(restaurant?.id)
  const { addItem, itemCount, subtotal } = useCart()

  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState(null)
  const [selectedItem, setSelectedItem] = useState(null)
  const [showCart, setShowCart] = useState(false)

  const sectionRefs = useRef({})
  const programmaticScrollRef = useRef(false)
  const programmaticScrollTimeoutRef = useRef(null)

  // Set initial active category
  useEffect(() => {
    if (categories.length > 0 && !activeCategory) {
      setActiveCategory(categories[0].id)
    }
  }, [categories, activeCategory])

  // Scroll-based category tracking — pick the section closest to the top of the viewport
  useEffect(() => {
    if (categories.length === 0) return

    function handleScroll() {
      // Suppressed during smooth-scroll-to-section so we don't flicker
      // through every category the page passes on the way to the tapped one.
      if (programmaticScrollRef.current) return
      const offset = 140
      let closest = null
      let closestDist = Infinity

      for (const cat of categories) {
        const el = sectionRefs.current[cat.id]
        if (!el) continue
        const top = el.getBoundingClientRect().top - offset
        // Pick the section whose top is closest to (but not far below) the offset line
        if (top <= 0 && Math.abs(top) < closestDist) {
          closestDist = Math.abs(top)
          closest = cat.id
        }
      }

      // If no section has scrolled past the offset, use the first category
      if (!closest && categories.length > 0) {
        closest = categories[0].id
      }

      if (closest) setActiveCategory(closest)
    }

    function handleScrollEnd() {
      programmaticScrollRef.current = false
      if (programmaticScrollTimeoutRef.current) {
        clearTimeout(programmaticScrollTimeoutRef.current)
        programmaticScrollTimeoutRef.current = null
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('scrollend', handleScrollEnd)
    handleScroll()

    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('scrollend', handleScrollEnd)
    }
  }, [categories, items])

  const handleCategorySelect = useCallback((categoryId) => {
    setActiveCategory(categoryId)
    // Suppress scroll-based active-category updates until the smooth
    // scroll lands. Cleared by the scrollend listener; the timeout is
    // a fallback for browsers without scrollend support and for taps
    // that don't actually move the page.
    programmaticScrollRef.current = true
    if (programmaticScrollTimeoutRef.current) {
      clearTimeout(programmaticScrollTimeoutRef.current)
    }
    programmaticScrollTimeoutRef.current = setTimeout(() => {
      programmaticScrollRef.current = false
      programmaticScrollTimeoutRef.current = null
    }, 1000)

    const el = sectionRefs.current[categoryId]
    if (el) {
      const offset = 120
      const top = el.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top, behavior: 'smooth' })
    }
  }, [])

  // Clean up any pending suppression timeout if the page unmounts mid-scroll.
  useEffect(() => {
    return () => {
      if (programmaticScrollTimeoutRef.current) {
        clearTimeout(programmaticScrollTimeoutRef.current)
      }
    }
  }, [])

  const handleItemClick = useCallback(
    (item) => {
      if (!item.is_available) {
        toast.error('This item is currently unavailable')
        return
      }
      // Closed restaurants no longer block — users can browse, add to cart,
      // and pick a future slot at checkout. The closed-hours banner above
      // explains the state.
      setSelectedItem(item)
    },
    []
  )

  const handleAddToCart = useCallback(
    (cartItem) => {
      addItem(cartItem)
      toast.success(`${cartItem.itemName} added to cart`)
    },
    [addItem]
  )

  const handleCheckout = useCallback(() => {
    setShowCart(false)
    navigate(`/${slug}/checkout`)
  }, [navigate, slug])

  // Filter items by search
  const filterItems = useCallback(
    (categoryItems) => {
      if (!searchQuery.trim()) return categoryItems
      const q = searchQuery.toLowerCase()
      return categoryItems.filter(
        i => i.name.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q)
      )
    },
    [searchQuery]
  )

  // Scroll to top after menu data loads
  useEffect(() => {
    if (!restLoading && !menuLoading && items.length > 0) {
      requestAnimationFrame(() => window.scrollTo(0, 0))
    }
  }, [restLoading, menuLoading])

  // Deep-link: /:slug?item=ID auto-opens that item's modal so the website's
  // Featured Menu can land users straight in the order flow. Bypasses the
  // closed/unavailable guard — the modal opens for browse, the existing
  // Add-to-Cart logic still blocks purchase when needed.
  useEffect(() => {
    if (menuLoading || items.length === 0) return
    const params = new URLSearchParams(window.location.search)
    const itemId = params.get('item')
    if (!itemId) return
    const match = items.find(i => i.id === itemId)
    if (match) setSelectedItem(match)
  }, [menuLoading, items])

  if (restLoading || menuLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !restaurant) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Restaurant not found</h1>
        <p className="text-gray-500">The page you're looking for doesn't exist.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white pb-24">
      <PromotionBanner promotion={promotion} />
      <HeroSection restaurant={restaurant} isOpen={isOpen} nextOpenTime={nextOpenTime} />
      {!isOpen && nextSlotLabel && (
        <div className="bg-amber-50 border-y border-amber-200 px-6 py-4">
          <div className="max-w-[1100px] mx-auto flex items-start gap-3 text-amber-900">
            <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-base font-semibold">
                Order Ahead
              </p>
              <p className="mt-1 text-sm text-amber-800/90">
                Next Available: {nextSlotLabel}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Popular Items section */}
      {!searchQuery && items.some(i => i.is_popular && i.is_available) && (
        <div className="max-w-[1100px] mx-auto px-6 sm:px-8 pt-6">
          <h2 className="text-xl font-bold text-gray-900 mb-3">Popular Items</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-2">
            {items.filter(i => i.is_popular && i.is_available).map(item => (
              <MenuItemCard
                key={`popular-${item.id}`}
                item={item}
                lowestPrice={getLowestPrice(item.id)}
                promotion={promotion}
                onClick={() => handleItemClick(item)}
              />
            ))}
          </div>
        </div>
      )}

      <CategoryTabs
        categories={categories}
        activeId={activeCategory}
        onSelect={handleCategorySelect}
      />
      <MenuSearch value={searchQuery} onChange={setSearchQuery} />

      {/* Menu sections */}
      <div className="max-w-[1100px] mx-auto px-6 sm:px-8">
        {categories.map(cat => {
          const catItems = filterItems(getItemsByCategory(cat.id))
          if (searchQuery && catItems.length === 0) return null

          return (
            <section
              key={cat.id}
              ref={el => (sectionRefs.current[cat.id] = el)}
              data-category-id={cat.id}
              className="mb-8"
            >
              <h2 className="text-xl font-bold text-gray-900 mt-8 mb-3">{cat.name}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {catItems.map(item => (
                  <MenuItemCard
                    key={item.id}
                    item={item}
                    lowestPrice={getLowestPrice(item.id)}
                    promotion={promotion}
                    onClick={() => handleItemClick(item)}
                  />
                ))}
              </div>
              {catItems.length === 0 && !searchQuery && (
                <p className="text-gray-400 text-sm py-4">No items in this category yet.</p>
              )}
            </section>
          )
        })}

        {searchQuery && categories.every(cat => filterItems(getItemsByCategory(cat.id)).length === 0) && (
          <p className="text-center text-gray-400 py-12">No items match "{searchQuery}"</p>
        )}
      </div>

      {/* Cart button */}
      <CartButton itemCount={itemCount} total={subtotal} onClick={() => setShowCart(true)} />

      {/* Item modal */}
      {selectedItem && (
        <ItemModal
          item={selectedItem}
          sizes={getSizesForItem(selectedItem.id)}
          toppingGroupsForItem={getToppingGroupsForItem(selectedItem.id)}
          getToppingsForGroup={getToppingsForGroup}
          promotion={promotion}
          onAddToCart={handleAddToCart}
          onClose={() => {
            setSelectedItem(null)
            if (new URLSearchParams(window.location.search).has('item')) {
              window.history.replaceState({}, '', `/${slug}`)
            }
          }}
        />
      )}

      {/* Cart sheet */}
      {showCart && (
        <CartSheet
          onClose={() => setShowCart(false)}
          onCheckout={handleCheckout}
          promotion={promotion}
        />
      )}
    </div>
  )
}
