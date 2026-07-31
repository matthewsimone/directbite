import { useState, useEffect } from 'react'
import ordrLockupBlack from '../assets/ordr-logo-lockup.svg'
import peopleOrderingFood from '../assets/people-ordering-food.jpg'
import pizzaHero from '../assets/pizza-hero.jpg'
import payApple from '../assets/pay-apple.svg'
import payGoogle from '../assets/pay-google.svg'
import payVisa from '../assets/pay-visa.svg'
import payMastercard from '../assets/pay-mastercard.svg'
import payAmex from '../assets/pay-amex.svg'
import ordrLockupWhite from '../assets/ordr-lockup-white.svg'
import uberDirectWhite from '../assets/uber-direct-white.svg'

// ── Contact Form Dialog ──
function ContactFormDialog({ open, onOpenChange, heading }) {
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  if (!open) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const formData = new FormData(e.currentTarget)
      formData.append('_subject', heading)
      const res = await fetch('https://formspree.io/f/mbdqlgwr', {
        method: 'POST',
        body: formData,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error('Submit failed')
      setSuccess(true)
      setTimeout(() => { onOpenChange(false); setSuccess(false) }, 2000)
    } catch {
      alert('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white rounded-2xl w-full max-w-[440px] p-6 shadow-xl" style={{ animation: 'fadeInScale 0.2s ease-out' }}>
        <button onClick={() => onOpenChange(false)} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        <h2 className="text-xl font-semibold text-[#111] mb-1">{heading}</h2>
        <p className="text-sm text-[#6b7280] mb-5">Fill out the form below and we'll get back to you within 24 hours.</p>

        {success ? (
          <div className="text-center py-8">
            <div className="w-12 h-12 bg-[#16A34A] rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-semibold text-[#111]">Thanks!</p>
            <p className="text-sm text-[#6b7280]">We'll be in touch shortly.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Your Name</label>
              <input name="name" required maxLength={100} placeholder="John Smith"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Restaurant Name</label>
              <input name="restaurant" required maxLength={100} placeholder="Simone's Pizza"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Zip Code</label>
              <input name="zip" required maxLength={10} placeholder="10001"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Email</label>
              <input name="email" type="email" required maxLength={255} placeholder="you@restaurant.com"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Phone Number</label>
              <input name="phone" type="tel" required maxLength={20} placeholder="(555) 123-4567"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <button type="submit" disabled={submitting}
              className="w-full h-10 bg-[#16A34A] text-white font-medium rounded-full hover:opacity-90 transition-opacity disabled:opacity-50 mt-2">
              {submitting ? 'Sending...' : 'Submit'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Star Pill ──
function StarPill() {
  return (
    <div
      className="inline-flex items-center gap-2.5 bg-white rounded-full px-[18px] py-2"
      style={{ border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 20px rgba(0,0,0,0.06)' }}
    >
      <span className="inline-flex gap-[2px]" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <svg key={i} width="13" height="13" viewBox="0 0 24 24" fill="#16A34A" style={{ display: 'block' }}>
            <path d="M12 .587l3.668 7.431 8.332 1.151-6.064 5.828 1.48 8.279L12 19.309l-7.416 3.967 1.481-8.279L.001 9.169l8.332-1.151z" />
          </svg>
        ))}
      </span>
      <span className="text-[13px] font-medium text-[#111] tracking-[-0.01em]">
        Restaurant ordering done right
      </span>
    </div>
  )
}

// ── Nav ──
function Nav({ onContact }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', h)
    return () => window.removeEventListener('scroll', h)
  }, [])

  return (
    <nav
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[88%] max-w-[1200px] px-7 py-4 flex items-center justify-between transition-all duration-300"
      style={{
        backgroundColor: '#FFFFFF',
        border: '1px solid rgba(0,0,0,0.04)',
        boxShadow: '0 2px 20px rgba(0,0,0,0.06)',
        borderRadius: 9999,
      }}
    >
      <div className="flex items-center gap-2.5">
        <img src={ordrLockupBlack} alt="Ordr" className="h-8" />
      </div>
      <button
        onClick={() => onContact('Get in Touch')}
        className="bg-[#16A34A] text-white text-sm font-medium px-5 py-2 rounded-full hover:opacity-90 transition-opacity"
      >
        Get in Touch
      </button>
    </nav>
  )
}

// ── iPhone Mockup ──
function IPhoneMockup() {
  return (
    <div
      className="relative mx-auto"
      style={{
        width: 280,
        height: 560,
        background: '#000',
        borderRadius: 40,
        padding: 12,
        boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      }}
    >
      {/* Notch */}
      <div
        className="absolute left-1/2 -translate-x-1/2"
        style={{
          top: 12,
          width: 80,
          height: 24,
          background: '#000',
          borderRadius: '0 0 16px 16px',
          zIndex: 10,
        }}
      />
      {/* Screen */}
      <div
        className="w-full h-full overflow-hidden flex flex-col"
        style={{ background: '#fff', borderRadius: 28 }}
      >
        {/* Hero image with restaurant name */}
        <div className="relative" style={{ height: 184 }}>
          <img src={pizzaHero} alt="" className="absolute inset-0 w-full h-full object-cover" />
          <div
            className="absolute inset-0 flex items-end p-4"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.2) 50%, transparent 100%)' }}
          >
            <div>
              <span className="text-white font-semibold block" style={{ fontSize: 20 }}>
                Simone's Pizza
              </span>
              <span className="flex items-center gap-1.5 mt-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
                <span className="text-white/80" style={{ fontSize: 12 }}>Open Now</span>
              </span>
            </div>
          </div>
        </div>
        {/* Menu items */}
        <div className="flex-1 px-4 pt-3 flex flex-col gap-0">
          {[
            { name: 'Margherita Pizza', price: '$18.00' },
            { name: 'Large Pepperoni', price: '$22.00' },
            { name: 'Garlic Knots', price: '$8.00' },
          ].map((item) => (
            <div
              key={item.name}
              className="flex items-center justify-between py-3"
              style={{ borderBottom: '1px solid #f0f0f0' }}
            >
              <div>
                <p style={{ fontSize: 14, fontWeight: 500, color: '#000' }}>{item.name}</p>
                <p style={{ fontSize: 13, color: '#888', marginTop: 2 }}>{item.price}</p>
              </div>
              <div
                className="flex items-center justify-center"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: '#22c55e',
                  color: '#fff',
                  fontSize: 16,
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                +
              </div>
            </div>
          ))}
        </div>
        {/* Checkout bar */}
        <div style={{ padding: '0 10px 10px 10px' }}>
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ background: '#22c55e', borderRadius: 16 }}
          >
            <div>
              <p style={{ fontSize: 11, fontWeight: 500, color: '#fff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                CHECKOUT
              </p>
              <p style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginTop: 1 }}>$48.00</p>
            </div>
            <div
              className="flex items-center justify-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#fff',
                color: '#22c55e',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              3
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const HERO_SLIDES = [
  { h: 'Grow your online orders', sub: 'Direct orders from your own site, on your own domain. No marketplace, no middleman.' },
  { h: 'Increase your profitability', sub: 'Keep 100% of what you charge your customers. No monthly fee, no commission.' },
  { h: 'Increase your visibility', sub: 'Grow your discovery potential through Google search engine optimization.' },
]

const HERO_TILES_DESKTOP = [
  { amt: '+$72.14', s: { top: '6%', left: '5%', animationDelay: '.1s' } },
  { amt: '+$38.90', s: { top: '15%', left: '16%', animationDelay: '.25s' } },
  { amt: '+$52.84', s: { top: '7%', right: '5%', animationDelay: '.35s' } },
  { amt: '+$61.30', s: { top: '16%', right: '16%', animationDelay: '.5s' } },
  { amt: '+$136.85', s: { top: '57%', left: '6%', animationDelay: '.65s' } },
  { amt: '+$41.60', s: { top: '65%', left: '17%', animationDelay: '.8s' } },
  { amt: '+$94.20', s: { top: '58%', right: '6%', animationDelay: '.95s' } },
  { amt: '+$118.05', s: { top: '66%', right: '17%', animationDelay: '1.1s' } },
]

const HERO_TILES_MOBILE = [
  { amt: '+$72.14', s: { top: '4%', left: '5%', animationDelay: '.1s' } },
  { amt: '+$38.90', s: { top: '10%', left: '28%', animationDelay: '.25s' } },
  { amt: '+$52.84', s: { top: '5%', right: '5%', animationDelay: '.4s' } },
  { amt: '+$136.85', s: { top: '56%', left: '5%', animationDelay: '.55s' } },
  { amt: '+$41.60', s: { top: '62%', left: '30%', animationDelay: '.7s' } },
  { amt: '+$94.20', s: { top: '57%', right: '5%', animationDelay: '.85s' } },
]

// ── Hero ──
function Hero({ onContact }) {
  const [slide, setSlide] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setSlide((s) => (s + 1) % HERO_SLIDES.length), 4200)
    return () => clearInterval(id)
  }, [paused])

  const on = (i) => (i === slide ? 'hr-slide hr-on' : 'hr-slide')

  return (
    <section
      className="relative overflow-hidden pt-32 md:pt-36 pb-20 md:pb-24 px-6 animate-fadeInUp"
      style={{ background: 'radial-gradient(ellipse at center, rgba(34,197,94,0.04) 0%, transparent 70%)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="max-w-[1200px] mx-auto">
        <div className="relative h-[470px]">

          <div className="absolute inset-0" aria-hidden="true">
            <div className={`absolute inset-0 ${on(0)}`}>
              <div className="hidden md:block absolute inset-0">
                {HERO_TILES_DESKTOP.map((t) => (
                  <div key={t.amt} className="hr-tile" style={t.s}>{t.amt}</div>
                ))}
              </div>
              <div className="md:hidden absolute inset-0">
                {HERO_TILES_MOBILE.map((t) => (
                  <div key={t.amt} className="hr-tile" style={t.s}>{t.amt}</div>
                ))}
              </div>
            </div>

            <div className={`absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-screen ${on(1)}`}>
              <svg viewBox="0 0 600 470" preserveAspectRatio="none" className="hidden md:block absolute inset-0 w-full h-full" style={{ overflow: 'visible' }}>
                <defs>
                  <linearGradient id="hrFadeD" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="470">
                    <stop offset="0" stopColor="#16A34A" stopOpacity="0.11" />
                    <stop offset="1" stopColor="#16A34A" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path className="hr-area" d="M-40 441 L110 402 L250 350 L390 268 L520 199 L660 80 L660 520 L-40 520 Z" fill="url(#hrFadeD)" opacity="0" style={{ transformOrigin: 'bottom' }} transform="scale(1,0)" />
                <path className="hr-line" d="M-40 441 L110 402 L250 350 L390 268 L520 199 L660 80" fill="none" stroke="rgba(22,163,74,.3)" strokeWidth="3" strokeLinecap="round" strokeDasharray="810" strokeDashoffset="810" />
              </svg>
              <svg viewBox="0 0 375 470" preserveAspectRatio="none" className="md:hidden absolute inset-0 w-full h-full" style={{ overflow: 'visible' }}>
                <defs>
                  <linearGradient id="hrFadeM" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="470">
                    <stop offset="0" stopColor="#16A34A" stopOpacity="0.11" />
                    <stop offset="1" stopColor="#16A34A" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path className="hr-area" d="M-30 440 L70 406 L160 360 L250 284 L320 222 L410 104 L410 520 L-30 520 Z" fill="url(#hrFadeM)" opacity="0" style={{ transformOrigin: 'bottom' }} transform="scale(1,0)" />
                <path className="hr-line" d="M-30 440 L70 406 L160 360 L250 284 L320 222 L410 104" fill="none" stroke="rgba(22,163,74,.3)" strokeWidth="3" strokeLinecap="round" strokeDasharray="580" strokeDashoffset="580" />
              </svg>
            </div>

            <div className={`absolute inset-0 ${on(2)}`}>
              <div className="hidden md:block absolute inset-0">
                <div className="hr-seo-d" style={{ top: '16%' }} />
                <div className="hr-seo-d" style={{ top: '26%' }} />
                <div className="hr-seo-d" style={{ top: '36%' }} />
                <div className="hr-seo-d" style={{ top: '46%' }} />
                <div className="hr-seo-d" style={{ top: '56%' }} />
                <div className="hr-seo-d hr-seo-green hr-climb-d" style={{ top: '54%' }} />
              </div>
              <div className="md:hidden absolute inset-0">
                <div className="hr-seo-m" style={{ top: '56%' }} />
                <div className="hr-seo-m" style={{ top: '62%' }} />
                <div className="hr-seo-m" style={{ top: '68%' }} />
                <div className="hr-seo-m" style={{ top: '74%' }} />
                <div className="hr-seo-m" style={{ top: '80%' }} />
                <div className="hr-seo-m hr-seo-green hr-climb-m" style={{ top: '78%' }} />
              </div>
            </div>
          </div>

          <div className="relative z-10 h-full flex flex-col items-center justify-center text-center">
            <StarPill />

            <div className="relative w-full h-[165px] md:h-[140px] mt-6 md:mt-8">
              {HERO_SLIDES.map((s, i) => (
                <div key={s.h} className={`absolute inset-0 flex flex-col md:justify-center ${on(i)}`}>
                  <h1 className="font-semibold tracking-tight leading-[1.08] text-[#111] mb-3 md:mb-4" style={{ fontSize: 'clamp(34px, 4.5vw, 54px)' }}>
                    {s.h}
                  </h1>
                  <p className="text-[#6b7280] text-base md:text-lg max-w-[520px] mx-auto">{s.sub}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-center gap-3 md:gap-4 w-full md:w-auto mt-6 md:mt-7">
              <a href="#how-it-works" className="bg-[#111] text-white px-7 py-3.5 rounded-full text-sm font-medium hover:opacity-90 transition-opacity">
                See How It Works
              </a>
              <button onClick={() => onContact('Request a Demo')} className="border border-[#e5e7eb] px-7 py-3.5 rounded-full text-sm font-medium text-[#111] hover:bg-gray-50 transition-colors">
                Request a Demo
              </button>
            </div>

            <div className="flex items-center gap-2 mt-6">
              {HERO_SLIDES.map((s, i) => (
                <button
                  key={s.h}
                  onClick={() => setSlide(i)}
                  aria-label={s.h}
                  className={i === slide ? 'h-1.5 w-5 rounded-full bg-[#16A34A] transition-all' : 'h-1.5 w-1.5 rounded-full bg-[#d1d5db] transition-all'}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-14 md:mt-16 flex justify-center">
          <IPhoneMockup />
        </div>
      </div>
    </section>
  )
}

// ── Receipt ──
function Receipt() {
  return (
    <section className="pt-24 pb-8 px-6 animate-fadeInUp" id="how-it-works" style={{ backgroundColor: '#f5f5f7' }}>
      <div
        className="max-w-[480px] mx-auto p-8 md:p-10 bg-white"
        style={{ border: '1px solid #e5e7eb', borderRadius: 20 }}
      >
        <pre className="font-mono text-sm md:text-base leading-relaxed whitespace-pre">
{`Order Total:                $100.00
Monthly Subscription:        `}<span className="text-[#16A34A]">$0.00</span>{`
Transaction Fee:             `}<span className="text-[#16A34A]">$0.00</span>{`
─────────────────────────────────────`}
        </pre>
        <div
          className="font-mono text-sm md:text-base mt-0 py-2 pl-3"
          style={{ borderLeft: '3px solid #16A34A' }}
        >
          Restaurant Keeps:           $100.00
        </div>
      </div>
    </section>
  )
}

// ── Stats ──
function Stats() {
  const cards = [
    { label: 'MONTHLY SAVINGS', value: '$3,000', green: true, sub: 'vs. third-party platforms' },
    { label: 'AVG. ORDER KEPT', value: '100%', green: false, sub: 'yours, not theirs' },
    { label: 'MARKETPLACE COMMISSION', value: 'Up to 30%', green: false, sub: "what you're losing today" },
  ]
  return (
    <section className="py-24 px-6 animate-fadeInUp" id="pricing" style={{ backgroundColor: '#f5f5f7' }}>
      <div className="max-w-[960px] mx-auto grid md:grid-cols-3 gap-5">
        {cards.map((c) => (
          <div
            key={c.label}
            className="p-8 text-center bg-white"
            style={{ border: '1px solid #e5e7eb', borderRadius: 16 }}
          >
            <p className="text-xs tracking-[0.1em] text-[#6b7280] uppercase mb-3">{c.label}</p>
            <p className={`text-3xl md:text-4xl font-semibold mb-2 ${c.green ? 'text-[#16A34A]' : 'text-[#111]'}`}>
              {c.value}
            </p>
            <p className="text-sm text-[#6b7280]">{c.sub}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Value Prop ──
function ValueProp() {
  return (
    <section className="py-24 px-6 text-center animate-fadeInUp">
      <div className="max-w-[520px] mx-auto">
        <p className="text-xs tracking-[0.15em] text-[#6b7280] uppercase mb-4">
          The Ordr Difference
        </p>
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-[#111] mb-6">
          Not a marketplace. A margin tool.
        </h2>
        <p className="text-[#6b7280] text-base leading-relaxed">
          We don't sell ads. We don't list your competitors next to you. We don't
          own your customers. Ordr plugs directly into your website and lets
          customers order — without a middleman touching your money.
        </p>
      </div>
    </section>
  )
}

// ── Delivery ──
function Delivery() {
  return (
    <section className="bg-[#111] py-24 px-6 animate-fadeInUp" id="delivery">
      <div className="max-w-[1200px] mx-auto">
        <p className="text-xs tracking-[0.15em] text-[#8b8f96] uppercase mb-4">Delivery</p>
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-white mb-6 max-w-[720px]">
          Expand your delivery zone
        </h2>
        <p className="text-[#9ca3af] text-base leading-relaxed max-w-[560px] mb-4">
          Uber Direct is white-label delivery on your own site — no marketplace listing, no competitors shown, your customer stays yours. Fulfill every delivery, or only the orders beyond your in-house zone.
        </p>
        <p className="text-[#9ca3af] text-base leading-relaxed max-w-[560px] mb-10">
          Flat-rate pricing by distance, <span className="text-[#16A34A]">no commission on the order</span>. You set the customer's delivery fee.
        </p>
        <div className="flex items-center gap-5">
          <img src={ordrLockupWhite} alt="Ordr" className="h-9 w-auto" />
          <span className="w-px h-6 bg-[#4b5056]" aria-hidden="true" />
          <img src={uberDirectWhite} alt="Uber Direct" width="152" height="24" style={{ display: 'block' }} />
        </div>
      </div>
    </section>
  )
}

// ── Payments ──
function Payments() {
  const marks = [
    { src: payApple, alt: 'Apple Pay', w: 41 },
    { src: payGoogle, alt: 'Google Pay', w: 49 },
    { src: payVisa, alt: 'Visa', w: 40 },
    { src: payMastercard, alt: 'Mastercard', w: 40 },
    { src: payAmex, alt: 'American Express', w: 40 },
  ]
  return (
    <section className="py-24 px-6 animate-fadeInUp" id="payments">
      <div className="max-w-[1200px] mx-auto">
        <p className="text-xs tracking-[0.15em] text-[#6b7280] uppercase mb-4">Checkout</p>
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-[#111] mb-6 max-w-[720px]">
          Increase checkout conversions with flexible payment options
        </h2>
        <p className="text-[#6b7280] text-base leading-relaxed max-w-[560px] mb-12">
          76% of Ordr orders are paid in one tap. Most restaurant websites can't accept a single wallet payment — every one of those customers hits a card form instead.
        </p>
        <div className="flex items-center justify-center gap-[18px] flex-wrap">
          {marks.map((m) => (
            <img key={m.alt} src={m.src} alt={m.alt} width={m.w} height={26} style={{ display: 'block', flexShrink: 0 }} />
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Final CTA ──
function FinalCTA({ onContact }) {
  return (
    <section className="relative bg-[#111] py-24 px-6 text-center overflow-hidden animate-fadeInUp" id="get-started">
      <img
        src={peopleOrderingFood}
        alt=""
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover opacity-15"
        style={{ objectPosition: 'center 40%' }}
      />
      <div className="relative z-10">
        <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight mb-4">
          Your customer. Your profit. Your brand.
        </h2>
        <p className="text-[#16A34A] text-base mb-10">
          Join the fastest-growing direct ordering network.
        </p>
        <button
          onClick={() => onContact('Get Started')}
          className="inline-block bg-[#16A34A] text-white px-8 py-3.5 rounded-full text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Get Started
        </button>
      </div>
    </section>
  )
}

// ── Footer ──
function Footer() {
  return (
    <footer className="border-t border-[#e5e7eb] py-6 px-6">
      <div className="max-w-[1200px] mx-auto text-center text-sm text-[#6b7280]">
        <span>&copy; 2026 Ordr</span>
      </div>
    </footer>
  )
}

// ── Landing Page ──
export default function LandingPage() {
  const [contactOpen, setContactOpen] = useState(false)
  const [contactHeading, setContactHeading] = useState('')

  // Suppress PWA install prompt on landing page
  useEffect(() => {
    const suppress = (e) => e.preventDefault()
    window.addEventListener('beforeinstallprompt', suppress)
    return () => window.removeEventListener('beforeinstallprompt', suppress)
  }, [])

  function openContact(heading) {
    setContactHeading(heading)
    setContactOpen(true)
  }

  return (
    <div className="min-h-screen bg-white" style={{ scrollBehavior: 'smooth' }}>
      <Nav onContact={openContact} />
      <Hero onContact={openContact} />
      <Receipt />
      <Stats />
      <ValueProp />
      <Delivery />
      <Payments />
      <FinalCTA onContact={openContact} />
      <Footer />
      <ContactFormDialog open={contactOpen} onOpenChange={setContactOpen} heading={contactHeading} />

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeInScale {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        .animate-fadeInUp {
          animation: fadeInUp 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .hr-slide { opacity: 0; transition: opacity .55s ease; pointer-events: none; }
        .hr-slide.hr-on { opacity: 1; }
        .hr-tile {
          position: absolute;
          background: rgba(22,163,74,.13);
          border: 1px solid rgba(22,163,74,.22);
          border-radius: 9px;
          color: rgba(22,163,74,.55);
          font-weight: 500;
          padding: 5px 8px;
          font-size: 10px;
          opacity: 0;
          transform: scale(.8);
        }
        @media (min-width: 768px) { .hr-tile { padding: 7px 11px; font-size: 12px; } }
        .hr-on .hr-tile { animation: hrPop .6s cubic-bezier(.22,1,.36,1) forwards; }
        @keyframes hrPop { to { opacity: 1; transform: scale(1); } }
        .hr-on .hr-line { animation: hrDraw 1.6s ease forwards; }
        @keyframes hrDraw { to { stroke-dashoffset: 0; } }
        .hr-on .hr-area { animation: hrRise 1.4s cubic-bezier(.22,1,.36,1) forwards; }
        @keyframes hrRise { to { opacity: 1; transform: scaleY(1); } }
        .hr-seo-d, .hr-seo-m {
          position: absolute;
          border-radius: 6px;
          background: rgba(0,0,0,.045);
        }
        .hr-seo-d { right: 7%; width: 250px; height: 24px; }
        .hr-seo-m { left: 12%; width: 76%; height: 18px; }
        .hr-seo-green { background: rgba(22,163,74,.16); border: 1px solid rgba(22,163,74,.3); }
        .hr-on .hr-climb-d { animation: hrClimbD 1.8s cubic-bezier(.22,1,.36,1) forwards; }
        @keyframes hrClimbD { 0% { top: 54%; } 100% { top: 16%; } }
        .hr-on .hr-climb-m { animation: hrClimbM 1.8s cubic-bezier(.22,1,.36,1) forwards; }
        @keyframes hrClimbM { 0% { top: 78%; } 100% { top: 56%; } }
        @media (prefers-reduced-motion: reduce) {
          .hr-slide { transition: none; }
          .hr-on .hr-tile, .hr-on .hr-line, .hr-on .hr-area,
          .hr-on .hr-climb-d, .hr-on .hr-climb-m { animation: none; }
          .hr-on .hr-tile { opacity: 1; transform: none; }
          .hr-on .hr-line { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  )
}
