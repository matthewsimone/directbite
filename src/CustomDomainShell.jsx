import { useEffect, useState, lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { boundedFetch } from './lib/boundedFetch'
import { getCustomDomainKey, MAIN_DOMAIN } from './lib/customDomain'
import HomePage from './pages/website/HomePage'
import MenuStaticRoute from './pages/website/MenuStaticRoute'
import PlaceStaticRoute from './pages/website/PlaceStaticRoute'
import TagStaticRoute from './pages/website/TagStaticRoute'
import { LinkBaseProvider } from './pages/website/LinkBaseContext'

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
  const [failed, setFailed] = useState(false)
  // Bumped by retry() to re-run the load effect after a network-stall failure.
  const [reloadNonce, setReloadNonce] = useState(0)

  const retry = () => { setFailed(false); setNotFound(false); setLoading(true); setReloadNonce((n) => n + 1) }

  useEffect(() => {
    // Mount-scoped controller: unmount aborts the bounded-fetch attempts so a
    // superseded load never writes state.
    const controller = new AbortController()
    const outerSignal = controller.signal
    // One shared 10s ceiling for the whole load (restaurant + hours together).
    const deadlineAt = Date.now() + 10000
    async function load() {
      const domain = getCustomDomainKey()
      if (!domain) { setNotFound(true); setLoading(false); return }

      try {
        const restGrp = await boundedFetch(
          [(s) => supabase.from('restaurants').select('*').eq('custom_domain', domain).maybeSingle().abortSignal(s).retry(false)],
          { deadlineAt, signal: outerSignal }
        )
        if (restGrp.cancelled) return
        if (restGrp.timedOut) { setFailed(true); setLoading(false); return }

        // maybeSingle no-match → { data: null, error: null }: definitive not-found.
        const rest = restGrp.results[0].data
        if (!rest) { setNotFound(true); setLoading(false); return }

        const hoursGrp = await boundedFetch(
          [(s) => supabase.from('hours').select('*').eq('restaurant_id', rest.id).order('day_of_week').abortSignal(s).retry(false)],
          { deadlineAt, signal: outerSignal }
        )
        if (hoursGrp.cancelled) return
        // Hours timeout is non-fatal — render with empty hours rather than block.
        const hoursData = hoursGrp.timedOut ? [] : (hoursGrp.results[0].data || [])

        setRestaurant(rest)
        setHours(hoursData || [])
        setLoading(false)
      } catch {
        if (!outerSignal.aborted) { setFailed(true); setLoading(false) }
      }
    }
    load()
    return () => controller.abort()
  }, [reloadNonce])

  // Stray ?item= at root on a custom domain: send to ordering flow.
  useEffect(() => {
    if (!restaurant) return
    const params = new URLSearchParams(window.location.search)
    const item = params.get('item')
    if (item && window.location.pathname === '/') {
      window.location.replace(`https://${MAIN_DOMAIN}/${restaurant.slug}?item=${item}`)
    }
  }, [restaurant])

  // Network stall hit the 10s hard deadline — offer a retry instead of an
  // endless spinner. (notFound below is a definitive DB miss, handled separately.)
  if (failed) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Couldn't load</h1>
          <p className="mt-2 text-sm text-gray-500">Your connection looks unstable.</p>
          <button onClick={retry} className="mt-4 h-11 px-5 rounded-xl bg-[#16A34A] text-white font-semibold">
            Retry
          </button>
        </div>
      </div>
    )
  }

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
      <LinkBaseProvider value="">
        <Routes>
          <Route path="/" element={<HomePage restaurant={restaurant} hours={hours} />} />
          <Route path="/order" element={<OrderRedirect slug={restaurant.slug} />} />
          <Route path="/menu" element={<MenuStaticRoute restaurant={restaurant} hours={hours} />} />
          <Route path="/places/:townSlug" element={<PlaceStaticRoute restaurant={restaurant} hours={hours} />} />
          <Route path="/tags/:tagSlug" element={<TagStaticRoute restaurant={restaurant} hours={hours} />} />
          <Route path="/:linkPath" element={<LinkViewer restaurant={restaurant} hours={hours} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </LinkBaseProvider>
    </Suspense>
  )
}
