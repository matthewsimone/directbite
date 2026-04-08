import { useState } from 'react'

export default function TabletLogin({ slug, onLogin, error: authError }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    await onLogin(email, password)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">DirectBite</h1>
          <p className="text-gray-500 mt-1">Tablet Login</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full h-12 px-4 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A] focus:border-transparent"
              placeholder="restaurant@email.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full h-12 px-4 border border-gray-300 rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A] focus:border-transparent"
              placeholder="••••••••"
            />
          </div>

          {authError && (
            <p className="text-red-600 text-sm text-center">{authError}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 bg-[#16A34A] text-white font-semibold rounded-xl text-base hover:bg-[#15803D] disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
