// Presentation helpers shared by RewardsView (signed-out marketing) and
// AccountView (signed-in). Both are presentational only and call NO context
// hooks, so nothing here may either — they render on custom domains where
// CustomerAuthProvider is not mounted.
//
// Only what BOTH surfaces use lives here. HOW_IT_WORKS and its icons stay in
// RewardsView, which is the only thing that renders them.

import { useState, useEffect } from 'react'

export const DEFAULT_BRAND_COLOR = '#16A34A'

// Hero.jsx's ramp, deepened for card scale — the same three stops spread
// across ~200px instead of 80vh, so each has to work harder.
export const CARD_SCRIM = 'absolute inset-0 bg-gradient-to-b from-black/35 via-black/45 to-black/75'

export function formatPoints(n) { return Number(n || 0).toLocaleString('en-US') }

// "Sat, Aug 8" — short enough for a row, unambiguous without the year.
export function formatDay(value) {
  return new Date(value).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export function titleCase(value) {
  return String(value || '')
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// 'earn' is the ledger's word for it; "Order" is the customer's.
export function humanizeReason(reason) {
  return reason === 'earn' ? 'Order' : titleCase(reason)
}

// Lighten (amount > 0) or darken (amount < 0) a #RRGGBB color by that fraction
// of the distance to white/black. Returns the input untouched when it isn't a
// 6-digit hex, so a CSS keyword still renders.
export function shadeHex(hex, amount) {
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
export function tierGradient(hex) {
  if (!/^#([0-9a-f]{6})$/i.test(hex || '')) return hex
  return `linear-gradient(155deg, ${shadeHex(hex, 0.22)} 0%, ${hex} 45%, ${shadeHex(hex, -0.38)} 100%)`
}

// Offset so the three cards never pulse in sync.
const GLOW_DELAYS = [-4, -11, -19]

export const PARTICLE_CSS = `
@keyframes ordr-glow { 0% { transform: translate(-14%, -8%) scale(1); } 50% { transform: translate(16%, 10%) scale(1.22); } 100% { transform: translate(-14%, -8%) scale(1); } }
.ordr-glow { position: absolute; inset: -30%; border-radius: 50%; pointer-events: none; animation: ordr-glow 26s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ordr-glow { animation: none !important; } }
`

// One row of the tier ladder: the full card's gradient and glow, reduced to a
// strip that reads at a glance in a narrow column.
export function CompactTierRow({ tier, brandColor, pointsPerDollar, isCurrent }) {
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

// Counts from 0 to target once on mount. requestAnimationFrame rather than
// an interval so the browser owns the cadence; ease-out so the number
// sprints then settles.
export function useCountUp(target, duration = 900) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const end = Number(target) || 0
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduced || end === 0) { setValue(end); return }
    let raf
    const start = performance.now()
    const tick = now => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(end * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

// Reward art: the linked menu item's photo when there is one, otherwise a
// brand-gradient dollar figure for discount rewards. Anything else gets no
// strip, so the row falls back to its original full-width layout.
export function RewardThumb({ reward, brandColor, widthCls }) {
  const imageUrl = reward.menu_items?.image_url || null
  const isDiscount = reward.kind === 'discount' && Number(reward.discount_cents) > 0

  if (imageUrl) {
    return (
      <div
        className={`${widthCls} shrink-0`}
        style={{
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
    )
  }

  if (isDiscount) {
    return (
      <div
        className={`${widthCls} shrink-0 flex items-center justify-center`}
        style={{ backgroundColor: brandColor }}
      >
        <span
          className="text-[22px] font-bold"
          style={{
            color: '#ffffff',
            // textShadow works here because the fill is opaque white — it
            // paints behind the glyph, which a transparent fill would hide.
            textShadow: `0 1px 0 ${shadeHex(brandColor, -0.28)}, 0 2px 4px rgba(0,0,0,0.32)`,
          }}
        >
          {`$${Math.round(Number(reward.discount_cents) / 100)}`}
        </span>
      </div>
    )
  }

  return null
}
