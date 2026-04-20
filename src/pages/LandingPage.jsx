import { useState, useRef } from 'react'

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

// ── Nav ──
function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#111]">
      <div className="max-w-[1100px] mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/directbite-icon.svg" alt="" className="h-7 w-7" />
          <img src="/directbite-wordmark.png" alt="DirectBite" className="h-5" />
        </div>
        <button
          onClick={() => scrollTo('contact')}
          className="px-5 py-2 bg-[#16A34A] text-white text-sm font-semibold rounded-lg hover:bg-[#15803D] transition-colors"
        >
          Get in Touch
        </button>
      </div>
    </nav>
  )
}

// ── Hero ──
function Hero() {
  return (
    <section className="pt-16 bg-[#F8F8F8]">
      <div className="max-w-[1100px] mx-auto px-6 py-16 sm:py-24 flex flex-col sm:flex-row items-center gap-12">
        <div className="flex-1 sm:w-[60%]">
          <p className="text-xs font-bold tracking-widest text-[#16A34A] uppercase mb-4">
            Commission-Free Direct Ordering
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold text-[#111] leading-tight">
            Reclaim your margin online.
          </h1>
          <p className="mt-5 text-lg text-gray-600 leading-relaxed max-w-xl">
            DirectBite is not a marketplace. We don't list your competitors. We don't take a cut. We give your customers a direct line to you — and get out of the way.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <button
              onClick={() => scrollTo('pricing')}
              className="px-6 py-3 bg-[#111] text-white font-semibold rounded-lg hover:bg-gray-800 transition-colors"
            >
              See How It Works
            </button>
            <button
              onClick={() => scrollTo('contact')}
              className="px-6 py-3 border-2 border-[#111] text-[#111] font-semibold rounded-lg hover:bg-gray-100 transition-colors"
            >
              Request a Demo
            </button>
          </div>
        </div>
        <div className="sm:w-[40%] flex justify-center">
          <div
            className="w-64 sm:w-72"
            style={{ transform: 'rotate(-6deg)', filter: 'drop-shadow(0 20px 40px rgba(0,0,0,0.2))' }}
          >
            <img
              src="/phone-mockup.jpg"
              alt="DirectBite ordering on phone"
              className="w-full rounded-3xl border-4 border-gray-800"
            />
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Pricing Calculator ──
function PricingCalculator() {
  const [orders, setOrders] = useState(400)
  const [aov, setAov] = useState(35)

  const monthlyVolume = orders * aov
  const thirdPartyCut = monthlyVolume * 0.25
  const savings = Math.round(thirdPartyCut)

  return (
    <section id="pricing" className="bg-[#F8F8F8] py-20">
      <div className="max-w-[1100px] mx-auto px-6">
        <div className="text-center mb-12">
          <p className="text-xs font-bold tracking-widest text-[#16A34A] uppercase mb-3">
            Pricing
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold text-[#111]">
            Keep 100% of your revenue.
          </h2>
          <p className="mt-3 text-gray-500 max-w-lg mx-auto">
            No commissions. No transaction fees. Just a simple $1.50 service fee per order paid by the customer.
          </p>
        </div>

        <div className="max-w-md mx-auto bg-white rounded-2xl shadow-lg p-8 mb-12">
          <div className="space-y-5">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">
                Monthly Orders: <span className="font-bold text-[#111]">{orders}</span>
              </label>
              <input
                type="range"
                min="50"
                max="2000"
                step="50"
                value={orders}
                onChange={e => setOrders(Number(e.target.value))}
                className="w-full accent-[#16A34A]"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>50</span><span>2,000</span>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Average Order Value</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input
                  type="number"
                  min="1"
                  value={aov}
                  onChange={e => setAov(Number(e.target.value) || 0)}
                  className="w-full h-11 pl-7 pr-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
                />
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-dashed border-gray-200 pt-6 space-y-3 font-mono text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Order Total</span>
              <span className="font-semibold">${monthlyVolume.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Monthly Subscription</span>
              <span className="font-semibold text-[#16A34A]">$0.00</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Transaction Fee</span>
              <span className="font-semibold text-[#16A34A]">$0.00</span>
            </div>
            <div className="flex justify-between border-t border-gray-200 pt-3">
              <span className="font-bold text-[#111]">Restaurant Keeps</span>
              <span className="font-bold text-[#16A34A] text-lg">${monthlyVolume.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
          <div className="bg-white rounded-xl p-6 text-center shadow-sm">
            <p className="text-3xl font-bold text-[#16A34A]">${savings.toLocaleString()}</p>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mt-1">Monthly Savings</p>
            <p className="text-xs text-gray-400 mt-0.5">vs. third-party platforms</p>
          </div>
          <div className="bg-white rounded-xl p-6 text-center shadow-sm">
            <p className="text-3xl font-bold text-[#16A34A]">100%</p>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mt-1">Avg. Order Kept</p>
            <p className="text-xs text-gray-400 mt-0.5">yours, not theirs</p>
          </div>
          <div className="bg-white rounded-xl p-6 text-center shadow-sm">
            <p className="text-3xl font-bold text-red-500">Up to 30%</p>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mt-1">Marketplace Commission</p>
            <p className="text-xs text-gray-400 mt-0.5">what you're losing today</p>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Difference ──
function Difference() {
  return (
    <section className="bg-white py-20">
      <div className="max-w-[700px] mx-auto px-6 text-center">
        <p className="text-xs font-bold tracking-widest text-[#16A34A] uppercase mb-4">
          The DirectBite Difference
        </p>
        <h2 className="text-3xl sm:text-4xl font-bold text-[#111] leading-tight">
          Not a marketplace. A margin tool.
        </h2>
        <p className="mt-5 text-lg text-gray-600 leading-relaxed">
          We don't sell ads. We don't list your competitors next to you. We don't own your customers. DirectBite plugs directly into your website and lets customers order — without a middleman touching your money.
        </p>
      </div>
    </section>
  )
}

// ── CTA ──
function Cta() {
  return (
    <section className="bg-[#111] py-24">
      <div className="max-w-[700px] mx-auto px-6 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-white leading-tight">
          Your customer. Your profit. Your brand.
        </h2>
        <p className="mt-4 text-lg text-[#16A34A] font-medium">
          Join the fastest-growing direct ordering network.
        </p>
        <button
          onClick={() => scrollTo('contact')}
          className="mt-8 px-8 py-4 bg-[#16A34A] text-white text-lg font-bold rounded-xl hover:bg-[#15803D] transition-colors"
        >
          Get Started
        </button>
      </div>
    </section>
  )
}

// ── Contact Form ──
function ContactForm() {
  const [submitted, setSubmitted] = useState(false)
  const formRef = useRef(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const data = new FormData(formRef.current)
    await fetch('https://formspree.io/f/mbdqlgwr', {
      method: 'POST',
      body: data,
      headers: { Accept: 'application/json' },
    })
    setSubmitted(true)
  }

  return (
    <section id="contact" className="bg-white py-20">
      <div className="max-w-[600px] mx-auto px-6">
        <h2 className="text-3xl font-bold text-[#111] text-center mb-8">Get in Touch</h2>

        {submitted ? (
          <div className="bg-green-50 rounded-xl p-8 text-center">
            <div className="w-14 h-14 bg-[#16A34A] rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-[#111]">Thanks! We'll be in touch shortly.</p>
          </div>
        ) : (
          <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Restaurant Name</label>
              <input
                type="text" name="restaurant_name" required
                className="w-full h-11 px-4 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Your Name</label>
              <input
                type="text" name="name" required
                className="w-full h-11 px-4 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Email</label>
              <input
                type="email" name="email" required
                className="w-full h-11 px-4 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Phone</label>
              <input
                type="tel" name="phone"
                className="w-full h-11 px-4 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Message</label>
              <textarea
                name="message" rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base resize-none focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
              />
            </div>
            <button
              type="submit"
              className="w-full h-12 bg-[#16A34A] text-white font-bold rounded-lg hover:bg-[#15803D] transition-colors"
            >
              Send Message
            </button>
          </form>
        )}
      </div>
    </section>
  )
}

// ── Footer ──
function Footer() {
  return (
    <footer className="bg-[#111] py-8">
      <p className="text-center text-sm text-gray-500">&copy; 2026 DirectBite</p>
    </footer>
  )
}

// ── Landing Page ──
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white" style={{ scrollBehavior: 'smooth' }}>
      <Nav />
      <Hero />
      <PricingCalculator />
      <Difference />
      <Cta />
      <ContactForm />
      <Footer />
    </div>
  )
}
