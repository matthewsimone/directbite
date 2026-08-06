import { useState, useEffect, useRef, useCallback } from 'react'
import { useCustomerAuth } from '../hooks/useCustomerAuth'

// Must match the consent copy the edge function records alongside the
// verification — it is shown at the point the customer triggers the send.
const CONSENT_LINE = 'By continuing you agree to receive a one-time verification code by SMS. Message and data rates may apply.'
const RESEND_COOLDOWN_SECONDS = 60

// Progressive display format — state holds digits only, never this string.
function formatPhone(digits) {
  const d = digits.slice(0, 10)
  if (d.length === 0) return ''
  if (d.length <= 3) return `(${d}`
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

function sendErrorMessage(error, retryAfter) {
  switch (error) {
    case 'invalid_phone':
      return "That doesn't look like a valid mobile number."
    case 'cooldown':
      return `Please wait ${retryAfter} seconds before requesting another code.`
    case 'rate_limited':
      return 'Too many attempts. Please try again later.'
    default:
      return "Couldn't send the code. Please try again."
  }
}

export default function SignInSheet({ open, onClose, onSuccess, restaurantId, brandColor }) {
  const { sendCode, verifyCode } = useCustomerAuth()

  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)

  // Auto-fire guards: a number is sent at most once, and a code is submitted
  // at most once, without which the length-triggered effects below would
  // re-fire on every unrelated render.
  const lastSentRef = useRef(null)
  const lastVerifiedRef = useRef(null)
  const codeInputRef = useRef(null)

  // Slide in on open; reset to a clean first step so a reopened sheet never
  // shows the previous attempt's code or error.
  useEffect(() => {
    if (!open) {
      setVisible(false)
      return
    }
    setStep('phone')
    setCode('')
    setError(null)
    setSending(false)
    setVerifying(false)
    lastSentRef.current = null
    lastVerifiedRef.current = null
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const id = setInterval(() => setCooldownSeconds(s => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(id)
  }, [cooldownSeconds > 0])

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 300)
  }

  const handleSend = useCallback(async (digits, { resend = false } = {}) => {
    if (digits.length !== 10 || sending) return
    lastSentRef.current = digits
    setSending(true)
    setError(null)
    const res = await sendCode(digits, restaurantId)
    setSending(false)
    if (res.ok) {
      setStep('code')
      setCode('')
      lastVerifiedRef.current = null
      if (resend) setCooldownSeconds(RESEND_COOLDOWN_SECONDS)
      return
    }
    setError(sendErrorMessage(res.error, res.retryAfter))
    // The server's own cooldown wins over the local one — it knows how long
    // is actually left, and re-enabling sooner would only earn another 429.
    if (res.error === 'cooldown' && res.retryAfter) setCooldownSeconds(res.retryAfter)
  }, [sendCode, restaurantId, sending])

  const handleVerify = useCallback(async (value) => {
    if (value.length !== 6 || verifying) return
    lastVerifiedRef.current = value
    setVerifying(true)
    setError(null)
    const res = await verifyCode(phone, value, restaurantId)
    setVerifying(false)
    if (res.ok) {
      onSuccess()
      handleClose()
      return
    }
    setCode('')
    setError(
      res.error === 'network'
        ? 'Something went wrong. Please try again.'
        : "That code isn't right. Please try again."
    )
    codeInputRef.current?.focus()
  }, [verifyCode, phone, restaurantId, verifying, onSuccess])

  // Auto-fire on the tenth digit — the customer never has to reach for the
  // button, and the ref guard keeps a re-render from sending twice.
  useEffect(() => {
    if (step !== 'phone' || phone.length !== 10) return
    if (lastSentRef.current === phone) return
    handleSend(phone)
  }, [step, phone, handleSend])

  // Same for the sixth code digit.
  useEffect(() => {
    if (step !== 'code' || code.length !== 6) return
    if (lastVerifiedRef.current === code) return
    handleVerify(code)
  }, [step, code, handleVerify])

  useEffect(() => {
    if (step === 'code') codeInputRef.current?.focus()
  }, [step])

  if (!open) return null

  function handlePhoneChange(e) {
    setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))
    setError(null)
  }

  function handleCodeChange(e) {
    setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
    setError(null)
  }

  function handleChangeNumber() {
    setStep('phone')
    setCode('')
    setError(null)
    lastSentRef.current = null
    lastVerifiedRef.current = null
  }

  const phoneReady = phone.length === 10
  const codeReady = code.length === 6

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={handleClose}>
      <div
        className={`absolute inset-0 bg-black transition-opacity duration-300 ${
          visible ? 'opacity-50' : 'opacity-0'
        }`}
      />

      <div
        onClick={e => e.stopPropagation()}
        className={`relative w-full max-w-lg bg-white rounded-t-2xl max-h-[85vh] flex flex-col transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-300 rounded-full" />
        </div>

        <button
          onClick={handleClose}
          aria-label="Close"
          className="absolute top-3 right-4 w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="overflow-y-auto flex-1 px-5 pt-2 pb-6">
          {step === 'phone' ? (
            <>
              <h2 className="text-xl font-bold text-gray-900">Sign in</h2>
              <p className="text-gray-500 text-sm mt-1">
                Enter your mobile number and we'll text you a code.
              </p>

              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                placeholder="(555) 123-4567"
                value={formatPhone(phone)}
                onChange={handlePhoneChange}
                className="w-full h-12 px-4 mt-5 border border-gray-300 rounded-xl text-lg focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': brandColor }}
              />

              {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

              <button
                onClick={() => handleSend(phone)}
                disabled={!phoneReady || sending || cooldownSeconds > 0}
                className="w-full h-12 mt-4 rounded-xl text-white font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform"
                style={{ backgroundColor: brandColor }}
              >
                {sending ? 'Sending...' : cooldownSeconds > 0 ? `Send code in ${cooldownSeconds}s` : 'Send code'}
              </button>

              <p className="text-xs text-gray-400 mt-3">{CONSENT_LINE}</p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-gray-900">Enter your code</h2>
              <p className="text-gray-500 text-sm mt-1">
                We texted a 6-digit code to {formatPhone(phone)}.{' '}
                <button
                  onClick={handleChangeNumber}
                  className="font-semibold underline"
                  style={{ color: brandColor }}
                >
                  Change
                </button>
              </p>

              {/* One field, not six boxes — iOS only autofills an SMS code
                  into a single input carrying autocomplete="one-time-code". */}
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={handleCodeChange}
                className="w-full h-14 px-4 mt-5 border border-gray-300 rounded-xl text-3xl text-center tracking-[0.4em] focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': brandColor }}
              />

              {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

              <button
                onClick={() => handleVerify(code)}
                disabled={!codeReady || verifying}
                className="w-full h-12 mt-4 rounded-xl text-white font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform"
                style={{ backgroundColor: brandColor }}
              >
                {verifying ? 'Verifying...' : 'Verify'}
              </button>

              <button
                onClick={() => handleSend(phone, { resend: true })}
                disabled={cooldownSeconds > 0 || sending}
                className="w-full mt-3 text-sm text-gray-500 disabled:text-gray-400 hover:text-gray-700 transition-colors"
              >
                {cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : "Didn't get it? Resend"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
