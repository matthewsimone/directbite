import { useState, useEffect } from 'react'
import directbiteWordmark from '../assets/directbite-wordmark.png'
import peopleOrderingFood from '../assets/people-ordering-food.jpg'
import pizzaHero from '../assets/pizza-hero.jpg'

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
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[88%] max-w-[1200px] px-6 py-3 flex items-center justify-between transition-all duration-300"
      style={{
        backgroundColor: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: 12,
      }}
    >
      <div className="flex items-center gap-2.5">
        <svg width="24" height="24" viewBox="0 0 100 130" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <mask id="pin-bite-mask">
              <rect width="100" height="130" fill="white" />
              <circle cx="-14" cy="38" r="36" fill="black" />
            </mask>
          </defs>
          <path
            d="M50 0 C22.4 0 0 22.4 0 50 C0 80 50 130 50 130 C50 130 100 80 100 50 C100 22.4 77.6 0 50 0 Z"
            fill="white"
            mask="url(#pin-bite-mask)"
          />
        </svg>
        <img src={directbiteWordmark} alt="DirectBite" className="h-3.5" style={{ marginTop: 1 }} />
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
        transform: 'rotate(4deg)',
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

// ── Hero ──
function Hero({ onContact }) {
  return (
    <section
      className="pt-36 md:pt-40 pb-20 md:pb-24 px-6 md:px-12 lg:px-20 animate-fadeInUp"
      style={{ background: 'radial-gradient(ellipse at center, rgba(34,197,94,0.04) 0%, transparent 70%)' }}
    >
      <div className="max-w-[1200px] mx-auto flex flex-col md:flex-row items-center gap-16 md:gap-12">
        <div className="flex-1 text-center md:text-left">
          <p className="text-[#16A34A] text-xs font-medium tracking-[0.15em] uppercase mb-6">
            Commission-Free Direct Ordering
          </p>
          <h1 className="font-semibold tracking-tight leading-[1.1] text-[#111] mb-6" style={{ fontSize: 'clamp(42px, 6vw, 72px)' }}>
            Reclaim your margin online.
          </h1>
          <p className="text-[#6b7280] text-lg max-w-[520px] mx-auto md:mx-0 mb-10">
            DirectBite is not a marketplace. We don't list your competitors. We don't
            take a cut. We give your customers a direct line to you — and get out of
            the way.
          </p>
          <div className="flex items-center justify-center md:justify-start gap-4 flex-wrap">
            <a
              href="#how-it-works"
              className="bg-[#111] text-white px-7 py-3 rounded-full text-sm font-medium hover:opacity-90 transition-opacity"
            >
              See How It Works
            </a>
            <button
              onClick={() => onContact('Request a Demo')}
              className="border border-[#e5e7eb] px-7 py-3 rounded-full text-sm font-medium text-[#111] hover:bg-gray-50 transition-colors"
            >
              Request a Demo
            </button>
          </div>
        </div>
        <div className="flex-shrink-0">
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
          The DirectBite Difference
        </p>
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-[#111] mb-6">
          Not a marketplace. A margin tool.
        </h2>
        <p className="text-[#6b7280] text-base leading-relaxed">
          We don't sell ads. We don't list your competitors next to you. We don't
          own your customers. DirectBite plugs directly into your website and lets
          customers order — without a middleman touching your money.
        </p>
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
        <span>&copy; 2026 DirectBite</span>
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
      `}</style>
    </div>
  )
}
