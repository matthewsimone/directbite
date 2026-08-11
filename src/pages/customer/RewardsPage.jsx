import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useCustomerAuth } from '../../hooks/useCustomerAuth'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import RewardsView from '../../components/RewardsView'
import SignInSheet from '../../components/SignInSheet'

export default function RewardsPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { restaurant, loading: restLoading, error, failed: restFailed, retry: restRetry } = useRestaurant(slug)
  const { loading: authLoading, isLoggedIn, loadProfile, loadHistory } = useCustomerAuth()
  // Per-restaurant tab branding + Add-to-Home-Screen manifest.
  useRestaurantBranding(restaurant, 'ordering')

  const [tiers, setTiers] = useState([])
  const [rewards, setRewards] = useState([])
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [history, setHistory] = useState(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [signInOpen, setSignInOpen] = useState(false)

  useEffect(() => {
    if (!restaurant?.id) return
    fetchLoyalty(restaurant.id)
  }, [restaurant?.id])

  // The profile is scoped to THIS page's restaurant, so a customer viewing one
  // restaurant's rewards can never see another restaurant's balance. The
  // cancelled flag stops a slow response for a previous restaurant from
  // overwriting a newer one.
  // profile stays null for four different states — unfetched, no row here,
  // request failed, logged out — so the gate below tracks the request itself
  // rather than its result. The cleanup deliberately leaves profileLoading
  // set: a superseded request must not clear a flag the newer one now owns.
  useEffect(() => {
    if (!restaurant?.id || !isLoggedIn) { setProfile(null); setProfileLoading(false); return }
    let cancelled = false
    setProfileLoading(true)
    loadProfile(restaurant.id).then(p => {
      if (!cancelled) { setProfile(p); setProfileLoading(false) }
    })
    return () => { cancelled = true }
  }, [restaurant?.id, isLoggedIn, loadProfile])

  // Same scoping as the profile above, but deliberately outside the loading
  // gate — the page renders without it and the Orders tab shows its own
  // loading state.
  useEffect(() => {
    if (!restaurant?.id || !isLoggedIn) { setHistory(null); return }
    let cancelled = false
    loadHistory(restaurant.id).then(h => { if (!cancelled) setHistory(h) })
    return () => { cancelled = true }
  }, [restaurant?.id, isLoggedIn, loadHistory])

  async function fetchLoyalty(restaurantId) {
    setDataLoading(true)
    const [tierRes, rewardRes] = await Promise.all([
      supabase
        .from('restaurant_loyalty_tiers')
        .select('id, tier_level, name, color, multiplier, threshold_points')
        .eq('restaurant_id', restaurantId)
        .order('tier_level'),
      supabase
        .from('loyalty_rewards')
        .select('id, kind, name, description, points_cost, discount_cents, min_subtotal_cents, active, sort_order, menu_items(image_url)')
        .eq('restaurant_id', restaurantId)
        .eq('active', true)
        .order('sort_order'),
    ])

    if (tierRes.error) toast.error(`Tier load failed: ${tierRes.error.message}`)
    if (rewardRes.error) toast.error(`Reward load failed: ${rewardRes.error.message}`)

    setTiers(tierRes.data || [])
    setRewards(rewardRes.data || [])
    setDataLoading(false)
  }

  // Restaurant fetch hit the 10s hard deadline — we don't know whether the
  // restaurant exists, so offer a retry rather than a misleading "not found".
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

  // Not-found only once the fetch has settled without a timeout.
  if (!restLoading && !restFailed && (error || !restaurant)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Restaurant not found</h1>
        <p className="text-gray-500">The page you're looking for doesn't exist.</p>
      </div>
    )
  }

  if (restLoading || dataLoading || authLoading || profileLoading || !restaurant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white px-6">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  if (!restaurant.loyalty_enabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white px-6 text-center">
        <p className="text-gray-500">This restaurant doesn't have a rewards program yet.</p>
      </div>
    )
  }

  const customer = isLoggedIn && profile
    ? {
        displayName: (profile.display_name || '').split(' ')[0] || '',
        pointsBalance: profile.points_balance ?? 0,
        lifetimePoints: profile.lifetime_points_earned ?? 0,
        tierLevel: profile.tier_level ?? 1,
        orderCount: profile.order_count ?? 0,
      }
    : null

  return (
    <div className="min-h-screen bg-white">
      {/* Floating back button in place of a sticky header bar — the bar's
          "Rewards" title only repeated the program name headline below it.
          It lives in the page gutter rather than the centred content column,
          so on a wide screen it lands at the far left where the bar had it. */}
      <div className="px-5 pt-4">
        <button
          onClick={() => navigate(`/${slug}`)}
          className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center"
        >
          <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="max-w-[720px] mx-auto px-6 pt-2 pb-8">
        <RewardsView
          restaurant={restaurant}
          tiers={tiers}
          rewards={rewards}
          customer={customer}
          orders={history?.orders ?? []}
          transactions={history?.transactions ?? []}
          historyLoading={isLoggedIn && history === null}
          onSignIn={() => setSignInOpen(true)}
        />
      </div>

      <SignInSheet
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        // No explicit refetch: the profile effect above depends on isLoggedIn,
        // which flips true on a successful verify, so the profile for this
        // restaurant reloads on its own.
        onSuccess={() => {}}
        restaurantId={restaurant.id}
        brandColor={restaurant.primary_color || '#16A34A'}
      />
    </div>
  )
}
