import { useState, useEffect } from 'react'
import { loadStripe } from '@stripe/stripe-js'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '')

export default function ApplePayTest() {
  const [result, setResult] = useState('Loading Stripe...')
  const [key, setKey] = useState('')

  useEffect(() => {
    const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''
    setKey(pk.slice(0, 12) + '...')

    stripePromise.then(stripe => {
      if (!stripe) {
        setResult('ERROR: Stripe failed to load')
        return
      }

      setResult('Stripe loaded. Creating PaymentRequest...')

      const pr = stripe.paymentRequest({
        country: 'US',
        currency: 'usd',
        total: { label: 'Test', amount: 500 },
        requestPayerName: true,
        requestPayerEmail: true,
      })

      setResult('PaymentRequest created. Calling canMakePayment()...')

      pr.canMakePayment()
        .then(res => {
          setResult(JSON.stringify(res, null, 2))
        })
        .catch(err => {
          setResult('ERROR: ' + err.message)
        })
    })
  }, [])

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui', maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 8 }}>Apple Pay Test</h1>
      <p style={{ fontSize: 14, color: '#666', marginBottom: 24 }}>Key: {key}</p>
      <pre style={{
        fontSize: 18,
        fontWeight: 'bold',
        background: '#f5f5f5',
        padding: 20,
        borderRadius: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}>
        {result}
      </pre>
    </div>
  )
}
