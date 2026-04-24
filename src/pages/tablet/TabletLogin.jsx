import { useState } from 'react'
import DirectBiteLogo from '../../components/DirectBiteLogo'

export default function TabletLogin({ slug, onLogin, error: authError, termsAccepted }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [agreedToTerms, setAgreedToTerms] = useState(false)

  const needsAgreement = !termsAccepted

  async function handleSubmit(e) {
    e.preventDefault()
    if (needsAgreement && !agreedToTerms) return
    setLoading(true)
    await onLogin(email, password, needsAgreement && agreedToTerms)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-2"><DirectBiteLogo color="dark" height={32} /></div>
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

          {needsAgreement && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={agreedToTerms}
                onChange={e => setAgreedToTerms(e.target.checked)}
                className="accent-[#16A34A] w-5 h-5 mt-0.5 shrink-0"
              />
              <span className="text-sm text-gray-600">
                I agree to the{' '}
                <a href="https://directbite.co/terms" target="_blank" rel="noopener noreferrer" className="text-[#16A34A] underline">Terms of Service</a>
                {' '}and{' '}
                <a href="https://directbite.co/privacy" target="_blank" rel="noopener noreferrer" className="text-[#16A34A] underline">Privacy Policy</a>
              </span>
            </label>
          )}

          {authError && (
            <p className="text-red-600 text-sm text-center">{authError}</p>
          )}

          <button
            type="submit"
            disabled={loading || (needsAgreement && !agreedToTerms)}
            className="w-full h-12 bg-[#16A34A] text-white font-semibold rounded-xl text-base hover:bg-[#15803D] disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
