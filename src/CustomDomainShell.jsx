import { useEffect, useState, lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { getCustomDomainKey, MAIN_DOMAIN } from './lib/customDomain'
import HomePage from './pages/website/HomePage'
import MenuStaticRoute from './pages/website/MenuStaticRoute'

const LinkViewer = lazy(() => import('./pages/website/LinkViewer'))

function Spinner() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

// Bounces /order on a custom domain to the ordering flow on the main
// domain, preserving an item query param if present.
function OrderRedirect({ slug }) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const item = params.get('item')
    const target = `https://${MAIN_DOMAIN}/${slug}${item ? `?item=${item}` : ''}`
    window.location.replace(target)
  }, [slug])
  return <Spinner />
}

export default function CustomDomainShell() {
  const [restaurant, setRestaurant] = useState(null)
  const [hours, setHours] = useState([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    async function load() {
      const domain = getCustomDomainKey()
      if (!domain) { setNotFound(true); setLoading(false); return }

      const { data: rest } = await supabase
        .from('restaurants')
        .select('*')
        .eq('custom_domain', domain)
        .maybeSingle()

      if (!rest) { setNotFound(true); setLoading(false); return }

      const { data: hoursData } = await supabase
        .from('hours')
        .select('*')
        .eq('restaurant_id', rest.id)
        .order('day_of_week')

      setRestaurant(rest)
      setHours(hoursData || [])
      setLoading(false)
    }
    load()
  }, [])

  // Stray ?item= at root on a custom domain: send to ordering flow.
  useEffect(() => {
    if (!restaurant) return
    const params = new URLSearchParams(window.location.search)
    const item = params.get('item')
    if (item && window.location.pathname === '/') {
      window.location.replace(`https://${MAIN_DOMAIN}/${restaurant.slug}?item=${item}`)
    }
  }, [restaurant])

  if (loading) return <Spinner />

  // Domain isn't yet configured in DB — bounce to main marketing site
  // rather than serve DirectBite-branded content under the wrong host.
  if (notFound || !restaurant) {
    if (typeof window !== 'undefined') {
      window.location.replace(`https://${MAIN_DOMAIN}`)
    }
    return null
  }

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<HomePage restaurant={restaurant} hours={hours} />} />
        <Route path="/order" element={<OrderRedirect slug={restaurant.slug} />} />
        <Route path="/menu" element={<MenuStaticRoute restaurant={restaurant} hours={hours} />} />
        <Route path="/:linkPath" element={<LinkViewer restaurant={restaurant} hours={hours} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
