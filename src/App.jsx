import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { CartProvider } from './hooks/useCart'
import { isMainDomain } from './lib/customDomain'
import LandingPage from './pages/LandingPage'
import MenuPage from './pages/customer/MenuPage'
import CheckoutPage from './pages/customer/CheckoutPage'
import ConfirmationPage from './pages/customer/ConfirmationPage'
import TabletPage from './pages/tablet/TabletPage'
import AdminPage from './pages/admin/AdminPage'
import PrivacyPolicy from './pages/PrivacyPolicy'
import TermsOfService from './pages/TermsOfService'
import HomePage from './pages/website/HomePage'
import MenuStaticRoute from './pages/website/MenuStaticRoute'
import PlaceStaticRoute from './pages/website/PlaceStaticRoute'
import TagStaticRoute from './pages/website/TagStaticRoute'
import CustomDomainShell from './CustomDomainShell'
import { LinkBaseProvider } from './pages/website/LinkBaseContext'

// Dev-only diagnostic route. Lazy-loaded so its `@stripe/stripe-js`
// import doesn't ship in the main bundle on website / customer / tablet
// routes.
const ApplePayTest = lazy(() => import('./pages/ApplePayTest'))
const LinkViewer = lazy(() => import('./pages/website/LinkViewer'))

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
      <Route path="/" element={<LandingPage />} />
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
      <Route path="/:slug/confirmation" element={<ConfirmationPage />} />
      <Route path="/:slug/tablet" element={<TabletPage />} />
      <Route path="/:slug/tablet/login" element={<TabletPage />} />
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
      <Toaster position="top-center" toastOptions={{ duration: 2000 }} />
      <CartProvider>
        {isMainDomain() ? <MainRoutes /> : <CustomDomainShell />}
      </CartProvider>
    </BrowserRouter>
  )
}
