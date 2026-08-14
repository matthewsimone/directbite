import { useState, useEffect } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useCustomerAuth } from '../../hooks/useCustomerAuth'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import RewardsView from '../../components/RewardsView'
import SignInSheet from '../../components/SignInSheet'

// Signed-out marketing for the loyalty program. The signed-in surface lives at
// /:slug/account — this page's only jobs are to sell the program to a visitor
// who has no account yet, and to get them signed in.
export default function RewardsPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { restaurant, loading: restLoading, error, failed: restFailed, retry: restRetry } = useRestaurant(slug)
  const { loading: authLoading, isLoggedIn } = useCustomerAuth()
  // Per-restaurant tab branding + Add-to-Home-Screen manifest.
  useRestaurantBranding(restaurant, 'ordering')

  const [tiers, setTiers] = useState([])
  const [rewards, setRewards] = useState([])
  const [dataLoading, setDataLoading] = useState(false)
  const [signInOpen, setSignInOpen] = useState(false)

  const loyaltyEnabled = restaurant?.loyalty_enabled === true

  // A restaurant with loyalty off redirects below, so there is nothing to
  // fetch for one — and RLS would return empty sets anyway
  // (070_loyalty_public_read scopes both anon policies on the flag).
  useEffect(() => {
    if (!restaurant?.id) return
    if (!loyaltyEnabled) { setTiers([]); setRewards([]); return }
    fetchLoyalty(restaurant.id)
  }, [restaurant?.id, loyaltyEnabled])

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

  if (restLoading || dataLoading || authLoading || !restaurant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white px-6">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  // Both redirects are only reachable once auth has settled — authLoading is
  // part of the gate above. That ordering is what keeps this page and
  // /:slug/account from pointing at each other: /account sends a visitor here
  // only when isLoggedIn is false, and this sends them there only when it is
  // true, so the two conditions can never hold at the same moment. Both routes
  // read one provider value (CustomerAuthProvider is mounted above the router
  // in App.jsx), so there is no window where they disagree. `replace` leaves
  // no history entry to walk back into.
  if (isLoggedIn) {
    return <Navigate to={`/${slug}/account`} replace />
  }

  // No button links here for a restaurant without a program, but a typed URL
  // or a stale bookmark must not render an empty program page.
  if (!loyaltyEnabled) {
    return <Navigate to={`/${slug}`} replace />
  }

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
          onSignIn={() => setSignInOpen(true)}
        />
      </div>

      <SignInSheet
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        // A successful verify flips isLoggedIn, which the redirect above would
        // catch on the next render anyway — but going explicitly means the
        // customer lands on their account rather than watching this page
        // rearrange itself first.
        onSuccess={() => navigate(`/${slug}/account`)}
        restaurantId={restaurant.id}
        // Platform green, not primary_color — the sheet is ordering-flow
        // chrome and matches RewardsView behind it.
        brandColor="#16A34A"
      />
    </div>
  )
}
