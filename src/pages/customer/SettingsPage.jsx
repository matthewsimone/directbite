import { useParams, useNavigate } from 'react-router-dom'
import { useCustomerAuth } from '../../hooks/useCustomerAuth'

// Native shell Account tab (placeholder). Routed only when IS_NATIVE.
export default function SettingsPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const { isLoggedIn, logout } = useCustomerAuth()

  async function handleSignOut() {
    await logout()
    navigate(`/${slug}`, { replace: true })
  }

  return (
    <div className="min-h-screen bg-white ordr-tab-page">
      <div className="max-w-[720px] mx-auto px-6 pt-6">
        <h1 className="text-2xl font-bold text-gray-900">Account</h1>
        {isLoggedIn ? (
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full h-12 rounded-xl border border-gray-300 font-semibold text-gray-900 mt-6"
          >
            Sign out
          </button>
        ) : (
          <p className="mt-4 text-gray-500">Not signed in.</p>
        )}
      </div>
    </div>
  )
}
