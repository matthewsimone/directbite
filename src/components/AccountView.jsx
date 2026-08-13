// The signed-in account surface. Presentational only — every value arrives as
// a prop, and this calls NO context hooks (in particular not useCustomerAuth),
// matching RewardsView so both can render on a custom domain where
// CustomerAuthProvider is not mounted.
//
// Two configurations off one component:
//   loyaltyEnabled true  — the full rewards surface: points hero, Rewards |
//                          Orders tabs, redeem, tiers, ledger.
//   loyaltyEnabled false — a plain account page: greeting hero, Recent Orders,
//                          reorder. No points anywhere, because there are none.

import { useState, useEffect } from 'react'

import LogoFrame from './LogoFrame'
import {
  DEFAULT_BRAND_COLOR,
  CARD_SCRIM,
  PARTICLE_CSS,
  CompactTierRow,
  RewardThumb,
  formatDay,
  formatPoints,
  humanizeReason,
  titleCase,
  useCountUp,
} from './rewardsShared'

export default function AccountView({
  restaurant,
  loyaltyEnabled = false,
  tiers = [],
  rewards = [],
  customer = null,
  orders = [],
  transactions = [],
  historyLoading = false,
  onReorder = () => {},
  onRedeem = () => {},
  onStartOrder = () => {},
  onSignOut = () => {},
}) {
  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR
  // The balance card reuses the website hero's photo and logo — useRestaurant
  // selects '*', so these arrive on the same restaurant row.
  const { hero_image_url, logo_url, logo_frame_shape, name } = restaurant
  const pointsPerDollar = Number(restaurant.loyalty_points_per_dollar) || 0

  const currentTier = customer
    ? tiers.find(t => Number(t.tier_level) === Number(customer.tierLevel)) || null
    : null
  // tiers arrive ordered by tier_level, so the first one above the customer's
  // level is the next one they'll reach.
  const nextTier = customer
    ? tiers.find(t => Number(t.tier_level) > Number(customer.tierLevel)) || null
    : null
  const atTopTier = Boolean(customer) && tiers.length > 0 && !nextTier

  const lifetime = Number(customer?.lifetimePoints) || 0
  const nextThreshold = Number(nextTier?.threshold_points) || 0
  const progressPct = atTopTier || !nextThreshold
    ? 100
    : Math.max(0, Math.min(100, (lifetime / nextThreshold) * 100))
  const pointsToNext = Math.max(0, nextThreshold - lifetime)

  const orderCount = Number(customer?.orderCount) || 0
  // Rounded through an integer so the rate reads 3.3, not 3.3000000000000003.
  const nextTierRate = Math.round((Number(nextTier?.multiplier) || 1) * pointsPerDollar * 10) / 10

  const [tab, setTab] = useState('rewards')
  const [tiersOpen, setTiersOpen] = useState(false)
  const [expandedOrders, setExpandedOrders] = useState(() => new Set())
  const [reorderingId, setReorderingId] = useState(null)
  // Holds the reward id currently being redeemed. Local in-flight state only —
  // the redemption itself belongs to the caller via onRedeem.
  const [redeeming, setRedeeming] = useState(null)

  // Reward split for the rewards panel — one balance >= cost comparison,
  // hoisted so both lists share it.
  const pointsBalance = Number(customer?.pointsBalance) || 0
  const readyRewards = rewards.filter(rw => (Number(rw.points_cost) || 0) <= pointsBalance)
  const keepGoingRewards = rewards.filter(rw => (Number(rw.points_cost) || 0) > pointsBalance)

  // The balance card's bar tracks the nearest reward rather than the next tier
  // — the cheapest thing this balance can't cover yet. Everything in
  // keepGoingRewards costs more than the balance, so points_cost is always > 0
  // here and the percentage can't divide by zero.
  const nextReward = keepGoingRewards.reduce(
    (cheapest, rw) =>
      !cheapest || (Number(rw.points_cost) || 0) < (Number(cheapest.points_cost) || 0) ? rw : cheapest,
    null,
  )
  const rewardShortfall = Math.max(0, (Number(nextReward?.points_cost) || 0) - pointsBalance)
  const rewardProgressPct = nextReward
    ? Math.max(0, Math.min(100, (pointsBalance / (Number(nextReward.points_cost) || 0)) * 100))
    : 100

  // Hooks can't be called conditionally, so these run for both configurations
  // even though only the loyalty hero reads them.
  const animatedPoints = useCountUp(Number(customer?.pointsBalance) || 0)
  const [barReady, setBarReady] = useState(false)
  // The first paint has to land at 0 width or the transition has nothing to
  // animate from; rAF defers the flip to the frame after that paint.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setBarReady(true))
    return () => cancelAnimationFrame(raf)
  }, [rewardProgressPct])

  // A customer who has never given a name still gets addressed. The old
  // greeting joined name and order count with a separator, so an empty name
  // rendered a leading "· 287 orders" with nothing in front of it.
  const firstName = (customer?.displayName || '').trim()
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,'

  // The order list is the whole page when loyalty is off, so it renders under
  // its own heading rather than behind a tab.
  const orderList = (
    historyLoading ? (
      <div className="text-center py-12">
        <p className="text-sm text-gray-500">Loading your orders...</p>
      </div>
    ) : orders.length === 0 ? (
      <div className="text-center py-12">
        <p className="text-sm text-gray-500">Your past orders will show up here.</p>
        <button
          type="button"
          onClick={onStartOrder}
          className="h-11 px-6 rounded-xl text-white font-medium mt-4"
          style={{ backgroundColor: brandColor }}
        >
          Start an order
        </button>
      </div>
    ) : (
      <div className="space-y-2 mt-5">
        {orders.map(order => {
          // The ledger row for this order, when the earn landed. Points are
          // keyed off order_id rather than stored on the order. Skipped
          // entirely with loyalty off — there is no ledger to look in.
          const earned = loyaltyEnabled
            ? transactions.find(t => t.order_id === order.id && Number(t.points_delta) > 0)
            : null
          const orderItems = order.order_items || []
          const expanded = expandedOrders.has(order.id)
          const visibleItems = expanded ? orderItems : orderItems.slice(0, 3)
          const hiddenCount = orderItems.length - visibleItems.length
          const reordering = reorderingId === order.id
          return (
            <div key={order.id} className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-3.5 py-3 flex justify-between items-center">
                <p className="text-sm font-medium text-gray-900">{formatDay(order.created_at)}</p>
                <p className="text-xs text-gray-500">
                  {`${titleCase(order.order_type)} · $${Number(order.total_amount || 0).toFixed(2)}`}
                </p>
              </div>

              <div className="px-3.5 pb-3 text-xs text-gray-600">
                {visibleItems.map(item => {
                  const itemToppings = item.order_item_toppings || []
                  return (
                    <div key={item.id}>
                      <p>{`${item.quantity}× ${item.item_name}`}</p>
                      {itemToppings.length > 0 && (
                        <p className="text-[11px] text-gray-500">
                          {itemToppings
                            .map(t =>
                              t.placement === 'whole'
                                ? t.topping_name
                                : `${titleCase(t.placement)}: ${t.topping_name}`
                            )
                            .join(', ')}
                        </p>
                      )}
                    </div>
                  )
                })}
                {(hiddenCount > 0 || expanded) && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedOrders(prev => {
                        const next = new Set(prev)
                        if (next.has(order.id)) next.delete(order.id)
                        else next.add(order.id)
                        return next
                      })
                    }
                    className="text-xs mt-1"
                    style={{ color: brandColor }}
                  >
                    {expanded ? 'Show less' : `+${hiddenCount} more items`}
                  </button>
                )}
              </div>

              <div className="px-3.5 py-2.5 border-t border-gray-100 flex justify-between items-center">
                {earned ? (
                  <span className="text-xs" style={{ color: brandColor }}>
                    {`+${formatPoints(earned.points_delta)} points`}
                  </span>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  disabled={reordering}
                  onClick={async () => {
                    setReorderingId(order.id)
                    try {
                      await onReorder(order)
                    } finally {
                      setReorderingId(null)
                    }
                  }}
                  className="text-xs font-medium text-white px-3 py-1.5 rounded-lg"
                  style={{ backgroundColor: brandColor }}
                >
                  {reordering ? 'Adding...' : 'Reorder'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  )

  return (
    <div className="pb-10">
      <style>{PARTICLE_CSS}</style>

      <section className="mt-2">
        {/* Greeting sits on the restaurant's own hero image, under the same
            overlay the website hero uses, so the two surfaces read as one
            brand rather than two. */}
        <div className="relative rounded-2xl overflow-hidden">
          {/* Background layer — bg-gray-100 is the class-based fallback that
              shows through when the restaurant has no hero image. */}
          <div
            className="absolute inset-0 bg-gray-100 bg-cover bg-center"
            style={{
              ...(hero_image_url ? { backgroundImage: `url(${hero_image_url})` } : {}),
            }}
          />
          {/* Dark gradient overlay — keeps white text legible regardless of image */}
          <div className={CARD_SCRIM} />

          <div className="absolute top-5 right-5 z-10">
            <LogoFrame
              logoUrl={logo_url}
              shape={logo_frame_shape}
              name={name}
              brandColor={brandColor}
              sizePx={64}
              marginCls=""
            />
          </div>

          {loyaltyEnabled ? (
            <div className="relative z-10 flex flex-col justify-end min-h-[196px] px-6 pb-6 pt-6">
              <p className="text-xl font-semibold text-white">
                {[
                  firstName || 'there',
                  orderCount > 0 ? `${orderCount} order${orderCount === 1 ? '' : 's'}` : null,
                ].filter(Boolean).join(' · ')}
              </p>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-6xl font-bold text-white tracking-[-0.03em] tabular-nums">
                  {formatPoints(animatedPoints)}
                </span>
                <span className="text-[17px] text-white/85">points</span>
              </div>

              <div
                className="h-[6px] rounded-full overflow-hidden mt-3"
                style={{ backgroundColor: 'rgba(255,255,255,0.55)' }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-[900ms] ease-out"
                  style={{ width: `${barReady ? rewardProgressPct : 0}%`, backgroundColor: brandColor }}
                />
              </div>

              <p className="text-sm text-white/95 mt-2">
                {nextReward
                  ? `${formatPoints(rewardShortfall)} more points for ${nextReward.name}`
                  : readyRewards.length > 0
                    ? `${formatPoints(readyRewards.length)} reward${readyRewards.length === 1 ? '' : 's'} ready to redeem`
                    : atTopTier || !nextTier
                      ? `${formatPoints(lifetime)} points earned all time`
                      : `${formatPoints(pointsToNext)} more points to reach ${nextTier.name}`}
              </p>
            </div>
          ) : (
            /* No points, no order count, no progress — with loyalty off there
               is no number on this page that means anything. */
            <div className="relative z-10 flex flex-col justify-end min-h-[196px] px-6 pb-6 pt-6">
              <p className="text-3xl font-semibold text-white leading-tight">{greeting}</p>
              <p className="text-lg text-white/90 mt-1">Welcome back</p>
            </div>
          )}
        </div>

        {loyaltyEnabled ? (
          <>
            <div role="tablist" className="flex gap-2 mt-4">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'rewards'}
                onClick={() => setTab('rewards')}
                className={`flex-1 h-10 rounded-full text-sm ${tab === 'rewards' ? 'text-white font-medium' : 'bg-gray-100 text-gray-600'}`}
                style={tab === 'rewards' ? { backgroundColor: brandColor } : undefined}
              >
                Rewards
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'orders'}
                onClick={() => setTab('orders')}
                className={`flex-1 h-10 rounded-full text-sm ${tab === 'orders' ? 'text-white font-medium' : 'bg-gray-100 text-gray-600'}`}
                style={tab === 'orders' ? { backgroundColor: brandColor } : undefined}
              >
                Orders
              </button>
            </div>

            {tab === 'rewards' ? (
              <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr] gap-5 mt-5">
                {/* Left: what this balance already covers, then what it doesn't. */}
                <div>
                  {readyRewards.length > 0 && (
                    <>
                      <h2 className="text-[15px] font-medium text-gray-900">Ready to redeem</h2>
                      <p className="text-xs text-gray-500 mb-2.5">Applied at checkout, one per order.</p>
                      <div className="space-y-2">
                        {readyRewards.map(rw => (
                          <div
                            key={rw.id}
                            className="rounded-xl border overflow-hidden flex items-stretch"
                            style={{ borderColor: brandColor }}
                          >
                            <RewardThumb reward={rw} brandColor={brandColor} widthCls="w-[76px]" />
                            <div className="flex-1 px-3 py-2.5 flex justify-between items-center gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium">{rw.name}</p>
                                <p className="text-xs text-gray-500">
                                  {formatPoints(Number(rw.points_cost) || 0)} pts
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (redeeming) return
                                  setRedeeming(rw.id)
                                  try { await onRedeem(rw) } finally { setRedeeming(null) }
                                }}
                                disabled={redeeming === rw.id}
                                className="text-xs font-medium text-white px-3 py-1.5 rounded-lg"
                                style={{ backgroundColor: brandColor }}
                              >
                                {redeeming === rw.id ? 'Adding…' : 'Redeem'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {keepGoingRewards.length > 0 && (
                    <>
                      <h2 className="text-[15px] font-medium text-gray-900 mt-5 mb-2.5">Keep going</h2>
                      <div className="space-y-2">
                        {keepGoingRewards.map(rw => {
                          const cost = Number(rw.points_cost) || 0
                          const shortBy = Math.max(0, cost - pointsBalance)
                          return (
                            <div
                              key={rw.id}
                              className="rounded-xl border border-gray-200 overflow-hidden flex items-stretch"
                            >
                              <RewardThumb reward={rw} brandColor={brandColor} widthCls="w-[76px]" />
                              <div className="flex-1 px-3 py-2.5 flex justify-between items-center gap-3">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium">{rw.name}</p>
                                  <p className="text-xs text-gray-500">{formatPoints(cost)} pts</p>
                                </div>
                                <span className="bg-gray-100 text-gray-600 text-[11px] px-2.5 py-1 rounded-full">
                                  {formatPoints(shortBy)} away
                                </span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>

                {/* Right: current tier, with the full ladder behind a disclosure.
                    Tier progress needs a tier ladder to measure against, so the
                    heading sits inside the guard with the card it labels — a
                    restaurant with no tier rows gets neither. */}
                <div>
                  {tiers.length > 0 && (
                    <>
                      <h2 className="text-sm font-medium text-gray-900 mb-2">Your tier</h2>
                      <div className="rounded-xl border border-gray-200 bg-white p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: currentTier?.color || brandColor }}
                            />
                            <span className="text-sm font-medium text-gray-900 truncate">
                              {currentTier?.name || `Tier ${customer.tierLevel}`}
                            </span>
                          </div>
                          <span className="text-sm text-gray-500 shrink-0">
                            {atTopTier
                              ? `${formatPoints(lifetime)} lifetime`
                              : `${formatPoints(pointsToNext)} pts to ${nextTier.name}`}
                          </span>
                        </div>

                        <div className="h-2 rounded-full bg-gray-200 overflow-hidden mt-2">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${progressPct}%`, backgroundColor: currentTier?.color || brandColor }}
                          />
                        </div>

                        <p className="text-sm text-gray-500 mt-2">
                          {atTopTier
                            ? "You've reached the top tier."
                            : `${nextTier.name} earns ${nextTierRate} points per $1 instead of ${pointsPerDollar}.`}
                        </p>

                        <div className="border-t border-gray-100 mt-3 pt-3">
                          <button
                            type="button"
                            aria-expanded={tiersOpen}
                            onClick={() => setTiersOpen(open => !open)}
                            className="w-full flex items-center justify-between text-xs"
                            style={{ color: brandColor }}
                          >
                            {tiersOpen ? 'Hide tiers' : 'See all tiers'}
                            <svg
                              className={`w-4 h-4 shrink-0 transition-transform ${tiersOpen ? 'rotate-180' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>

                          {tiersOpen && (
                            <div className="space-y-2 mt-3">
                              {tiers.map(tier => (
                                <CompactTierRow
                                  key={tier.id}
                                  tier={tier}
                                  brandColor={brandColor}
                                  pointsPerDollar={pointsPerDollar}
                                  isCurrent={Boolean(customer) && Number(tier.tier_level) === Number(customer.tierLevel)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {transactions.length > 0 && (
                    <section className="mt-5">
                      <h2 className="text-[15px] font-medium text-gray-900 mb-2.5">Recent points</h2>
                      <div className="rounded-xl border border-gray-200 overflow-hidden">
                        {transactions.map((t, i) => {
                          const delta = Number(t.points_delta) || 0
                          return (
                            <div
                              key={t.id}
                              className={`px-3.5 py-2.5 flex justify-between items-center ${
                                i < transactions.length - 1 ? 'border-b border-gray-100' : ''
                              }`}
                            >
                              <div className="min-w-0">
                                <p className="text-[13px] text-gray-900">{humanizeReason(t.reason)}</p>
                                <p className="text-[11px] text-gray-400">{formatDay(t.created_at)}</p>
                              </div>
                              <span
                                className={`text-[13px] font-medium shrink-0 ${delta > 0 ? '' : 'text-gray-500'}`}
                                style={delta > 0 ? { color: brandColor } : undefined}
                              >
                                {`${delta > 0 ? '+' : ''}${formatPoints(delta)}`}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}
                </div>
              </div>
            ) : (
              orderList
            )}
          </>
        ) : (
          <div className="mt-6">
            <h2 className="text-[15px] font-medium text-gray-900">Recent Orders</h2>
            {orderList}
          </div>
        )}

        <div className="mt-10 pt-6 border-t border-gray-100 text-center">
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Sign out
          </button>
        </div>
      </section>
    </div>
  )
}
