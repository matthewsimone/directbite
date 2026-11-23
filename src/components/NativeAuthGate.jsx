import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { IS_NATIVE, APP_SLUG, getPublicOrigin } from '../lib/native'
import { applyNativeBrand } from '../lib/nativeBrand'
import { useCustomerAuth } from '../hooks/useCustomerAuth'
import { readToken } from '../lib/tokenStore'
import { installPushListeners, syncPushToken } from '../lib/nativePush'
import SignInSheet from './SignInSheet'
import LogoFrame from './LogoFrame'

// Native shell only: signed-out customers see a welcome + sign-in screen
// instead of the app. On web the wrapper returns children before any hook
// runs, so nothing here executes.
export default function NativeAuthGate({ children }) {
  if (!IS_NATIVE || !APP_SLUG) return children
  return <GateInner slug={APP_SLUG}>{children}</GateInner>
}

function GateInner({ slug, children }) {
  const { loading, isLoggedIn, refresh } = useCustomerAuth()
  const navigate = useNavigate()
  const [settled, setSettled] = useState(false)
  if (!loading && !settled) setSettled(true)

  // Push: listeners once per app run; tapping a notification opens the menu.
  useEffect(() => {
    installPushListeners(() => navigate(`/${slug}`))
  }, [navigate, slug])

  // Register (or refresh) this device's push token whenever a session resolves.
  useEffect(() => {
    if (isLoggedIn) syncPushToken()
  }, [isLoggedIn])

  // A stored token with no session usually means the launch-time check failed
  // offline. Re-check when the app returns to the foreground or the network
  // comes back, so a signed-in customer isn't stuck on the welcome screen.
  useEffect(() => {
    function recheck() {
      if (!isLoggedIn && readToken() && document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('online', recheck)
    return () => {
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('online', recheck)
    }
  }, [isLoggedIn, refresh])

  // Blank splash while the stored session resolves, so the menu never flashes.
  if (loading && !settled) return <div className="min-h-screen bg-white" />
  if (isLoggedIn) return children
  return <WelcomeScreen slug={slug} />
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

function WelcomeScreen({ slug }) {
  const [rest, setRest] = useState(null)
  const [photos, setPhotos] = useState([])
  const [slide, setSlide] = useState(0)
  const [signInOpen, setSignInOpen] = useState(false)

  // Lock page scroll while the welcome screen is up.
  useEffect(() => {
    document.documentElement.classList.add('ordr-lock')
    return () => document.documentElement.classList.remove('ordr-lock')
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await supabase
        .from('restaurants')
        .select('id, name, logo_url, logo_frame_shape, primary_color, loyalty_enabled')
        .eq('slug', slug)
        .single()
      if (!alive || !data) return
      setRest(data)
      applyNativeBrand(data.primary_color)

      // Failure here just means no photo strip — no toast.
      const { data: items, error } = await supabase
        .from('menu_items')
        .select('image_url')
        .eq('restaurant_id', data.id)
        .eq('is_available', true)
        .not('image_url', 'is', null)
        .order('is_popular', { ascending: false })
        .limit(8)
      if (!alive || error || !items) return
      setPhotos(items.map((i) => i.image_url).filter(Boolean))
    })()
    return () => { alive = false }
  }, [slug])

  const brand = HEX.test(rest?.primary_color?.trim() || '') ? rest.primary_color.trim() : '#16A34A'

  const slides = [
    { title: 'Welcome', body: 'Order direct for the best prices and the fastest service.' },
    { title: 'Easy reordering', body: 'Reorder your favorites in just a few taps.' },
    ...(rest?.loyalty_enabled === true ? [{ title: 'Earn rewards', body: 'Earn points on every order and redeem them for free food.' }] : []),
  ]
  const last = slides.length - 1
  const current = Math.min(slide, last)
  const { title, body } = slides[current]

  return (
    <div className="ordr-welcome bg-white flex flex-col overflow-hidden">
      <div className="pt-6 shrink-0 flex justify-center">
        {rest && (
          <LogoFrame
            logoUrl={rest.logo_url}
            shape={rest.logo_frame_shape}
            name={rest.name}
            brandColor={brand}
            sizePx={104}
            marginCls="mb-0"
          />
        )}
      </div>

      <div className="flex-1 min-h-0 flex items-center py-4">
        {photos.length > 0 && (
          <div className="w-full h-full max-h-56 overflow-x-auto flex items-center gap-4 px-6 snap-x snap-mandatory">
            {photos.map((url) => (
              <img
                key={url}
                src={url}
                alt=""
                loading="lazy"
                className="h-full aspect-square shrink-0 rounded-3xl object-cover snap-center"
              />
            ))}
          </div>
        )}
      </div>

      <div className="px-6 shrink-0 ordr-welcome-bottom text-center">
        <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
        <p className="mt-3 text-lg text-gray-600 min-h-[3.5rem]">{body}</p>

        <div className="flex justify-center gap-2 mt-6">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Slide ${i + 1}`}
              onClick={() => setSlide(i)}
              className={`w-2 h-2 rounded-full border border-gray-900 ${i === current ? 'bg-gray-900' : 'bg-transparent'}`}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => (current < last ? setSlide(current + 1) : setSignInOpen(true))}
          className="w-full h-14 mt-6 rounded-2xl text-white text-lg font-semibold active:scale-[0.98] transition-transform"
          style={{ backgroundColor: brand }}
        >
          {current < last ? 'Next' : 'Sign in'}
        </button>

        <p className={`text-xs text-gray-400 mt-4 ${current === last ? '' : 'invisible'}`}>
          <a href={`${getPublicOrigin()}/terms`} target="_blank" rel="noopener">Terms</a>
          {' · '}
          <a href={`${getPublicOrigin()}/privacy`} target="_blank" rel="noopener">Privacy</a>
        </p>
      </div>

      <SignInSheet
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        // Verify flips isLoggedIn; GateInner then renders the app.
        onSuccess={() => {}}
        restaurantId={rest?.id ?? null}
        brandColor={brand}
      />
    </div>
  )
}
