import { lazy, Suspense, useState, useRef, useEffect, useCallback } from 'react'
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
import CartButton from '../../components/CartButton'

// Interaction-gated — kept out of the initial bundle via React.lazy. ItemModal
// mounts on item tap (or ?item= deep-link); CartSheet mounts when the cart
// opens. Neither is first-paint, so a null Suspense fallback is fine.
const ItemModal = lazy(() => import('../../components/ItemModal'))
const CartSheet = lazy(() => import('../../components/CartSheet'))

// Progressive-load placeholders — shown so first paint has page structure
// instead of a full-screen spinner. Mirror the real hero/card/section layout to
// avoid a layout shift when data arrives.
function HeroSkeleton() {
  return <div className="h-56 md:h-64 bg-gray-100 animate-pulse" />
}

function MenuItemCardSkeleton() {
  return (
    <div
      className="rounded-xl border border-gray-200 bg-white overflow-hidden animate-pulse"
      style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
    >
      <div className="flex">
        <div className="flex-1 min-w-0 p-4 space-y-2">
          <div className="h-4 w-2/3 bg-gray-200 rounded" />
          <div className="h-3 w-full bg-gray-100 rounded" />
          <div className="h-3 w-1/2 bg-gray-100 rounded" />
          <div className="h-4 w-16 bg-gray-200 rounded mt-2" />
        </div>
        <div className="shrink-0 w-[110px] bg-gray-100" />
      </div>
    </div>
  )
}

function MenuSkeleton() {
  return (
    <div className="max-w-[1100px] mx-auto px-6 sm:px-8">
      {[0, 1].map(s => (
        <section key={s} className="mb-8">
          <div className="h-6 w-40 bg-gray-200 rounded mt-8 mb-3 animate-pulse" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <MenuItemCardSkeleton key={i} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function MenuPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { restaurant, hours, isOpen, nextOpenTime, loading: restLoading, error, stalled: restStalled, failed: restFailed, hoursUnknown, retry: restRetry } = useRestaurant(slug)

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
    stalled: menuStalled,
    failed: menuFailed,
    retry: menuRetry,
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

  // Restaurant fetch hit the 10s hard deadline (network stall) — we don't know
  // whether the restaurant exists, so offer a retry rather than a misleading
  // "not found". Only reachable when the restaurant never loaded.
  if (restFailed && !restaurant) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Couldn't load this page</h1>
        <p className="text-gray-500 mb-6">Your connection looks unstable. Please try again.</p>
        <button onClick={restRetry} className="h-12 px-6 rounded-xl bg-[#16A34A] text-white font-semibold">
          Retry
        </button>
      </div>
    )
  }

  // Show not-found only once the restaurant fetch has settled without a timeout
  // — during the initial load we render the progressive skeleton below instead
  // of blocking, and a timeout is handled by the retry screen above.
  if (!restLoading && !restFailed && (error || !restaurant)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Restaurant not found</h1>
        <p className="text-gray-500">The page you're looking for doesn't exist.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white pb-24">
      {restaurant && <PromotionBanner promotion={promotion} />}
      {restaurant ? (
        <HeroSection restaurant={restaurant} isOpen={isOpen} nextOpenTime={nextOpenTime} hoursUnknown={hoursUnknown} />
      ) : (
        <HeroSkeleton />
      )}
      {restaurant && !isOpen && !hoursUnknown && nextSlotLabel && (
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
      {menuFailed ? (
        <div className="max-w-[1100px] mx-auto px-6 py-16 text-center">
          <p className="text-gray-600 mb-4">We couldn't load the menu — your connection looks unstable.</p>
          <button onClick={menuRetry} className="h-12 px-6 rounded-xl bg-[#16A34A] text-white font-semibold">
            Retry
          </button>
        </div>
      ) : menuLoading ? (
        <>
          <MenuSkeleton />
          {(menuStalled || restStalled) && (
            <p className="text-center text-sm text-gray-400 pb-8">Still loading… hang tight.</p>
          )}
        </>
      ) : (
        <>
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
                  {promotion && cat.discount_exempt === true && (
                    <div className="-mt-2 mb-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 text-[#16A34A] text-xs font-medium px-2 py-0.5">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                          <line x1="7" y1="7" x2="7.01" y2="7"/>
                        </svg>
                        Already discounted
                      </span>
                    </div>
                  )}
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
        </>
      )}

      {/* Cart button */}
      {restaurant && (
        <CartButton itemCount={itemCount} total={subtotal} onClick={() => setShowCart(true)} />
      )}

      {/* Item modal */}
      {selectedItem && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {/* Cart sheet */}
      {showCart && (
        <Suspense fallback={null}>
          <CartSheet
            onClose={() => setShowCart(false)}
            onCheckout={handleCheckout}
            promotion={promotion}
          />
        </Suspense>
      )}
    </div>
  )
}
