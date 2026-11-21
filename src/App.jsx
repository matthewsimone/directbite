import { lazy, Suspense, useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { CartProvider } from './hooks/useCart'
import { CustomerAuthProvider } from './hooks/useCustomerAuth'
import { isMainDomain } from './lib/customDomain'
import { APP_SLUG, IS_NATIVE } from './lib/native'
import LandingPage from './pages/LandingPage'
import MenuPage from './pages/customer/MenuPage'
import CheckoutPage from './pages/customer/CheckoutPage'
import ConfirmationPage from './pages/customer/ConfirmationPage'
import RewardsPage from './pages/customer/RewardsPage'
import AccountPage from './pages/customer/AccountPage'
import SettingsPage from './pages/customer/SettingsPage'
import TabletPage from './pages/tablet/TabletPage'
import AdminPage from './pages/admin/AdminPage'
import PrivacyPolicy from './pages/PrivacyPolicy'
import TermsOfService from './pages/TermsOfService'
import HomePage from './pages/website/HomePage'
import MenuStaticRoute from './pages/website/MenuStaticRoute'
import PlaceStaticRoute from './pages/website/PlaceStaticRoute'
import TagStaticRoute from './pages/website/TagStaticRoute'
import CustomDomainShell from './CustomDomainShell'
import NativeTabBar from './components/NativeTabBar'
import NativeAuthGate from './components/NativeAuthGate'
import { LinkBaseProvider } from './pages/website/LinkBaseContext'

// Dev-only diagnostic route. Lazy-loaded so its `@stripe/stripe-js`
// import doesn't ship in the main bundle on website / customer / tablet
// routes.
const ApplePayTest = lazy(() => import('./pages/ApplePayTest'))
const LinkViewer = lazy(() => import('./pages/website/LinkViewer'))

// Native toasts: neutral gray glass. Errors keep the library's red icon.
const NATIVE_TOAST_OPTIONS = {
  duration: 2000,
  style: {
    background: 'rgba(243,244,246,0.92)',
    color: '#1F2937',
    border: '1px solid rgba(0,0,0,0.06)',
    borderRadius: '14px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
    backdropFilter: 'saturate(180%) blur(16px)',
    WebkitBackdropFilter: 'saturate(180%) blur(16px)',
    fontWeight: 500,
  },
  success: { iconTheme: { primary: '#374151', secondary: '#F3F4F6' } },
  loading: { iconTheme: { primary: '#374151', secondary: '#E5E7EB' } },
}

// react-hot-toast pins each toast with inline top:0 / bottom:0 and a
// direction-signed translateY chosen from `position`, so CSS can't flip a
// container between top and bottom. Switch the prop instead: bottom above the
// tab bar while NativeTabBar marks html.ordr-has-tabbar, top otherwise
// (Checkout's Pay bar, Confirmation, sign-in, keyboard open) and while an
// overlay is open (html.ordr-sheet-open, kept in sync by lib/nativeBack).
// This is only the default: a toast with its own `position` keeps it.
function nativeToastAtBottom() {
  const c = document.documentElement.classList
  return c.contains('ordr-has-tabbar') && !c.contains('ordr-sheet-open')
}

function NativeToaster() {
  const [atBottom, setAtBottom] = useState(nativeToastAtBottom)
  useEffect(() => {
    const obs = new MutationObserver(() => setAtBottom(nativeToastAtBottom()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return (
    <Toaster
      position={atBottom ? 'bottom-center' : 'top-center'}
      containerClassName="ordr-toaster"
      toastOptions={NATIVE_TOAST_OPTIONS}
    />
  )
}

// Provides the slug-prefixed link base (`/${slug}`) to the SEO page components
// on the main domain, read from the route params. Applied ONLY to the three
// SEO routes — every other route stays unwrapped so its link consumers hit the
// null fallback and behave byte-identically.
function SlugLinkBase({ children }) {
  const { slug } = useParams()
  return <LinkBaseProvider value={`/${slug}`}>{children}</LinkBaseProvider>
}

function MainRoutes() {
  return (
    <Routes>
      <Route path="/" element={APP_SLUG ? <Navigate to={`/${APP_SLUG}`} replace /> : <LandingPage />} />
      <Route
        path="/applepay-test"
        element={
          <Suspense fallback={null}>
            <ApplePayTest />
          </Suspense>
        }
      />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/admin/login" element={<AdminPage />} />
      <Route path="/:slug" element={<MenuPage />} />
      <Route path="/:slug/home" element={<SlugLinkBase><HomePage /></SlugLinkBase>} />
      <Route path="/:slug/menu" element={<SlugLinkBase><MenuStaticRoute /></SlugLinkBase>} />
      <Route path="/:slug/places/:townSlug" element={<SlugLinkBase><PlaceStaticRoute /></SlugLinkBase>} />
      <Route path="/:slug/tags/:tagSlug" element={<SlugLinkBase><TagStaticRoute /></SlugLinkBase>} />
      <Route path="/:slug/checkout" element={<CheckoutPage />} />
      <Route path="/:slug/rewards" element={<RewardsPage />} />
      <Route path="/:slug/account" element={<AccountPage />} />
      <Route path="/:slug/confirmation" element={<ConfirmationPage />} />
      <Route path="/:slug/tablet" element={<TabletPage />} />
      <Route path="/:slug/tablet/login" element={<TabletPage />} />
      {IS_NATIVE && <Route path="/:slug/settings" element={<SettingsPage />} />}
      <Route
        path="/:slug/:linkPath"
        element={
          <Suspense fallback={null}>
            <LinkViewer />
          </Suspense>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      {IS_NATIVE
        ? <NativeToaster />
        : <Toaster position="top-center" toastOptions={{ duration: 2000, success: { iconTheme: { primary: 'var(--brand, #16A34A)', secondary: '#fff' } } }} />}
      <CartProvider>
        <CustomerAuthProvider>
          <NativeAuthGate>
            {isMainDomain() ? <MainRoutes /> : <CustomDomainShell />}
            <NativeTabBar />
          </NativeAuthGate>
        </CustomerAuthProvider>
      </CartProvider>
    </BrowserRouter>
  )
}
