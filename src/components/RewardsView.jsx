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

// Falling-particle geometry, one layout per tier_level (cycled), so the three
// headers never read as copies and a re-render never reshuffles them.
//
// Depth of field is the whole trick: LARGE particles are blurred and dim (near
// the lens, out of focus), SMALL ones are sharp and brighter (far away, in
// focus). Nothing is both large and sharp.
//
// Entries are paired — 0/1, 2/3, 4/5, 6/7 — sharing a duration with delays
// offset by exactly half of it, so each pair keeps one particle on screen at
// all times and the total count never visibly thins or clumps. Durations are
// distinct within a layout so the columns don't resynchronise.
const EMOJI_LAYOUTS = [
  [
    { left: '6%',   size: 34, opacity: 0.37, blur: 2, r0: '-8deg',  r1: '172deg',  duration: 27, delay: -2 },
    { left: '58%',  size: 18, opacity: 0.53, blur: 0, r0: '12deg',  r1: '-148deg', duration: 27, delay: -15.5 },
    { left: '-3%',  size: 16, opacity: 0.49, blur: 0, r0: '24deg',  r1: '206deg',  duration: 33, delay: -7 },
    { left: '44%',  size: 42, opacity: 0.34, blur: 3, r0: '-16deg', r1: '124deg',  duration: 33, delay: -23.5 },
    { left: '78%',  size: 20, opacity: 0.55, blur: 0, r0: '4deg',   r1: '-192deg', duration: 21, delay: -5 },
    { left: '24%',  size: 15, opacity: 0.47, blur: 0, r0: '-20deg', r1: '158deg',  duration: 21, delay: -15.5 },
    { left: '91%',  size: 28, opacity: 0.41, blur: 1, r0: '16deg',  r1: '-134deg', duration: 39, delay: -11 },
    { left: '36%',  size: 22, opacity: 0.51, blur: 0, r0: '-6deg',  r1: '188deg',  duration: 39, delay: -30.5 },
  ],
  [
    { left: '9%',   size: 20, opacity: 0.52, blur: 0, r0: '18deg',  r1: '-166deg', duration: 31, delay: -6 },
    { left: '62%',  size: 38, opacity: 0.36, blur: 2, r0: '-12deg', r1: '142deg',  duration: 31, delay: -21.5 },
    { left: '-4%',  size: 30, opacity: 0.39, blur: 2, r0: '8deg',   r1: '-118deg', duration: 23, delay: -3 },
    { left: '47%',  size: 16, opacity: 0.50, blur: 0, r0: '-22deg', r1: '214deg',  duration: 23, delay: -14.5 },
    { left: '84%',  size: 48, opacity: 0.34, blur: 3, r0: '14deg',  r1: '132deg',  duration: 45, delay: -13 },
    { left: '30%',  size: 14, opacity: 0.55, blur: 0, r0: '-4deg',  r1: '-198deg', duration: 45, delay: -35.5 },
    { left: '93%',  size: 17, opacity: 0.47, blur: 0, r0: '26deg',  r1: '176deg',  duration: 29, delay: -8 },
    { left: '38%',  size: 26, opacity: 0.41, blur: 1, r0: '-18deg', r1: '-128deg', duration: 29, delay: -22.5 },
  ],
  [
    { left: '4%',   size: 26, opacity: 0.39, blur: 1, r0: '10deg',  r1: '-154deg', duration: 35, delay: -9 },
    { left: '55%',  size: 15, opacity: 0.52, blur: 0, r0: '-14deg', r1: '202deg',  duration: 35, delay: -26.5 },
    { left: '-2%',  size: 19, opacity: 0.50, blur: 0, r0: '20deg',  r1: '-182deg', duration: 27, delay: -5 },
    { left: '71%',  size: 44, opacity: 0.34, blur: 3, r0: '-10deg', r1: '136deg',  duration: 27, delay: -18.5 },
    { left: '88%',  size: 22, opacity: 0.47, blur: 0, r0: '6deg',   r1: '168deg',  duration: 43, delay: -14 },
    { left: '20%',  size: 36, opacity: 0.36, blur: 2, r0: '-24deg', r1: '-122deg', duration: 43, delay: -35.5 },
    { left: '40%',  size: 16, opacity: 0.55, blur: 0, r0: '22deg',  r1: '-210deg', duration: 37, delay: -2 },
    { left: '95%',  size: 30, opacity: 0.41, blur: 2, r0: '-2deg',  r1: '146deg',  duration: 37, delay: -20.5 },
  ],
]

// Offset so the three cards never pulse in sync.
const GLOW_DELAYS = [-4, -11, -19]

const PARTICLE_CSS = `
@keyframes ordr-pfall { from { transform: translateY(-56px) rotate(var(--r0)); } to { transform: translateY(214px) rotate(var(--r1)); } }
@keyframes ordr-glow { 0% { transform: translate(-14%, -8%) scale(1); } 50% { transform: translate(16%, 10%) scale(1.22); } 100% { transform: translate(-14%, -8%) scale(1); } }
.ordr-pfe { position: absolute; top: 0; line-height: 1; pointer-events: none; user-select: none; will-change: transform; animation-name: ordr-pfall; animation-timing-function: linear; animation-iteration-count: infinite; }
.ordr-glow { position: absolute; inset: -30%; border-radius: 50%; pointer-events: none; animation: ordr-glow 26s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ordr-pfe, .ordr-glow { animation: none !important; } }
`

const HOW_IT_WORKS = [
  { title: 'Order',  detail: 'Use your phone number at checkout' },
  { title: 'Earn',   detail: 'Points add up automatically' },
  { title: 'Redeem', detail: 'Online or at the counter' },
]

// Rendered once and reused by both the mobile carousel and the desktop grid.
function TierCard({ tier, brandColor, emojiChars, pointsPerDollar, isCurrent }) {
  const level = Number(tier.tier_level) || 1
  const layout = EMOJI_LAYOUTS[(level - 1) % EMOJI_LAYOUTS.length]
  const color = tier.color || brandColor
  const multiplier = Number(tier.multiplier) || 1
  const percentFaster = Math.round((multiplier - 1) * 100)

  const explainer = level === 1
    ? `Everyone starts here. ${pointsPerDollar} point${pointsPerDollar === 1 ? '' : 's'} per dollar.`
    : `Reach ${formatPoints(tier.threshold_points)} lifetime points and earn ${percentFaster}% faster on every order.`

  return (
    <div
      className="rounded-2xl overflow-hidden border border-gray-200 bg-white"
      style={isCurrent ? { boxShadow: `0 0 0 2px ${brandColor}` } : undefined}
    >
      <div
        className="relative overflow-hidden min-h-[168px] px-[18px] py-5 flex items-end"
        style={{ backgroundColor: color, backgroundImage: tierGradient(color) }}
      >
        <div
          className="ordr-glow"
          style={{
            background: 'radial-gradient(circle at 40% 20%, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0) 60%)',
            animationDelay: `${GLOW_DELAYS[(level - 1) % GLOW_DELAYS.length]}s`,
          }}
        />
        {emojiChars.length > 0 && layout.map((p, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="ordr-pfe"
            style={{
              left: p.left,
              fontSize: `${p.size}px`,
              opacity: p.opacity,
              animationDuration: `${p.duration}s`,
              animationDelay: `${p.delay}s`,
              '--r0': p.r0,
              '--r1': p.r1,
              filter: p.blur > 0
                ? `grayscale(1) brightness(1.45) contrast(0.72) blur(${p.blur}px)`
                : 'grayscale(1) brightness(1.65) contrast(0.85)',
            }}
          >
            {emojiChars[i % emojiChars.length]}
          </span>
        ))}
        <div className="relative">
          <p className="text-[10px] uppercase tracking-[0.18em] text-white/55">Tier {level}</p>
          <p className="text-[26px] font-medium text-white tracking-[-0.01em]">{tier.name}</p>
          <p className="text-[13px] text-white/70">{multiplier}× points</p>
        </div>
      </div>

      <div className="p-4 px-[18px]">
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
  // Derived once: the headline and the balance block's fallback subline are
  // the same value, so they can't drift apart.
  const programName = restaurant.loyalty_program_name || ''
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

  // Order count is the warmer line, so it wins when we have one; the program
  // name is the fallback for a customer whose first order hasn't landed yet.
  const orderCount = Number(customer?.orderCount) || 0
  const subline = orderCount > 0
    ? `You've ordered ${orderCount} time${orderCount === 1 ? '' : 's'} with us`
    : programName ? `Welcome to ${programName}` : 'Welcome'

  const ctaLabel = customer ? 'Claim rewards' : 'Sign in to see your points'
  const ctaClassName = 'w-full h-12 rounded-xl text-white font-semibold flex items-center justify-center'
  const ctaStyle = { backgroundColor: brandColor }

  return (
    <div className="pb-28">
      <style>{PARTICLE_CSS}</style>

      {/* ── 1. Header ── */}
      <header className="text-center">
        {/* The program name is entered per restaurant rather than derived from
            restaurants.name — the legal business name is usually too long to
            work as a program title. */}
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mt-1">
          {programName || 'Rewards'}
        </h1>
        <p className="text-gray-500 mt-3">
          Earn points on every order. Redeem them for free food or credit — online or in the shop.
        </p>
      </header>

      {/* ── 2. Personal panel (signed in) ── */}
      {customer ? (
        <section className="mt-10">
          {/* Greeting and balance are one solid brand block — as loose text
              above a tinted card they read as two unrelated things. */}
          <div className="rounded-2xl px-5 py-5" style={{ backgroundColor: brandColor }}>
            <p className="text-base font-semibold text-white">Hi {customer.displayName || 'there'}</p>
            <p className="text-xs text-white/70 mt-0.5">{subline}</p>

            <p className="text-[10px] tracking-[0.16em] text-white/70 mt-5">AVAILABLE TO SPEND</p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-5xl font-bold text-white tracking-[-0.03em]">
                {formatPoints(customer.pointsBalance)}
              </span>
              <span className="text-[15px] text-white/85">points</span>
            </div>
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
          {/* Three across at every breakpoint — the copy is short enough that
              stacking to a column on mobile would only add scroll. */}
          <div className="flex gap-2 sm:gap-3">
            {HOW_IT_WORKS.map((step, i) => (
              <div
                key={i}
                className="flex-1 relative overflow-hidden rounded-xl px-2 py-2.5 sm:px-4 sm:py-4 min-h-[62px] sm:min-h-[84px]"
                style={{ backgroundColor: brandColor }}
              >
                {/* Top-right on a filled card: at the bottom the number sits
                    under the detail text, which no longer has a white
                    background to stay legible against. Any bleed past the
                    card's edge belongs at the bottom, below the text, not
                    across the top of the digit. */}
                <span
                  className="absolute right-2 top-0 text-[40px] sm:text-[62px] font-bold leading-none tracking-[-0.04em] pointer-events-none select-none"
                  style={{ color: 'rgba(255,255,255,0.18)' }}
                >
                  {i + 1}
                </span>
                <p className="relative text-[13px] font-semibold text-white mb-1">{step.title}</p>
                <p className="relative text-xs text-white/75 leading-snug">{step.detail}</p>
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
          {/* The current-tier card carries a 2px ring, which overflow-x clips.
              pt-1 gives it room at the top (pb-2 already covers the bottom),
              and the bleed's padding runs 2px past the page gutter so the
              first card's ring clears the left edge too. */}
          <div className="md:hidden flex gap-4 overflow-x-auto snap-x snap-mandatory scroll-pl-[26px] pt-1 pb-2 -mx-6 pl-[26px] pr-6">
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
          <div className="hidden md:grid md:grid-cols-3 gap-4 py-1">
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

      {/* ── 6. CTA — fixed to the viewport, matching CartButton in the
             ordering flow. The wrapper's pb-28 keeps the last section clear. ── */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-gray-200 px-5 py-3">
        <div className="max-w-[720px] mx-auto">
          {signInHref && !onSignIn ? (
            <a href={signInHref} className={ctaClassName} style={ctaStyle}>{ctaLabel}</a>
          ) : (
            <button onClick={onSignIn} className={ctaClassName} style={ctaStyle}>{ctaLabel}</button>
          )}
        </div>
      </div>
    </div>
  )
}
