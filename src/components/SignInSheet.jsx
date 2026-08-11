import { useState, useEffect } from 'react'
import { useOtpFlow, formatPhone } from '../hooks/useOtpFlow'

// Must match the consent copy the edge function records alongside the
// verification — it is shown at the point the customer triggers the send.
const CONSENT_LINE = 'By continuing you agree to receive a one-time verification code by SMS. Message and data rates may apply.'

export default function SignInSheet({ open, onClose, onSuccess, restaurantId, brandColor }) {
  const [visible, setVisible] = useState(false)

  const {
    phone,
    code,
    step,
    sending,
    verifying,
    error,
    cooldownSeconds,
    codeInputRef,
    handlePhoneChange,
    handleCodeChange,
    handleSend,
    handleVerify,
    reset,
  } = useOtpFlow({
    restaurantId,
    onVerified: () => {
      onSuccess()
      handleClose()
    },
  })

  // Slide in on open; reset to a clean first step so a reopened sheet never
  // shows the previous attempt's code or error.
  useEffect(() => {
    if (!open) {
      setVisible(false)
      return
    }
    reset()
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [open, reset])

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 300)
  }

  if (!open) return null

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
                  onClick={reset}
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
