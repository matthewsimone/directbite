// Presentational only — every value arrives as a prop. Deliberately calls NO
// context hooks (in particular not useCustomerAuth), so this renders unchanged
// on a custom domain, where CustomerAuthProvider is not mounted.

const DEFAULT_BRAND_COLOR = '#16A34A'

// Tint a #RRGGBB brand color for card fills. Returns the input untouched when
// it isn't a 6-digit hex, so a CSS keyword or rgb() string still renders.
function withAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function formatPoints(n) { return Number(n || 0).toLocaleString('en-US') }

// Fixed scatter geometry, one entry per tier_level (cycled), so the headers
// don't look identical and a re-render never reshuffles them. Sizes stay
// within 18–40px and opacity within 0.13–0.24.
const EMOJI_LAYOUTS = [
  [
    { top: '8%',  left: '6%',  size: 34, rotate: -12, opacity: 0.20 },
    { top: '46%', left: '62%', size: 22, rotate: 8,   opacity: 0.15 },
    { top: '12%', left: '82%', size: 18, rotate: 20,  opacity: 0.13 },
  ],
  [
    { top: '40%', left: '10%', size: 20, rotate: 14,  opacity: 0.16 },
    { top: '6%',  left: '44%', size: 40, rotate: -8,  opacity: 0.22 },
    { top: '52%', left: '78%', size: 26, rotate: 6,   opacity: 0.14 },
  ],
  [
    { top: '14%', left: '22%', size: 26, rotate: 10,  opacity: 0.18 },
    { top: '50%', left: '44%', size: 18, rotate: -16, opacity: 0.13 },
    { top: '8%',  left: '70%', size: 36, rotate: 4,   opacity: 0.24 },
  ],
]

const HOW_IT_WORKS = [
  'Order with your phone number',
  'Points add up automatically',
  'Redeem online or at the counter',
]

// Rendered once and reused by both the mobile carousel and the desktop grid.
function TierCard({ tier, brandColor, emojiChars, pointsPerDollar, isCurrent }) {
  const level = Number(tier.tier_level) || 1
  const layout = EMOJI_LAYOUTS[(level - 1) % EMOJI_LAYOUTS.length]
  const color = tier.color || brandColor
  const multiplier = Number(tier.multiplier) || 1
  const percentFaster = Math.round((multiplier - 1) * 100)

  const explainer = level === 1
    ? `Everyone starts here. ${pointsPerDollar} point per dollar.`
    : `Reach ${formatPoints(tier.threshold_points)} lifetime points and earn ${percentFaster}% faster on every order.`

  return (
    <div
      className="rounded-2xl overflow-hidden border border-gray-200 bg-white"
      style={isCurrent ? { boxShadow: `0 0 0 2px ${brandColor}` } : undefined}
    >
      <div
        className="relative overflow-hidden min-h-[96px] px-4 py-4"
        style={{ backgroundColor: color }}
      >
        {emojiChars.slice(0, 3).map((ch, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="absolute select-none pointer-events-none leading-none"
            style={{
              top: layout[i].top,
              left: layout[i].left,
              fontSize: `${layout[i].size}px`,
              opacity: layout[i].opacity,
              transform: `rotate(${layout[i].rotate}deg)`,
              filter: 'grayscale(1) brightness(3)',
            }}
          >
            {ch}
          </span>
        ))}
        <div className="relative">
          <p className="text-[10px] uppercase tracking-[0.14em] text-white/70">Tier {level}</p>
          <p className="text-xl font-bold text-white">{tier.name}</p>
          <p className="text-sm text-white/80">{multiplier}× points</p>
        </div>
      </div>

      <div className="p-4">
        <p className="text-sm text-gray-500">{explainer}</p>
        {isCurrent && (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold mt-2"
            style={{ backgroundColor: withAlpha(brandColor, 0.12), color: brandColor }}
          >
            You're here
          </span>
        )}
      </div>
    </div>
  )
}

export default function RewardsView({ restaurant, tiers = [], rewards = [], customer = null, onSignIn, signInHref }) {
  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR
  // Array.from so multi-byte emoji survive — a plain .split('') would tear
  // surrogate pairs in half.
  const emojiChars = Array.from(restaurant.loyalty_emoji || '')
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

  const ctaLabel = customer ? 'Claim rewards' : 'Sign in to see your points'
  const ctaClassName = 'w-full h-12 rounded-xl text-white font-semibold flex items-center justify-center'
  const ctaStyle = { backgroundColor: brandColor }

  return (
    <div>
      {/* ── 1. Header ── */}
      <header className="text-center">
        <p className="text-xs tracking-[0.14em] text-gray-500 uppercase">{restaurant.name}</p>
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mt-1">Rewards</h1>
        <p className="text-gray-500 mt-3">
          Earn points on every order. Redeem them for free food or credit — online or in the shop.
        </p>
      </header>

      {/* ── 2. Personal panel (signed in) ── */}
      {customer ? (
        <section className="mt-10">
          <h2 className="text-2xl font-bold text-gray-900">Hi {customer.displayName || 'there'}</h2>
          {restaurant.loyalty_welcome_message && (
            <p className="text-gray-500 mt-1">{restaurant.loyalty_welcome_message}</p>
          )}

          <div
            className="rounded-2xl p-5 mt-4"
            style={{ backgroundColor: withAlpha(brandColor, 0.08) }}
          >
            <p className="text-xs uppercase tracking-[0.14em] text-gray-500">Available to spend</p>
            <p className="text-5xl font-bold text-gray-900 mt-1">{formatPoints(customer.pointsBalance)}</p>
            <p className="text-sm text-gray-500">points</p>
          </div>

          {/* Tier progress needs a tier ladder to measure against — with no
              tier rows configured there is nothing meaningful to show. */}
          {tiers.length > 0 && (
            <div className="mt-4">
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
                    : `${formatPoints(lifetime)} / ${formatPoints(nextThreshold)} lifetime`}
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
                  : `${formatPoints(pointsToNext)} more points to reach ${nextTier.name} and earn ${Number(nextTier.multiplier) || 1}× on every order.`}
              </p>
            </div>
          )}
        </section>
      ) : (
        /* ── 3. How it works (signed out) ── */
        <section className="mt-10">
          <div className="flex flex-col sm:flex-row gap-4">
            {HOW_IT_WORKS.map((step, i) => (
              <div key={i} className="flex-1 rounded-2xl border border-gray-200 bg-white p-5">
                <p className="text-sm font-bold" style={{ color: brandColor }}>{i + 1}</p>
                <p className="text-sm text-gray-700 mt-2">{step}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 4. Tiers ── */}
      {tiers.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3">Tiers</h2>

          {/* Mobile: horizontal scroll */}
          <div className="md:hidden flex gap-4 overflow-x-auto snap-x snap-mandatory scroll-pl-6 pb-2 -mx-6 px-6">
            {tiers.map(tier => (
              <div key={tier.id} className="snap-start shrink-0 w-[80%]">
                <TierCard
                  tier={tier}
                  brandColor={brandColor}
                  emojiChars={emojiChars}
                  pointsPerDollar={pointsPerDollar}
                  isCurrent={Boolean(customer) && Number(tier.tier_level) === Number(customer.tierLevel)}
                />
              </div>
            ))}
          </div>

          {/* Desktop: 3-column grid */}
          <div className="hidden md:grid md:grid-cols-3 gap-4">
            {tiers.map(tier => (
              <TierCard
                key={tier.id}
                tier={tier}
                brandColor={brandColor}
                emojiChars={emojiChars}
                pointsPerDollar={pointsPerDollar}
                isCurrent={Boolean(customer) && Number(tier.tier_level) === Number(customer.tierLevel)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 5. Rewards catalog ── */}
      {rewards.length > 0 && (
        <section className="mt-10">
          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">What you can get</h2>
            </div>
            <div className="divide-y divide-gray-100">
              {rewards.map(rw => {
                const cost = Number(rw.points_cost) || 0
                const balance = Number(customer?.pointsBalance) || 0
                const canRedeem = Boolean(customer) && balance >= cost
                const shortBy = Math.max(0, cost - balance)
                return (
                  <div key={rw.id} className="px-5 py-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{rw.name}</p>
                      {customer && canRedeem && (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold mt-1"
                          style={{ backgroundColor: withAlpha(brandColor, 0.12), color: brandColor }}
                        >
                          Available now
                        </span>
                      )}
                      {customer && !canRedeem && (
                        <p className="text-xs text-gray-400 mt-1">{formatPoints(shortBy)} points away</p>
                      )}
                    </div>
                    <span className="text-sm font-semibold shrink-0" style={{ color: brandColor }}>
                      {formatPoints(cost)} pts
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* ── 6. CTA ── */}
      <div className="mt-10">
        {signInHref && !onSignIn ? (
          <a href={signInHref} className={ctaClassName} style={ctaStyle}>{ctaLabel}</a>
        ) : (
          <button onClick={onSignIn} className={ctaClassName} style={ctaStyle}>{ctaLabel}</button>
        )}
      </div>
    </div>
  )
}
