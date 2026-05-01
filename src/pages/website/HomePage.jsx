import { useEffect, useState } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useRestaurant } from '../../hooks/useRestaurant'
import { usePromotion } from '../../hooks/usePromotion'
import PromoBar from './components/PromoBar'
import TopBar from './components/TopBar'
import Hero from './components/Hero'
import About from './components/About'
import FeaturedMenu from './components/FeaturedMenu'
import Gallery from './components/Gallery'
import Reviews from './components/Reviews'
import { getStatus } from './utils/hours'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function HomePage() {
  const { slug } = useParams()
  const { restaurant, hours, loading, error } = useRestaurant(slug)
  const { promotion } = usePromotion(restaurant?.id)
  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })

  // Recompute open/closed every 60s so the banner stays current.
  useEffect(() => {
    function tick() {
      setStatus(getStatus(hours, new Date()))
    }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !restaurant) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Restaurant not found</h1>
          <p className="mt-2 text-sm text-gray-500">{error || 'No restaurant matches this URL.'}</p>
        </div>
      </div>
    )
  }

  // Website add-on not enabled — fall back to the customer ordering page.
  if (!restaurant.website_enabled) {
    return <Navigate to={`/${slug}`} replace />
  }

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR

  const galleryUrls = restaurant.gallery_urls || []
  const reviews = restaurant.reviews || []

  return (
    <div className="min-h-screen bg-white" style={{ '--brand-color': brandColor }}>
      <PromoBar promotion={promotion} />
      <TopBar restaurant={restaurant} status={status} hours={hours} />
      <Hero restaurant={restaurant} />
      {restaurant.about_section_visible && restaurant.about_text && (
        <About restaurant={restaurant} />
      )}
      {restaurant.featured_menu_section_visible && (
        <FeaturedMenu restaurant={restaurant} />
      )}
      {restaurant.gallery_section_visible && galleryUrls.length > 0 && (
        <Gallery urls={galleryUrls} />
      )}
      {restaurant.reviews_section_visible && reviews.length > 0 && (
        <Reviews reviews={reviews} />
      )}
      {/* Phase 2C: Footer, sticky mobile CTA, embedded map */}
    </div>
  )
}
