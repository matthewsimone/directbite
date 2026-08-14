// Signed-out marketing for a restaurant's loyalty program. Presentational
// only — every value arrives as a prop and this calls no context hooks. The
// caller owns the data and the side effects; this file owns the markup, so it
// can be rendered and reasoned about without a provider around it.
//
// The signed-in surface used to live here behind a `customer` ternary; it is
// now AccountView, on its own route. This file only ever renders for a
// signed-out visitor at a loyalty-enabled restaurant.

import LogoFrame from './LogoFrame'
import {
  DEFAULT_BRAND_COLOR,
  CARD_SCRIM,
  PARTICLE_CSS,
  CompactTierRow,
  RewardThumb,
  formatPoints,
} from './rewardsShared'

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

export default function RewardsView({ restaurant, tiers = [], rewards = [], onSignIn }) {
  // Platform green, not the restaurant's primary_color. The ordering flow is
  // green throughout and says so in three places — CartSheet, CheckoutPage and
  // ConfirmationPage all carry the same note — and a red accent on a green
  // page reads as inconsistent. This surface and AccountView were the last two
  // reading primary_color; both now match the flow they sit in. The name stays
  // brandColor so the usages below are unchanged.
  const brandColor = DEFAULT_BRAND_COLOR
  // The hero card reuses the website hero's photo and logo — useRestaurant
  // selects '*', so these arrive on the same restaurant row.
  const { hero_image_url, logo_url, logo_frame_shape, name } = restaurant
  // Entered per restaurant rather than derived from restaurants.name — the
  // legal business name is usually too long to work as a program title.
  const programName = restaurant.loyalty_program_name || ''
  const pointsPerDollar = Number(restaurant.loyalty_points_per_dollar) || 0

  return (
    <div className="pb-28">
      <style>{PARTICLE_CSS}</style>

      {/* ── 1. Hero card ── */}
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
          <h1 className="text-[30px] sm:text-[38px] font-semibold text-white leading-tight">
            {programName || 'Rewards'}
          </h1>
          <p className="text-sm sm:text-base text-white/90 mt-2">
            Earn points on every order. Redeem them for free food or credit — online or in the shop.
          </p>
        </div>
      </div>

      {/* Catalog leads on both axes — first in source so it stacks above
          how-it-works on mobile, and in the wider column on desktop. */}
      <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr] gap-6 mt-8">
        {/* ── 5. Rewards catalog ── */}
        {rewards.length > 0 && (
          <section>
            <h2 className="text-[15px] font-medium text-gray-900 mb-2.5">What you can get</h2>
            <div className="space-y-2">
              {rewards.map(rw => (
                <div
                  key={rw.id}
                  className="rounded-xl border border-gray-200 overflow-hidden flex items-stretch"
                >
                  <RewardThumb reward={rw} brandColor={brandColor} widthCls="w-[76px]" />
                  <div className="flex-1 px-3.5 py-3 flex justify-between items-center gap-3">
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
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── 3. How it works ── */}
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

      {/* ── 7. Tier ladder ── */}
      {tiers.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[15px] font-medium text-gray-900 mb-3">Order more, earn faster</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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

      {/* ── 6. CTA — its one job is sign-in, and the wrapper's pb-28 reserves
             the space it occupies. Fixed to the viewport, matching CartButton
             in the ordering flow. ── */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-gray-200 px-5 py-3">
        <div className="max-w-[720px] mx-auto">
          <button
            onClick={onSignIn}
            className="w-full h-12 rounded-xl text-white font-semibold flex items-center justify-center"
            style={{ backgroundColor: brandColor }}
          >
            Sign in to see your points
          </button>
        </div>
      </div>
    </div>
  )
}
