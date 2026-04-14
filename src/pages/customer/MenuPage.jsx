import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useMenu } from '../../hooks/useMenu'
import { usePromotion } from '../../hooks/usePromotion'
import { useCart } from '../../hooks/useCart'
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
  const { restaurant, isOpen, nextOpenTime, loading: restLoading, error } = useRestaurant(slug)
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

    window.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => window.removeEventListener('scroll', handleScroll)
  }, [categories, items])

  const handleCategorySelect = useCallback((categoryId) => {
    setActiveCategory(categoryId)
    const el = sectionRefs.current[categoryId]
    if (el) {
      const offset = 120
      const top = el.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top, behavior: 'smooth' })
    }
  }, [])

  const handleItemClick = useCallback(
    (item) => {
      if (!item.is_available) {
        toast.error('This item is currently unavailable')
        return
      }
      if (!isOpen) {
        toast.error('Ordering is currently closed')
        return
      }
      setSelectedItem(item)
    },
    [isOpen]
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
          onClose={() => setSelectedItem(null)}
        />
      )}

      {/* Cart sheet */}
      {showCart && (
        <CartSheet
          onClose={() => setShowCart(false)}
          onCheckout={handleCheckout}
        />
      )}
    </div>
  )
}
