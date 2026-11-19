import { Preferences } from '@capacitor/preferences'
import { IS_NATIVE } from './native'

// Customer session token. Web: localStorage, unchanged. Native: Preferences
// (survives WKWebView storage eviction), mirrored in memory so every read
// stays synchronous — callers include the payment path.
const KEY = 'ordr_customer_token'
let mem = null

// Native only. Must resolve before React mounts. Never throws.
export async function hydrateToken() {
  if (!IS_NATIVE) return
  try {
    const { value } = await Preferences.get({ key: KEY })
    mem = value ?? null
  } catch {
    mem = null
  }
}

export function readToken() {
  if (IS_NATIVE) return mem
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function writeToken(token) {
  if (IS_NATIVE) {
    mem = token
    Preferences.set({ key: KEY, value: token }).catch(() => {})
    return
  }
  try { localStorage.setItem(KEY, token) } catch { /* storage full or blocked */ }
}

export function clearToken() {
  if (IS_NATIVE) {
    mem = null
    Preferences.remove({ key: KEY }).catch(() => {})
    return
  }
  try { localStorage.removeItem(KEY) } catch { /* storage blocked */ }
}
