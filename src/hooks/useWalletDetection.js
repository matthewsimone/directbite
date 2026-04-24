import { useState, useEffect } from 'react'
import { loadStripe } from '@stripe/stripe-js'

const CACHE_KEY = 'walletAvailability'
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''

function getCached(stripeAccount) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw)
    if (cached.stripeAccount !== stripeAccount) return null
    if (Date.now() - cached.timestamp > CACHE_TTL) return null
    return cached.result
  } catch {
    return null
  }
}

function setCache(stripeAccount, result) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      stripeAccount,
      result,
      timestamp: Date.now(),
    }))
  } catch { /* storage full — ignore */ }
}

export function useWalletDetection(stripeAccount) {
  const [result, setResult] = useState(() => getCached(stripeAccount))
  const [loading, setLoading] = useState(!getCached(stripeAccount))

  useEffect(() => {
    if (!stripeAccount || !STRIPE_PK) {
      setLoading(false)
      return
    }

    const cached = getCached(stripeAccount)
    if (cached) {
      setResult(cached)
      setLoading(false)
      return
    }

    let cancelled = false

    async function detect() {
      try {
        const stripe = await loadStripe(STRIPE_PK, { stripeAccount })
        if (!stripe || cancelled) return

        const pr = stripe.paymentRequest({
          country: 'US',
          currency: 'usd',
          total: { label: 'Availability check', amount: 100 },
          requestPayerName: true,
          requestPayerEmail: true,
          requestPayerPhone: true,
        })

        const canPay = await pr.canMakePayment()
        if (cancelled) return

        const detection = {
          applePay: canPay?.applePay || false,
          googlePay: canPay?.googlePay || false,
          link: canPay?.link || false,
        }

        setResult(detection)
        setCache(stripeAccount, detection)
      } catch (err) {
        console.error('[WalletDetection] Error:', err)
        setResult({ applePay: false, googlePay: false, link: false })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    detect()
    return () => { cancelled = true }
  }, [stripeAccount])

  return {
    applePay: result?.applePay || false,
    googlePay: result?.googlePay || false,
    link: result?.link || false,
    loading,
  }
}
