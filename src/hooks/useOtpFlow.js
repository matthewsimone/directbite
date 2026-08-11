import { useState, useEffect, useRef, useCallback } from 'react'
import { useCustomerAuth } from './useCustomerAuth'

const RESEND_COOLDOWN_SECONDS = 60

// Progressive display format — state holds digits only, never this string.
export function formatPhone(digits) {
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

// The OTP sequence — phone entry, send, code entry, verify — with none of the
// presentation. Extracted from SignInSheet so a second surface can run the
// same flow inline without reproducing the guards and cooldown rules.
export function useOtpFlow({ restaurantId, onVerified }) {
  const { sendCode, verifyCode } = useCustomerAuth()

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

  useEffect(() => {
    if (cooldownSeconds <= 0) return
    const id = setInterval(() => setCooldownSeconds(s => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(id)
  }, [cooldownSeconds > 0])

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
      onVerified()
      return
    }
    setCode('')
    setError(
      res.error === 'network'
        ? 'Something went wrong. Please try again.'
        : "That code isn't right. Please try again."
    )
    codeInputRef.current?.focus()
  }, [verifyCode, phone, restaurantId, verifying, onVerified])

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

  function handlePhoneChange(e) {
    setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))
    setError(null)
  }

  function handleCodeChange(e) {
    setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
    setError(null)
  }

  // Back to a clean first step. The phone digits deliberately survive: both
  // callers — reopening the sheet and "Change" — want the number still there.
  const reset = useCallback(() => {
    setStep('phone')
    setCode('')
    setError(null)
    setSending(false)
    setVerifying(false)
    lastSentRef.current = null
    lastVerifiedRef.current = null
  }, [])

  return {
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
  }
}
