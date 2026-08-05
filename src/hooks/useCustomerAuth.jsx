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

export function CustomerAuthProvider({ children, restaurantId = null }) {
  const [customerId, setCustomerId] = useState(null)
  const [phone, setPhone] = useState(null)
  const [profile, setProfile] = useState(null)
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
        setProfile(null)
        setLoading(false)
      }
      return
    }

    if (isCurrent()) setLoading(true)

    try {
      const { ok, data } = await callCustomerAuth(
        { action: 'session', token, restaurant_id: restaurantId },
        controller.signal
      )
      if (!isCurrent()) return
      if (!ok || !data.ok) {
        clearToken()
        setCustomerId(null)
        setPhone(null)
        setProfile(null)
        return
      }
      setCustomerId(data.customer_id ?? null)
      setPhone(data.phone_e164 ?? null)
      setProfile(data.profile ?? null)
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
  }, [restaurantId])

  // Re-runs on restaurantId change so `profile` is scoped to the restaurant
  // currently being viewed.
  useEffect(() => {
    checkSession()
  }, [checkSession])

  const sendCode = useCallback(async (phoneArg) => {
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
  }, [restaurantId])

  const verifyCode = useCallback(async (phoneArg, code) => {
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
        setProfile(data.profile ?? null)
        setLoading(false)
      }
      return { ok: true }
    } catch {
      return { ok: false, error: 'network' }
    }
  }, [restaurantId])

  const logout = useCallback(async () => {
    const token = readToken()
    try {
      if (token) await callCustomerAuth({ action: 'logout', token })
    } catch { /* a failed revoke must not strand the UI logged in */ }
    clearToken()
    if (mountedRef.current) {
      setCustomerId(null)
      setPhone(null)
      setProfile(null)
      setLoading(false)
    }
  }, [])

  return (
    <CustomerAuthContext.Provider
      value={{
        customerId,
        phone,
        profile,
        loading,
        isLoggedIn: customerId !== null,
        sendCode,
        verifyCode,
        logout,
        refresh: checkSession,
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
