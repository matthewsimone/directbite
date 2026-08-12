import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'

// New keys use the ordr_ prefix. The cart's directbite_ prefix predates the
// domain migration and is deliberately NOT followed here.
const STORAGE_KEY = 'ordr_customer_token'

// Sent with every 'send' request as the consent proof the edge function
// records alongside the verification. Must match the copy shown to the
// customer at the point they tap send.
const CONSENT_TEXT = 'By continuing you agree to receive a one-time verification code by SMS. Message and data rates may apply.'

function readToken() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeToken(token) {
  try {
    localStorage.setItem(STORAGE_KEY, token)
  } catch { /* storage full or blocked — ignore */ }
}

function clearToken() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage blocked — ignore */ }
}

// Customers have no Supabase session, so every call authenticates with the
// anon key alone — sent as both `apikey` and `Authorization`, matching
// ConfirmationPage's get-order-by-pi call. Never throws on a non-2xx; the
// caller branches on `ok` and reads the error out of `data`.
async function callCustomerAuth(body, signal) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  const res = await fetch(`${supabaseUrl}/functions/v1/customer-auth`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

const CustomerAuthContext = createContext(null)

// Holds IDENTITY only — who the customer is, not what they have anywhere.
// The provider is mounted above the router, so it cannot know which
// restaurant a page is showing. Per-restaurant profile data (points, tier,
// name) is fetched by whichever page needs it via loadProfile, which keeps a
// page from ever displaying another restaurant's balance.
export function CustomerAuthProvider({ children }) {
  const [customerId, setCustomerId] = useState(null)
  const [phone, setPhone] = useState(null)
  const [loading, setLoading] = useState(true)

  // Tracks whether the component is still mounted so async setState calls
  // after unmount become no-ops. Set true on every (re)mount to handle
  // React StrictMode's mount→unmount→mount cycle in dev.
  const mountedRef = useRef(true)
  // Controller for the current session check; a newer check (or unmount)
  // aborts the prior one so a stale response can never overwrite it.
  const sessionAbortRef = useRef(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionAbortRef.current?.abort()
    }
  }, [])

  // Resolves the stored token against the edge function. A missing, expired
  // or rejected token is the ordinary logged-out case, NOT an error: the key
  // is dropped and state stays null without anything surfacing to the UI.
  const checkSession = useCallback(async () => {
    // Supersede any in-flight check; this one now owns the state.
    sessionAbortRef.current?.abort()
    const controller = new AbortController()
    sessionAbortRef.current = controller
    // Only the current (non-superseded, still-mounted) check may write state.
    const isCurrent = () => mountedRef.current && sessionAbortRef.current === controller

    const token = readToken()
    if (!token) {
      if (isCurrent()) {
        setCustomerId(null)
        setPhone(null)
        setLoading(false)
      }
      return
    }

    if (isCurrent()) setLoading(true)

    try {
      const { ok, data } = await callCustomerAuth(
        { action: 'session', token },
        controller.signal
      )
      if (!isCurrent()) return
      if (!ok || !data.ok) {
        clearToken()
        setCustomerId(null)
        setPhone(null)
        return
      }
      setCustomerId(data.customer_id ?? null)
      setPhone(data.phone_e164 ?? null)
    } catch (err) {
      if (err?.name === 'AbortError') return
      // A network failure is not evidence the token is bad — the request
      // never reached a verdict — so the token is preserved and the next
      // session check will retry. Only a server rejection (the
      // `!ok || !data.ok` branch above) clears it. Existing state is left
      // exactly as it was.
      return
    } finally {
      // Only the current (non-superseded) check clears loading.
      if (isCurrent()) setLoading(false)
    }
  }, [])

  // Runs once on mount — identity does not vary by restaurant.
  useEffect(() => {
    checkSession()
  }, [checkSession])

  // restaurantId is optional: when the caller knows it, the edge function
  // records the consent row against that restaurant.
  const sendCode = useCallback(async (phoneArg, restaurantId = null) => {
    try {
      const { ok, data } = await callCustomerAuth({
        action: 'send',
        phone: phoneArg,
        restaurant_id: restaurantId,
        origin: window.location.origin,
        consent_text: CONSENT_TEXT,
      })
      if (ok && data.ok) return { ok: true }
      return {
        ok: false,
        error: data.error || 'send_failed',
        retryAfter: data.retry_after ?? null,
      }
    } catch {
      return { ok: false, error: 'network', retryAfter: null }
    }
  }, [])

  // restaurantId is optional: when the caller knows it, the edge function
  // upserts the customer's profile row for that restaurant on verify.
  const verifyCode = useCallback(async (phoneArg, code, restaurantId = null) => {
    try {
      const { ok, data } = await callCustomerAuth({
        action: 'verify',
        phone: phoneArg,
        code,
        restaurant_id: restaurantId,
        origin: window.location.origin,
        surface: 'web',
      })
      if (!ok || !data.ok || !data.token) {
        return { ok: false, error: data.error || 'invalid_code' }
      }
      writeToken(data.token)
      if (mountedRef.current) {
        setCustomerId(data.customer_id ?? null)
        // The verify response carries no phone_e164 — the normalized number
        // is only echoed by 'session', so the caller's argument stands in
        // until the next session check refreshes it.
        setPhone(phoneArg)
        setLoading(false)
      }
      return { ok: true }
    } catch {
      return { ok: false, error: 'network' }
    }
  }, [])

  const logout = useCallback(async () => {
    const token = readToken()
    try {
      if (token) await callCustomerAuth({ action: 'logout', token })
    } catch { /* a failed revoke must not strand the UI logged in */ }
    clearToken()
    if (mountedRef.current) {
      setCustomerId(null)
      setPhone(null)
      setLoading(false)
    }
  }, [])

  // Per-restaurant profile fetch for the caller's own use. Deliberately sets
  // no provider state — the result belongs to the page that asked for it, so
  // two pages on different restaurants cannot overwrite each other. Returns
  // the profile object, or null on any failure.
  const loadProfile = useCallback(async (restaurantId) => {
    if (!restaurantId) return null
    const token = readToken()
    if (!token) return null
    try {
      const { ok, data } = await callCustomerAuth({
        action: 'session',
        token,
        restaurant_id: restaurantId,
      })
      if (!ok || !data.ok) return null
      return data.profile ?? null
    } catch {
      return null
    }
  }, [])

  // The identity's saved contact + address, shared across every restaurant.
  // Same contract as loadProfile: no provider state, null on any failure —
  // including when the action isn't deployed yet, which callers must treat as
  // "nothing saved" rather than an error.
  const loadSavedProfile = useCallback(async () => {
    const token = readToken()
    if (!token) return null
    try {
      const { ok, data } = await callCustomerAuth({
        action: 'profile',
        token,
      })
      if (!ok || !data.ok) return null
      return data.profile ?? null
    } catch {
      return null
    }
  }, [])

  // Same contract as loadProfile: per-restaurant, no provider state, null on
  // any failure. The edge function degrades a failed side to an empty array,
  // so a non-null result may still carry one empty list.
  const loadHistory = useCallback(async (restaurantId) => {
    if (!restaurantId) return null
    const token = readToken()
    if (!token) return null
    try {
      const { ok, data } = await callCustomerAuth({
        action: 'history',
        token,
        restaurant_id: restaurantId,
      })
      if (!ok || !data.ok) return null
      return { orders: data.orders ?? [], transactions: data.transactions ?? [] }
    } catch {
      return null
    }
  }, [])

  // Records the Stripe Customer behind an order against this identity, so a
  // later charge can find the card. Called from the confirmation screen, which
  // holds a payment intent and a slug rather than ids. Resolves to
  // { linked: false } on every failure and never throws — the customer is
  // looking at a confirmed order and must not see anything about this.
  const linkPaymentCustomer = useCallback(async (slug, paymentIntentId) => {
    const token = readToken()
    if (!token) return { linked: false }
    try {
      const { ok, data } = await callCustomerAuth({
        action: 'link_payment_customer',
        token,
        slug,
        payment_intent_id: paymentIntentId,
      })
      if (!ok || !data.ok) return { linked: false }
      return { linked: data.linked === true }
    } catch {
      return { linked: false }
    }
  }, [])

  // The one place the raw token leaves this module. create-payment-intent
  // needs it to find the customer's existing Stripe Customer, and it must
  // travel as a top-level field — never inside order_data, which is persisted
  // wholesale. Deliberately narrow so readToken itself stays unexported.
  const getSessionTokenForPayment = useCallback(() => readToken(), [])

  return (
    <CustomerAuthContext.Provider
      value={{
        customerId,
        phone,
        loading,
        isLoggedIn: customerId !== null,
        sendCode,
        verifyCode,
        logout,
        refresh: checkSession,
        loadProfile,
        loadHistory,
        loadSavedProfile,
        linkPaymentCustomer,
        getSessionTokenForPayment,
      }}
    >
      {children}
    </CustomerAuthContext.Provider>
  )
}

export function useCustomerAuth() {
  const ctx = useContext(CustomerAuthContext)
  if (!ctx) throw new Error('useCustomerAuth must be used within CustomerAuthProvider')
  return ctx
}
