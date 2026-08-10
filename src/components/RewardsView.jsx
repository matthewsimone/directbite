// Presentational only — every value arrives as a prop. Deliberately calls NO
// context hooks (in particular not useCustomerAuth), so this renders unchanged
// on a custom domain, where CustomerAuthProvider is not mounted.

import { useState } from 'react'

import LogoFrame from './LogoFrame'

const DEFAULT_BRAND_COLOR = '#16A34A'

function formatPoints(n) { return Number(n || 0).toLocaleString('en-US') }

// Lighten (amount > 0) or darken (amount < 0) a #RRGGBB color by that fraction
// of the distance to white/black. Returns the input untouched when it isn't a
// 6-digit hex, so a CSS keyword still renders.
function shadeHex(hex, amount) {
  if (!/^#([0-9a-f]{6})$/i.test(hex || '')) return hex
  const n = parseInt(hex.slice(1), 16)
  const target = amount >= 0 ? 255 : 0
  const mix = c => Math.max(0, Math.min(255, Math.round(c + (target - c) * Math.abs(amount))))
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

// Depth for the tier header: lit from the top-left, falling away to a deeper
// shade at the bottom-right. Unparseable input has nothing to interpolate, so
// it falls back to the flat color.
function tierGradient(hex) {
  if (!/^#([0-9a-f]{6})$/i.test(hex || '')) return hex
  return `linear-gradient(155deg, ${shadeHex(hex, 0.22)} 0%, ${hex} 45%, ${shadeHex(hex, -0.38)} 100%)`
}

// Offset so the three cards never pulse in sync.
const GLOW_DELAYS = [-4, -11, -19]

const PARTICLE_CSS = `
@keyframes ordr-glow { 0% { transform: translate(-14%, -8%) scale(1); } 50% { transform: translate(16%, 10%) scale(1.22); } 100% { transform: translate(-14%, -8%) scale(1); } }
.ordr-glow { position: absolute; inset: -30%; border-radius: 50%; pointer-events: none; animation: ordr-glow 26s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ordr-glow { animation: none !important; } }
`

const HOW_IT_WORKS = [
  { title: 'Order',  detail: 'Use your phone number at checkout' },
  { title: 'Earn',   detail: 'Points add up automatically' },
  { title: 'Redeem', detail: 'Online or at the counter' },
]

// Paired with HOW_IT_WORKS by index — phone, bag, gift. Kept separate so the
// copy above stays a plain content list.
const HOW_IT_WORKS_ICONS = [
  'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2',
  'M6 7h12l-1 13H7L6 7z M9 7V5a3 3 0 0 1 6 0v2',
  'M20 11v9H4v-9 M2 7h20v4H2z M12 22V7 M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7z M12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z',
]

// One row of the tier ladder: the full card's gradient and glow, reduced to a
// strip that reads at a glance in a narrow column.
function CompactTierRow({ tier, brandColor, pointsPerDollar, isCurrent }) {
  const level = Number(tier.tier_level) || 1
  const color = tier.color || brandColor
  const multiplier = Number(tier.multiplier) || 1
  // Round through an integer so 1.1× at 3 pts/$ reads 3.3, not 3.3000000000000003.
  const rate = Math.round(multiplier * pointsPerDollar * 10) / 10

  return (
    <div
      className="relative overflow-hidden rounded-xl px-3.5 py-3"
      style={{
        backgroundColor: color,
        backgroundImage: tierGradient(color),
        ...(isCurrent ? { boxShadow: `0 0 0 2px ${brandColor}` } : {}),
      }}
    >
      <div
        className="ordr-glow"
        style={{
          background: 'radial-gradient(circle at 40% 20%, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0) 60%)',
          animationDelay: `${GLOW_DELAYS[(level - 1) % GLOW_DELAYS.length]}s`,
        }}
      />
      <div className="relative flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-medium text-white">{tier.name}</p>
          <p className="text-[11px] text-white/75">{rate} points per $1</p>
        </div>
        {isCurrent ? (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white/25 text-white shrink-0 ml-2">
            You're here
          </span>
        ) : (
          <span className="text-[11px] text-white/75 shrink-0">
            {formatPoints(tier.threshold_points)} pts
          </span>
        )}
      </div>
    </div>
  )
}

export default function RewardsView({ restaurant, tiers = [], rewards = [], customer = null, onSignIn, signInHref }) {
  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR
  // The balance card reuses the website hero's photo and logo — useRestaurant
  // selects '*', so these arrive on the same restaurant row.
  const { hero_image_url, logo_url, logo_frame_shape, name } = restaurant
  // Entered per restaurant rather than derived from restaurants.name — the
  // legal business name is usually too long to work as a program title.
  const programName = restaurant.loyalty_program_name || ''
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

  // Reward split for the signed-in panel — the same balance >= cost test the
  // signed-out catalog rows use, hoisted so both lists share one comparison.
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

  const ctaLabel = customer ? 'Claim rewards' : 'Sign in to see your points'
  const ctaClassName = 'w-full h-12 rounded-xl text-white font-semibold flex items-center justify-center'
  const ctaStyle = { backgroundColor: brandColor }

  return (
    <div className={`${customer ? 'pb-10' : 'pb-28'}`}>
      <style>{PARTICLE_CSS}</style>

      {/* ── 2. Personal panel (signed in) ── */}
      {customer ? (
        <section className="mt-2">
          {/* Greeting and balance sit on the restaurant's own hero image, under
              the same overlay the website hero uses, so the two surfaces read
              as one brand rather than two. */}
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
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/30 to-black/60" />

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

            <div className="relative z-10 flex flex-col justify-end min-h-[196px] px-6 pb-6 pt-6">
              <p className="text-xl font-semibold text-white">
                {[
                  customer.displayName || 'there',
                  orderCount > 0 ? `${orderCount} order${orderCount === 1 ? '' : 's'}` : null,
                ].filter(Boolean).join(' · ')}
              </p>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-6xl font-bold text-white tracking-[-0.03em]">
                  {formatPoints(customer.pointsBalance)}
                </span>
                <span className="text-[17px] text-white/85">points</span>
              </div>

              <div
                className="h-[6px] rounded-full overflow-hidden mt-3"
                style={{ backgroundColor: 'rgba(255,255,255,0.55)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${rewardProgressPct}%`, backgroundColor: brandColor }}
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
          </div>

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
                          className="rounded-xl border px-3 py-2.5 flex justify-between items-center"
                          style={{ borderColor: brandColor }}
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{rw.name}</p>
                            <p className="text-xs text-gray-500">
                              {formatPoints(Number(rw.points_cost) || 0)} pts
                            </p>
                          </div>
                          <button
                            type="button"
                            className="text-xs font-medium text-white px-3 py-1.5 rounded-lg"
                            style={{ backgroundColor: brandColor }}
                          >
                            Redeem
                          </button>
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
                            className="rounded-xl border border-gray-200 px-3 py-2.5 flex justify-between items-center"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{rw.name}</p>
                              <p className="text-xs text-gray-500">{formatPoints(cost)} pts</p>
                            </div>
                            <span className="bg-gray-100 text-gray-600 text-[11px] px-2.5 py-1 rounded-full">
                              {formatPoints(shortBy)} away
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* Right: current tier, with the full ladder behind a disclosure. */}
              <div>
                <h2 className="text-sm font-medium text-gray-900 mb-2">Your tier</h2>
                {/* Tier progress needs a tier ladder to measure against — with no
                    tier rows configured there is nothing meaningful to show. */}
                {tiers.length > 0 && (
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
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-sm text-gray-500">Your past orders will show up here.</p>
              <button
                type="button"
                className="h-11 px-6 rounded-xl text-white font-medium mt-4"
                style={{ backgroundColor: brandColor }}
              >
                Start an order
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* ── 1. Hero card (signed out only — the signed-in state leads with
                 the balance card instead) ── */}
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
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/30 to-black/60" />

            <div className="absolute top-6 left-0 right-0 flex justify-center z-10">
              <LogoFrame
                logoUrl={logo_url}
                shape={logo_frame_shape}
                name={name}
                brandColor={brandColor}
                sizePx={96}
                marginCls=""
              />
            </div>

            <div className="relative z-10 flex flex-col justify-end min-h-[260px] px-6 pb-7 pt-7 text-center">
              {/* The program name is entered per restaurant rather than derived from
                  restaurants.name — the legal business name is usually too long to
                  work as a program title. */}
              {programName && (
                <p className="text-[11px] tracking-[0.16em] uppercase text-white/80">
                  {programName}
                </p>
              )}
              <h1 className="text-[26px] sm:text-[30px] font-semibold text-white leading-tight mt-1.5">
                Earn points on every order. Redeem them for free food or credit — online or in the shop.
              </h1>
            </div>
          </div>

          {/* Catalog leads on both axes — first in source so it stacks above
              how-it-works on mobile, and in the wider column on desktop. */}
          <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr] gap-6 mt-8">
            {/* ── 5. Rewards catalog (signed out — the signed-in state splits this
                   into Ready to redeem / Keep going inside the rewards panel) ── */}
            {rewards.length > 0 && (
              <section>
                <h2 className="text-[15px] font-medium text-gray-900 mb-2.5">What you can get</h2>
                <div className="space-y-2">
                  {rewards.map(rw => (
                    <div
                      key={rw.id}
                      className="rounded-xl border border-gray-200 px-3.5 py-3 flex justify-between items-center gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{rw.name}</p>
                        {rw.description && (
                          <p className="text-xs text-gray-500">{rw.description}</p>
                        )}
                      </div>
                      <span className="text-sm font-medium shrink-0" style={{ color: brandColor }}>
                        {formatPoints(Number(rw.points_cost) || 0)} pts
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── 3. How it works (signed out) ── */}
            <section>
              <h2 className="text-[15px] font-medium text-gray-900 mb-2.5">How it works</h2>
              <div className="space-y-3">
                {HOW_IT_WORKS.map((step, i) => (
                  <div key={i} className="flex gap-2.5 items-start">
                    <svg
                      className="w-[18px] h-[18px] shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                      style={{ color: brandColor }}
                    >
                      <path d={HOW_IT_WORKS_ICONS[i]} />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{step.title}</p>
                      <p className="text-xs text-gray-500">{step.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* ── 7. Tier ladder (signed out) ── */}
          {tiers.length > 0 && (
            <section className="mt-8">
              <h2 className="text-[15px] font-medium text-gray-900 mb-3">Order more, earn faster</h2>
              <div className="grid grid-cols-3 gap-2">
                {tiers.map(tier => (
                  <CompactTierRow
                    key={tier.id}
                    tier={tier}
                    brandColor={brandColor}
                    pointsPerDollar={pointsPerDollar}
                    isCurrent={false}
                  />
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Based on points earned all-time. You never drop a tier.
              </p>
            </section>
          )}
        </>
      )}

      {/* ── 6. CTA — signed out only: its one job is sign-in, and the wrapper's
             pb-28 reserves the space it occupies. Fixed to the viewport,
             matching CartButton in the ordering flow. ── */}
      {!customer && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-gray-200 px-5 py-3">
          <div className="max-w-[720px] mx-auto">
            {signInHref && !onSignIn ? (
              <a href={signInHref} className={ctaClassName} style={ctaStyle}>{ctaLabel}</a>
            ) : (
              <button onClick={onSignIn} className={ctaClassName} style={ctaStyle}>{ctaLabel}</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
