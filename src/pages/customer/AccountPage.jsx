import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { useRestaurant } from '../../hooks/useRestaurant'
import { useCustomerAuth } from '../../hooks/useCustomerAuth'
import { useRestaurantBranding } from '../../hooks/useRestaurantBranding'
import { useCart } from '../../hooks/useCart'
import { resolveOrderToCart } from '../../lib/reorder'
import AccountView from '../../components/AccountView'

// The signed-in surface, for both loyalty configurations. Deliberately NOT
// gated on loyalty_enabled: a restaurant can run customer accounts without a
// points program, and those customers still have order history to reorder from.
export default function AccountPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { restaurant, loading: restLoading, error, failed: restFailed, retry: restRetry } = useRestaurant(slug)
  const { loading: authLoading, isLoggedIn, loadProfile, loadHistory, redeemReward, logout } = useCustomerAuth()
  const { addItem } = useCart()
  // Per-restaurant tab branding + Add-to-Home-Screen manifest.
  useRestaurantBranding(restaurant, 'ordering')

  const [tiers, setTiers] = useState([])
  const [rewards, setRewards] = useState([])
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [history, setHistory] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyFailed, setHistoryFailed] = useState(false)
  const [dataLoading, setDataLoading] = useState(false)

  const loyaltyEnabled = restaurant?.loyalty_enabled === true

  // Only a loyalty restaurant has tiers or a reward catalog. RLS returns empty
  // sets for the rest — 070_loyalty_public_read scopes both anon policies on
  // the flag — so querying them with loyalty off is two round trips for two
  // guaranteed-empty arrays.
  useEffect(() => {
    if (!restaurant?.id) return
    if (!loyaltyEnabled) { setTiers([]); setRewards([]); return }
    fetchLoyalty(restaurant.id)
  }, [restaurant?.id, loyaltyEnabled])

  // Monotonic id for the in-flight profile request, for the same reason as
  // historyReqRef below: the initial load and a post-redemption refresh share
  // one fetch function, so the counter is what decides which result owns the
  // state. The cancelled-flag closure this replaces could only see its own
  // effect run, not a refresh racing it.
  const profileReqRef = useRef(0)

  // Whether a profile request is outstanding. profileLoading cannot answer
  // this any more: a silent refresh never raises it. Only the refocus refetch
  // reads this, to avoid stacking a second request on a slow first one.
  const profileInFlightRef = useRef(false)

  // profile stays null for four different states — unfetched, no row here,
  // request failed, logged out — so the gate tracks the request itself rather
  // than its result.
  //
  // `silent` controls only whether the flag is RAISED, never whether it is
  // lowered. profileLoading is part of the whole-page load gate below, so a
  // background refresh that raised it would blank a rendered page back to
  // "Loading..." for one round trip. Lowering it is unconditional because the
  // request holding the current id owns the flag either way: a silent refresh
  // that supersedes an in-flight initial load inherits the responsibility for
  // clearing what that load raised.
  const loadProfileFor = useCallback(async (restaurantId, { silent = false } = {}) => {
    const reqId = ++profileReqRef.current
    profileInFlightRef.current = true
    if (!silent) setProfileLoading(true)
    const p = await loadProfile(restaurantId)
    // A newer request has taken ownership; this result is stale. Leaving the
    // in-flight ref set is correct — the newer request is still outstanding.
    if (profileReqRef.current !== reqId) return
    profileInFlightRef.current = false
    setProfile(p)
    setProfileLoading(false)
  }, [loadProfile])

  // The profile is scoped to THIS page's restaurant, so a customer viewing one
  // restaurant's account can never see another restaurant's balance.
  useEffect(() => {
    if (!restaurant?.id || !isLoggedIn) {
      // Invalidate anything in flight so its result cannot land after this.
      // Clearing the in-flight ref alongside the counter is what stops it
      // sticking: the invalidated request returns down the stale path, which
      // deliberately leaves the ref set for whoever superseded it — and here
      // nobody did, so this branch has to release it.
      profileReqRef.current++
      profileInFlightRef.current = false
      setProfile(null)
      setProfileLoading(false)
      return
    }
    loadProfileFor(restaurant.id)
  }, [restaurant?.id, isLoggedIn, loadProfileFor])

  // Re-read the balance after the client itself has moved it. Silent, because
  // the page is already painted by the time anything calls this.
  const refreshProfile = useCallback(() => {
    if (restaurant?.id && isLoggedIn) loadProfileFor(restaurant.id, { silent: true })
  }, [restaurant?.id, isLoggedIn, loadProfileFor])

  // Backgrounded → returned: re-read the balance. Same shape as useRestaurant's
  // refetch (useRestaurant.js:161-167) and here for the same reason — the
  // server moved while we weren't looking.
  //
  // This is the only cover for the four changes that have no client event at
  // all: the accrual trigger when an order's items land, the refund reversal
  // (081), expire_stale_redemptions returning points from an abandoned cart,
  // and a cancel from CartSheet. A customer who orders, gets the confirmation
  // and comes back sees the points they just earned.
  //
  // Registration is gated on isLoggedIn, not just the handler, so a signed-out
  // visitor never attaches a listener at all — the profile endpoint costs
  // three queries and a last_seen_at write, and refocus is frequent on mobile.
  // The in-flight guard keeps a slow request from collecting a queue of
  // duplicates behind it when someone flicks between apps.
  useEffect(() => {
    if (!restaurant?.id || !isLoggedIn) return
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (profileInFlightRef.current) return
      loadProfileFor(restaurant.id, { silent: true })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [restaurant?.id, isLoggedIn, loadProfileFor])

  // Monotonic id for the in-flight history request. A retry, a restaurant
  // change and the initial load all share one fetch function, so the counter
  // is what decides which result owns the state — the cancelled-flag closure
  // this replaces could only see its own effect run, not a retry racing it.
  const historyReqRef = useRef(0)

  // Same scoping as the profile above, and the same reason for separate flags
  // rather than inferring from the result: loadHistory resolves to null on ANY
  // failure (useCustomerAuth.jsx:283, :286), which is indistinguishable both
  // from "not fetched yet" and from a genuinely empty account. Two booleans
  // carry what the null cannot — one for in-flight, one for failed — because
  // "no orders yet" and "we could not load your orders" need different copy
  // and only one of them deserves a retry.
  //
  // historyFailed resets on entry so a second failure re-enters the error
  // state cleanly rather than sticking on the first one's value.
  const loadHistoryFor = useCallback(async (restaurantId) => {
    const reqId = ++historyReqRef.current
    setHistoryFailed(false)
    setHistoryLoading(true)
    const h = await loadHistory(restaurantId)
    // A newer request has taken ownership; this result is stale.
    if (historyReqRef.current !== reqId) return
    setHistory(h)
    setHistoryFailed(h === null)
    setHistoryLoading(false)
  }, [loadHistory])

  // Deliberately outside the page's load gate: the rest of the page renders
  // without it.
  useEffect(() => {
    if (!restaurant?.id || !isLoggedIn) {
      // Invalidate anything in flight so its result cannot land after this.
      historyReqRef.current++
      setHistory(null)
      setHistoryLoading(false)
      setHistoryFailed(false)
      return
    }
    loadHistoryFor(restaurant.id)
  }, [restaurant?.id, isLoggedIn, loadHistoryFor])

  // Same shape as useRestaurant's retry (useRestaurant.js:152) — zero-arg, so
  // it hands straight to an onClick without a wrapper at the call site.
  const retryHistory = useCallback(() => {
    if (restaurant?.id) loadHistoryFor(restaurant.id)
  }, [restaurant?.id, loadHistoryFor])

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

  // Rebuilds the order against today's menu, then hands off to the ordering
  // flow. Appends to whatever is already in the cart — the confirm-or-replace
  // prompt for a non-empty cart is a follow-up.
  async function handleReorder(order) {
    try {
      const { lines, dropped } = await resolveOrderToCart(supabase, restaurant.id, order)

      if (lines.length === 0) {
        toast.error("Those items aren't available right now")
        return
      }

      lines.forEach(addItem)

      if (dropped.length > 0) {
        toast(
          `${lines.length} item${lines.length === 1 ? '' : 's'} added · ${dropped.join(', ')} unavailable`
        )
      }

      navigate(`/${slug}`)
    } catch {
      toast.error('Could not rebuild that order')
    }
  }

  const handleRedeem = useCallback(async (reward) => {
    if (!reward?.id || !slug) return
    const res = await redeemReward(slug, reward.id)
    if (!res.ok) {
      const messages = {
        redemption_in_progress: 'You already have a reward in your cart. Remove it to choose a different one.',
        insufficient_points: 'Not enough points for that reward yet.',
        reward_unavailable: "That reward isn't available right now.",
        loyalty_disabled: 'Rewards are not available at this restaurant.',
        unauthorized: 'Please sign in again.',
      }
      toast.error(messages[res.error] || 'Could not apply that reward. Please try again.')
      return
    }

    // The RPC has already deducted the points, so the balance on screen is now
    // one redemption out of date. Not awaited: the redemption succeeded
    // server-side regardless, and holding the cart insert on a read would slow
    // the button for no gain.
    //
    // Only this page and the CartSheet cancel move the balance from the
    // client, and the cancel is deliberately left alone — CartSheet has no
    // profile and no loadProfile, so wiring it would mean either caching the
    // profile in the provider (rejected: it would have to be keyed per
    // restaurant and invalidated on every trigger below) or threading a
    // callback down through MenuPage. Its staleness lands on the hero pill and
    // clears on the next mount.
    refreshProfile()

    // An item reward becomes a cart line at zero. A discount reward carries
    // no menu item, so it becomes a marker line — priced at zero, with the
    // money coming off once in the totals, driven by the redemption row the
    // server reads at payment time.
    const rw = res.reward || {}
    addItem({
      menuItemId: rw.menu_item_id || null,
      itemSizeId: rw.item_size_id || null,
      itemName: rw.name || 'Reward',
      sizeName: null,
      basePrice: 0,
      fullBasePrice: 0,
      quantity: 1,
      discount_exempt: true,
      specialInstructions: null,
      toppings: [],
      loyaltyRedemptionId: res.redemption_id,
      loyaltyPointsSpent: rw.points_cost || 0,
      loyaltyRewardKind: rw.kind || null,
      loyaltyDiscountCents: rw.discount_cents || 0,
      loyaltyMinSubtotalCents: rw.min_subtotal_cents || 0,
    })

    navigate(`/${slug}`)
  }, [slug, redeemReward, addItem, navigate, refreshProfile])

  // Navigate BEFORE revoking. logout clears customerId, which re-renders this
  // page into its signed-out redirect below — on a loyalty restaurant that
  // flashes the marketing page on the way out. CustomerAuthProvider is mounted
  // above the router (App.jsx), so it outlives this page and the revoke plus
  // the state clear both complete after we have left.
  const handleSignOut = useCallback(async () => {
    navigate(`/${slug}`)
    await logout()
  }, [logout, navigate, slug])

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

  // Only reachable once auth has settled — authLoading is part of the gate
  // above, so isLoggedIn here is a real answer rather than "not yet known".
  // Without that ordering this would bounce a signed-in customer to the
  // marketing page during their own session check. `replace` so the bounce
  // leaves no history entry to walk back into.
  if (!isLoggedIn) {
    return <Navigate to={loyaltyEnabled ? `/${slug}/rewards` : `/${slug}`} replace />
  }

  const customer = profile
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
      {/* Floating back button in place of a sticky header bar — it lives in the
          page gutter rather than the centred content column, so on a wide
          screen it lands at the far left where the bar had it. */}
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
        <AccountView
          restaurant={restaurant}
          loyaltyEnabled={loyaltyEnabled}
          tiers={tiers}
          rewards={rewards}
          customer={customer}
          orders={history?.orders ?? []}
          transactions={history?.transactions ?? []}
          historyLoading={historyLoading}
          historyFailed={historyFailed}
          onRetryHistory={retryHistory}
          onReorder={handleReorder}
          onRedeem={handleRedeem}
          onStartOrder={() => navigate(`/${slug}`)}
          onSignOut={handleSignOut}
        />
      </div>
    </div>
  )
}
