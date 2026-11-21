// Native-only points screen (Owner-style, white). Presentational — every value
// arrives as a prop from AccountView, which owns the derivations and the
// redeem side effect. Rendered only when IS_NATIVE && loyalty is on && the
// tab bar's section is 'rewards'; web never reaches this file.

import { useState, useEffect } from 'react'
import '@fontsource/archivo-black/400.css'

import {
  RewardThumb,
  formatDay,
  formatPoints,
  humanizeReason,
  shadeHex,
} from './rewardsShared'
import { useNativeBack } from '../lib/nativeBack'

// Same silhouette as HeroSection's CrownIcon, but inheriting currentColor so
// it follows whatever surface it sits on.
function CrownIcon({ className = 'w-3.5 h-3.5' }) {
  return (
    <svg className={`${className} shrink-0`} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 16 L3.5 5.5 L8 11 L12 4 L16 11 L20.5 5.5 L20.5 16 Z" />
      <rect x="4.5" y="18" width="15" height="3" rx="1.5" />
    </svg>
  )
}

function GiftIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.75}
        d="M20 12v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8M3 8h18v4H3zM12 8v13M12 8S10.5 3 8 3a2 2 0 000 4c1.5 0 4 1 4 1zm0 0s1.5-5 4-5a2 2 0 010 4c-1.5 0-4 1-4 1z"
      />
    </svg>
  )
}

// Glossy brand tile with a chunky skewed dollar figure for discount rewards.
// size 'card' (Ready to redeem) or 'row' (Keep going).
function GlossyAmount({ text, brandColor, size }) {
  const light = shadeHex(brandColor, 0.25)
  const dark = shadeHex(brandColor, -0.30)
  const deep = shadeHex(brandColor, -0.55)
  const isCard = size === 'card'
  const len = text.length
  const fontSize = isCard
    ? (len <= 2 ? 44 : len === 3 ? 38 : 32)
    : (len <= 2 ? 22 : len === 3 ? 18 : 15)
  const textShadow = isCard
    ? `1px 1px 0 #E9E9EC, 2px 2px 0 ${dark}, 3px 3px 0 ${dark}, 4px 4px 0 ${deep}, 4px 8px 12px rgba(0,0,0,0.32)`
    : `1px 1px 0 ${dark}, 2px 2px 0 ${deep}, 2px 4px 5px rgba(0,0,0,0.3)`

  return (
    <div
      className="relative overflow-hidden w-full h-full flex items-center justify-center"
      style={{
        background: `linear-gradient(180deg, ${light} 0%, ${brandColor} 48%, ${dark} 100%)`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.15)',
      }}
    >
      <div
        className="absolute pointer-events-none rounded-full"
        style={{
          left: '-20%',
          right: '-20%',
          top: '-62%',
          height: '100%',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.30), rgba(255,255,255,0.04))',
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          top: '-30%',
          bottom: '-30%',
          width: isCard ? 34 : 14,
          left: '62%',
          transform: 'rotate(22deg)',
          background: 'rgba(255,255,255,0.10)',
        }}
      />
      <span
        className="relative z-10"
        style={{
          fontFamily: "'Archivo Black', 'Arial Black', sans-serif",
          color: '#fff',
          // Card tiles carry the "+" chip bottom-right; nudge the figure up-left clear of it.
          transform: isCard ? 'translate(-6px, -6px) skewX(-6deg)' : 'skewX(-6deg)',
          lineHeight: 1,
          letterSpacing: '0.01em',
          fontSize,
          textShadow,
        }}
      >
        {text}
      </span>
    </div>
  )
}

// Discount → glossy amount; photo → RewardThumb; anything else → gift placeholder
// (RewardThumb would render nothing and collapse the slot).
function Thumb({ reward, brandColor, widthCls, iconCls, size }) {
  if (reward.kind === 'discount' && Number(reward.discount_cents) > 0) {
    return (
      <div className={`${widthCls} shrink-0`}>
        <GlossyAmount
          text={`$${Math.round(Number(reward.discount_cents) / 100)}`}
          brandColor={brandColor}
          size={size}
        />
      </div>
    )
  }
  if (reward.menu_items?.image_url) {
    return <RewardThumb reward={reward} brandColor={brandColor} widthCls={widthCls} />
  }
  return (
    <div className={`${widthCls} shrink-0 bg-gray-100 flex items-center justify-center text-gray-400`}>
      <GiftIcon className={iconCls} />
    </div>
  )
}

function tierRate(tier, pointsPerDollar) {
  // Rounded through an integer so the rate reads 3.3, not 3.3000000000000003.
  return Math.round((Number(tier?.multiplier) || 1) * pointsPerDollar * 10) / 10
}

const byCost = (a, b) => (Number(a.points_cost) || 0) - (Number(b.points_cost) || 0)

export default function NativeRewards({
  customer,
  brandColor,
  tiers = [],
  pointsPerDollar = 0,
  currentTier = null,
  nextTier = null,
  atTopTier = false,
  pointsToNext = 0,
  nextTierRate = 0,
  lifetime = 0,
  pointsBalance = 0,
  animatedPoints = 0,
  readyRewards = [],
  keepGoingRewards = [],
  transactions = [],
  redeeming = null,
  onRedeemClick = () => {},
}) {
  const [open, setOpen] = useState(false)
  useNativeBack(open, () => setOpen(false))

  // First paint lands at 0 width so the level bar has something to animate from.
  const [barMounted, setBarMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setBarMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const showTier = Boolean(customer) && tiers.length > 0 && Boolean(currentTier)
  const sheetOpen = open && showTier

  // Progress within the current tier's range (current threshold → next), not
  // from zero like AccountView's progressPct. Lifetime-based, matching pointsToNext.
  const curThreshold = Number(currentTier?.threshold_points) || 0
  const nextThreshold = Number(nextTier?.threshold_points) || 0
  const tierPct = atTopTier || !nextTier
    ? 100
    : Math.min(100, Math.max(0, ((lifetime - curThreshold) / Math.max(1, nextThreshold - curThreshold)) * 100))

  const brandDark = shadeHex(brandColor, -0.30)
  // Brand at 12% alpha (0x1F) for the header wash. Hex-alpha rather than
  // color-mix, which rendered unreliably inside gradients.
  const tint = /^#[0-9a-f]{6}$/i.test(brandColor || '') ? `${brandColor}1F` : shadeHex(brandColor, 0.85)
  const earnRate = tierRate(currentTier, Number(pointsPerDollar) || 0)

  // AccountView already splits on cost <= balance; only the order is ours.
  const ready = [...readyRewards].sort(byCost)
  const keepEarning = [...keepGoingRewards].sort(byCost)

  // Main-screen bar tracks the cheapest reward the balance can't cover yet.
  // keepEarning is cost-ascending and every entry costs more than the balance.
  const nextReward = keepEarning[0] || null
  const nextRewardCost = Number(nextReward?.points_cost) || 0
  const rewardPct = nextReward
    ? Math.min(100, Math.max(0, (pointsBalance / Math.max(1, nextRewardCost)) * 100))
    : 100
  const hasRewards = ready.length + keepEarning.length > 0

  // customer-auth's history query orders created_at desc, so these are the newest five.
  const recent = transactions.slice(0, 5)

  return (
    <div
      className="-mx-6 -mt-2 -mb-8 bg-white min-h-[70vh] pt-6 pb-28"
      style={{ backgroundImage: `linear-gradient(180deg, ${tint} 0px, #FFFFFF 260px)` }}
    >
      {/* HEADER */}
      <div className="px-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900">
          {/* Crown hangs off the right edge like a ™ so it doesn't shift the centering. */}
          <span className="relative inline-block">
            Rewards
            <span
              className="absolute left-full ml-0.5 flex"
              style={{ bottom: '0.3em', color: brandColor }}
              aria-hidden="true"
            >
              <CrownIcon className="w-[18px] h-[18px]" />
            </span>
          </span>
        </h1>
        {showTier && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-4 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[14px] font-semibold bg-gray-100 text-gray-800"
          >
            <span className="text-gray-500 flex">
              <CrownIcon />
            </span>
            {`${currentTier.name} member`}
            <svg className="w-3.5 h-3.5 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        <p className="mt-3 text-[28px] font-bold text-gray-900 tabular-nums">
          {`You have ${formatPoints(animatedPoints)} ${pointsBalance === 1 ? 'point' : 'points'}`}
        </p>

        {earnRate > 0 && (
          <p className="mt-1 text-[15px] text-gray-600">{`Earn ${earnRate} points for every $1 you spend with us`}</p>
        )}

        {hasRewards && (
          <div className="mt-5">
            <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-[900ms] ease-out"
                style={{
                  width: `${barMounted ? rewardPct : 0}%`,
                  backgroundColor: brandColor,
                }}
              />
            </div>
            <p className="mt-2 text-[13px] text-gray-500">
              {nextReward
                ? `${formatPoints(Math.max(0, nextRewardCost - pointsBalance))} points to ${nextReward.name}`
                : 'Every reward is unlocked'}
            </p>
          </div>
        )}
      </div>

      {/* REWARDS */}
      <div className="mt-8 space-y-8">
        {ready.length === 0 && keepEarning.length === 0 && (
          <p className="px-6 text-center text-[16px] text-gray-500">Rewards will show up here.</p>
        )}

        {ready.length > 0 && (
          <section>
            <h2 className="px-5 text-[17px] font-bold text-gray-900">Ready to redeem</h2>
            <div className="mt-3 flex gap-3 overflow-x-auto px-5 scroll-px-5 snap-x scrollbar-hide">
              {ready.map(rw => {
                const cost = Number(rw.points_cost) || 0
                const busy = redeeming === rw.id
                return (
                  <button
                    key={rw.id}
                    type="button"
                    aria-label={`Redeem ${rw.name}`}
                    disabled={redeeming != null}
                    onClick={() => onRedeemClick(rw)}
                    className="w-[132px] shrink-0 snap-start text-left"
                  >
                    <div className="h-[110px] rounded-2xl overflow-hidden relative flex">
                      <Thumb reward={rw} brandColor={brandColor} widthCls="w-full h-full" iconCls="w-8 h-8" size="card" />
                      <span
                        className="absolute right-2 bottom-2 z-20 w-8 h-8 rounded-[10px] bg-white shadow-sm flex items-center justify-center"
                        style={{ color: brandDark }}
                      >
                        {busy ? (
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
                            <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeWidth={2.75} d="M12 5v14M5 12h14" />
                          </svg>
                        )}
                      </span>
                    </div>
                    <p className="mt-2 text-[15px] font-semibold text-gray-900 line-clamp-2">{rw.name}</p>
                    <p className="mt-0.5 text-[13px] font-semibold" style={{ color: brandDark }}>
                      {`${formatPoints(cost)} pts`}
                    </p>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {keepEarning.length > 0 && (
          <section>
            <h2 className="px-5 text-[17px] font-bold text-gray-900">Keep earning</h2>
            <div className="mt-3 flex gap-3 overflow-x-auto px-5 scroll-px-5 snap-x scrollbar-hide">
              {keepEarning.map(rw => {
                const cost = Number(rw.points_cost) || 0
                return (
                  <div key={rw.id} className="w-[132px] shrink-0 snap-start text-left">
                    <div className="h-[110px] rounded-2xl overflow-hidden relative flex opacity-50">
                      <Thumb reward={rw} brandColor={brandColor} widthCls="w-full h-full" iconCls="w-8 h-8" size="card" />
                    </div>
                    <p className="mt-2 text-[15px] font-semibold text-gray-900 line-clamp-2">{rw.name}</p>
                    <p className="mt-0.5 text-[13px] text-gray-500">
                      {`${formatPoints(Math.max(0, cost - pointsBalance))} pts to go`}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>

      {/* TIER SHEET */}
      {sheetOpen && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-3xl px-6 pt-3 pb-6 ordr-sheet-bottom max-h-[85vh] overflow-y-auto overscroll-contain">
            <div className="w-10 h-1 rounded-full bg-gray-300 mx-auto" />

            <div className="flex justify-center mt-4">
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
                style={{
                  backgroundColor: `color-mix(in srgb, ${brandColor} 12%, white)`,
                  color: brandColor,
                }}
              >
                <CrownIcon />
                {`${currentTier.name} member`}
              </span>
            </div>

            <p className="text-center text-[15px] text-gray-900 mt-3">
              {`You earn ${tierRate(currentTier, pointsPerDollar)} points per $1`}
            </p>
            <p className="text-center text-sm text-gray-500 mt-1">
              {atTopTier || !nextTier
                ? "You've reached the top tier."
                : `${formatPoints(pointsToNext)} more points to reach ${nextTier.name} (${nextTierRate} per $1)`}
            </p>

            <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-4">
              <div
                className="h-full rounded-full"
                style={{ width: `${tierPct}%`, backgroundColor: brandColor }}
              />
            </div>

            <div className="mt-4">
              {tiers.map(tier => {
                const isCurrent = tier.id === currentTier.id
                return (
                  <div key={tier.id} className="flex justify-between py-2.5 border-b border-gray-100 text-sm">
                    <span
                      className={isCurrent ? 'font-semibold' : 'text-gray-900'}
                      style={isCurrent ? { color: brandColor } : undefined}
                    >
                      {tier.name}
                    </span>
                    <span className="text-gray-500">
                      {`${tierRate(tier, pointsPerDollar)} pts/$1 · ${formatPoints(tier.threshold_points)} pts`}
                    </span>
                  </div>
                )
              })}
            </div>

            {recent.length > 0 && (
              <div className="mt-5">
                <h3 className="text-[15px] font-semibold text-gray-900">Recent points</h3>
                <div className="mt-1">
                  {recent.map(t => {
                    const delta = Number(t.points_delta) || 0
                    return (
                      <div key={t.id} className="flex justify-between items-center py-2">
                        <div className="min-w-0">
                          <p className="text-[15px] text-gray-900">{humanizeReason(t.reason)}</p>
                          <p className="text-[13px] text-gray-500">{formatDay(t.created_at)}</p>
                        </div>
                        <span
                          className={`text-[15px] font-semibold shrink-0 text-right ${delta > 0 ? '' : 'text-gray-500'}`}
                          style={delta > 0 ? { color: brandColor } : undefined}
                        >
                          {`${delta > 0 ? '+' : ''}${formatPoints(delta)}`}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full h-11 rounded-xl bg-gray-100 mt-4 text-sm font-medium text-gray-900"
            >
              Close
            </button>
          </div>
        </>
      )}
    </div>
  )
}
