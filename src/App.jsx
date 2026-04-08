import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import LandingPage from './pages/LandingPage'
import MenuPage from './pages/customer/MenuPage'
import TabletPage from './pages/tablet/TabletPage'
import AdminPage from './pages/admin/AdminPage'

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/:slug" element={<MenuPage />} />
        <Route path="/:slug/tablet" element={<TabletPage />} />
      </Routes>
    </BrowserRouter>
  )
}
