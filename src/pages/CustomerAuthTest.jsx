import { useState } from 'react'
import { useCustomerAuth } from '../hooks/useCustomerAuth'

// Throwaway probe for the customer-auth edge function + useCustomerAuth
// context. Not linked from anywhere; delete once testing is done.
export default function CustomerAuthTest() {
  const {
    customerId, phone, profile, loading, isLoggedIn,
    sendCode, verifyCode, logout, refresh,
  } = useCustomerAuth()

  const [phoneInput, setPhoneInput] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [sendResult, setSendResult] = useState(null)
  const [verifyResult, setVerifyResult] = useState(null)
  const [busy, setBusy] = useState(false)

  async function handleSend() {
    setBusy(true)
    setSendResult(null)
    setSendResult(await sendCode(phoneInput))
    setBusy(false)
  }

  async function handleVerify() {
    setBusy(true)
    setVerifyResult(null)
    setVerifyResult(await verifyCode(phoneInput, codeInput))
    setBusy(false)
  }

  async function handleLogout() {
    setBusy(true)
    await logout()
    setSendResult(null)
    setVerifyResult(null)
    setBusy(false)
  }

  async function handleRefresh() {
    setBusy(true)
    await refresh()
    setBusy(false)
  }

  return (
    <div className="p-6 max-w-md mx-auto space-y-6 font-mono text-sm">
      <h1 className="text-lg font-bold">customer-auth probe</h1>

      <div className="space-y-1">
        <p>loading: {String(loading)}</p>
        <p>isLoggedIn: {String(isLoggedIn)}</p>
        <p>customerId: {String(customerId)}</p>
        <p>phone: {String(phone)}</p>
        <p className="break-all">profile: {JSON.stringify(profile)}</p>
      </div>

      <div className="space-y-2">
        <input
          type="tel"
          value={phoneInput}
          onChange={e => setPhoneInput(e.target.value)}
          placeholder="+15551234567"
          className="w-full h-9 px-3 border border-gray-300 rounded-lg"
        />
        <button
          onClick={handleSend}
          disabled={busy}
          className="w-full h-10 border border-gray-400 rounded-lg disabled:opacity-50"
        >
          Send Code
        </button>
        <p className="break-all">sendCode: {JSON.stringify(sendResult)}</p>
      </div>

      <div className="space-y-2">
        <input
          type="text"
          value={codeInput}
          onChange={e => setCodeInput(e.target.value)}
          autoComplete="one-time-code"
          inputMode="numeric"
          placeholder="123456"
          className="w-full h-9 px-3 border border-gray-300 rounded-lg"
        />
        <button
          onClick={handleVerify}
          disabled={busy}
          className="w-full h-10 border border-gray-400 rounded-lg disabled:opacity-50"
        >
          Verify
        </button>
        <p className="break-all">verifyCode: {JSON.stringify(verifyResult)}</p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleLogout}
          disabled={busy}
          className="flex-1 h-10 border border-gray-400 rounded-lg disabled:opacity-50"
        >
          Logout
        </button>
        <button
          onClick={handleRefresh}
          disabled={busy}
          className="flex-1 h-10 border border-gray-400 rounded-lg disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
