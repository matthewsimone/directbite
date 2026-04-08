import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { CartProvider } from './hooks/useCart'
import LandingPage from './pages/LandingPage'
import MenuPage from './pages/customer/MenuPage'
import CheckoutPage from './pages/customer/CheckoutPage'
import ConfirmationPage from './pages/customer/ConfirmationPage'
import TabletPage from './pages/tablet/TabletPage'
import AdminPage from './pages/admin/AdminPage'

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-center" toastOptions={{ duration: 2000 }} />
      <CartProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/:slug" element={<MenuPage />} />
          <Route path="/:slug/checkout" element={<CheckoutPage />} />
          <Route path="/:slug/confirmation" element={<ConfirmationPage />} />
          <Route path="/:slug/tablet" element={<TabletPage />} />
        </Routes>
      </CartProvider>
    </BrowserRouter>
  )
}
