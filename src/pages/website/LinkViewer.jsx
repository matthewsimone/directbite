import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useRestaurant } from '../../hooks/useRestaurant'
import { getStatus } from './utils/hours'
import { isMainDomain } from '../../lib/customDomain'
import TopBar from './components/TopBar'
import Footer from './components/Footer'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const DEFAULT_BRAND_COLOR = '#16a34a'

// Render every page of a PDF stacked in one scrollable column. Mobile-first:
// each canvas fills the container width (capped by the parent's max-w), scaled
// by devicePixelRatio so it stays crisp on retina.
function PdfPages({ url }) {
  const containerRef = useRef(null)
  const [phase, setPhase] = useState('loading') // 'loading' | 'done' | 'error'

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''

    async function render() {
      try {
        const pdf = await pdfjsLib.getDocument({ url }).promise
        if (cancelled) return
        const maxWidth = Math.min(container.clientWidth || 900, 900)
        const dpr = window.devicePixelRatio || 1
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cancelled) return
          const page = await pdf.getPage(n)
          const base = page.getViewport({ scale: 1 })
          const cssScale = maxWidth / base.width
          const viewport = page.getViewport({ scale: cssScale * dpr })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.style.display = 'block'
          canvas.style.marginBottom = '16px'
          canvas.className = 'rounded-lg shadow-sm'
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
          if (cancelled) return
          container.appendChild(canvas)
        }
        if (!cancelled) setPhase('done')
      } catch (err) {
        console.error('[LinkViewer] PDF render failed', err)
        if (!cancelled) setPhase('error')
      }
    }
    render()
    return () => { cancelled = true }
  }, [url])

  return (
    <div>
      <div ref={containerRef} />
      {phase === 'loading' && (
        <p className="text-center text-gray-500 py-8">Loading PDF…</p>
      )}
      {phase === 'error' && (
        <p className="text-center text-red-500 py-8">
          Couldn’t load this PDF.{' '}
          <a href={url} className="underline" target="_blank" rel="noopener noreferrer">Open it directly</a>.
        </p>
      )}
    </div>
  )
}

export default function LinkViewer({ restaurant: propRestaurant, hours: propHours }) {
  const { slug: paramSlug, linkPath } = useParams()
  const hook = useRestaurant(propRestaurant ? null : paramSlug)
  const restaurant = propRestaurant || hook.restaurant
  const hours = propHours || hook.hours
  const loading = propRestaurant ? false : hook.loading

  const [status, setStatus] = useState({ isOpen: false, statusText: 'CLOSED', todaysHours: null })
  useEffect(() => {
    function tick() { setStatus(getStatus(hours || [], new Date())) }
    tick()
    const interval = setInterval(tick, 60000)
    return () => clearInterval(interval)
  }, [hours])

  if (loading) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-[#16A34A] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!restaurant) {
    return (
      <div className="min-h-dvh bg-white flex items-center justify-center text-gray-500">
        Not found
      </div>
    )
  }

  const brandColor = restaurant.primary_color || DEFAULT_BRAND_COLOR
  const link = (restaurant.website_links || []).find(l => l.path === linkPath)
  const homeHref = isMainDomain() ? `/${restaurant.slug}/home` : '/'

  return (
    <div className="min-h-dvh bg-white flex flex-col" style={{ '--brand-color': brandColor }}>
      <TopBar restaurant={restaurant} status={status} hours={hours} solid />

      {!link ? (
        <main className="flex-1 max-w-[900px] mx-auto w-full px-4 py-16 text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-3">Page not found</h1>
          <p className="text-gray-600 mb-6">This link doesn’t exist or may have been removed.</p>
          <Link to={homeHref} className="font-semibold" style={{ color: 'var(--brand-color)' }}>
            ← Back to home
          </Link>
        </main>
      ) : (
        <main className="flex-1 max-w-[900px] mx-auto w-full px-4 py-8">
          <div className="flex items-center justify-between gap-4 mb-6">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900">{link.label}</h1>
            <a
              href={link.href}
              download
              className="shrink-0 px-4 h-10 inline-flex items-center rounded-lg text-white font-semibold text-sm"
              style={{ backgroundColor: 'var(--brand-color)' }}
            >
              Download PDF
            </a>
          </div>
          <PdfPages key={link.href} url={link.href} />
        </main>
      )}

      <Footer restaurant={restaurant} hours={hours} />
    </div>
  )
}
