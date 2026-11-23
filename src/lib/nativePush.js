import { Capacitor } from '@capacitor/core'
import { IS_NATIVE, APP_SLUG } from './native'
import { readToken } from './tokenStore'
import { callCustomerAuth } from './customerAuthApi'

// Native push (FCM via @capacitor-firebase/messaging). Every export is a no-op
// or a safe value on web. The plugin, Preferences and App are loaded with
// dynamic import() inside functions, so the messaging plugin (and the firebase
// web SDK its web fallback pulls in) stays out of the entry bundle.
//
// The FCM token is never logged.

const PUSH_TOKEN_KEY = 'ordr_push_token'

// Wrapped, never bare: resolving an async function with a Capacitor plugin proxy probes .then on it, which the proxy forwards to native ("not implemented").
async function loadMessaging() {
  const { FirebaseMessaging } = await import('@capacitor-firebase/messaging')
  return { FirebaseMessaging }
}

async function loadPreferences() {
  const { Preferences } = await import('@capacitor/preferences')
  return { Preferences }
}

// 'prompt-with-rationale' (Android) is still askable, so it maps to 'prompt'.
function mapPermission(receive) {
  if (receive === 'granted') return 'granted'
  if (receive === 'denied') return 'denied'
  if (receive === 'prompt' || receive === 'prompt-with-rationale') return 'prompt'
  return 'unsupported'
}

// 'granted' | 'denied' | 'prompt' | 'unsupported'
export async function getPushPermission() {
  if (!IS_NATIVE) return 'unsupported'
  try {
    const { FirebaseMessaging } = await loadMessaging()
    const { receive } = await FirebaseMessaging.checkPermissions()
    return mapPermission(receive)
  } catch {
    console.warn('[push] checkPermissions failed')
    return 'unsupported'
  }
}

// Shows the OS prompt (if still askable). Registers the token when granted.
export async function requestPushPermission() {
  if (!IS_NATIVE) return 'unsupported'
  try {
    const { FirebaseMessaging } = await loadMessaging()
    const { receive } = await FirebaseMessaging.requestPermissions()
    const state = mapPermission(receive)
    if (state === 'granted') await syncPushToken()
    return state
  } catch {
    console.warn('[push] requestPermissions failed')
    return 'unsupported'
  }
}

// Registers this device's FCM token against the signed-in customer at this
// restaurant app. Only when native, signed in and permission granted. Safe to
// call repeatedly — register_push upserts on the token. Never throws.
export async function syncPushToken() {
  if (!IS_NATIVE || !APP_SLUG) return
  const sessionToken = readToken()
  if (!sessionToken) return
  try {
    if ((await getPushPermission()) !== 'granted') return

    const { FirebaseMessaging } = await loadMessaging()
    const { token: pushToken } = await FirebaseMessaging.getToken()
    if (!pushToken) return

    const { Preferences } = await loadPreferences()
    await Preferences.set({ key: PUSH_TOKEN_KEY, value: pushToken })

    const { App } = await import('@capacitor/app')
    const { id: appId } = await App.getInfo()

    const { ok, data } = await callCustomerAuth({
      action: 'register_push',
      token: sessionToken,
      slug: APP_SLUG,
      push_token: pushToken,
      platform: Capacitor.getPlatform(),
      app_id: appId,
    })
    if (!ok || !data.ok) console.warn('[push] register_push failed:', data?.error || 'unknown')
  } catch {
    console.warn('[push] token sync failed')
  }
}

// The last FCM token this device registered, or null. Used by logout so the
// server can drop it.
export async function getStoredPushToken() {
  if (!IS_NATIVE) return null
  try {
    const { Preferences } = await loadPreferences()
    const { value } = await Preferences.get({ key: PUSH_TOKEN_KEY })
    return value ?? null
  } catch {
    return null
  }
}

// Installed once per app run. The open handler is kept in a module variable
// so a later call can refresh it without adding a second listener.
let listenersInstalled = false
let openHandler = null

export function installPushListeners(onOpen) {
  if (!IS_NATIVE) return
  openHandler = onOpen
  if (listenersInstalled) return
  listenersInstalled = true
  ;(async () => {
    try {
      const { FirebaseMessaging } = await loadMessaging()

      // Android: a high-importance channel so pushes show as heads-up banners.
      // send-push targets it by id ('promos'). Importance 4 = High, visibility
      // 1 = Public (definitions.d.ts). Safe to call every launch: Android keeps
      // an existing channel's importance (it can't be raised after creation).
      if (Capacitor.getPlatform() === 'android') {
        try {
          await FirebaseMessaging.createChannel({
            id: 'promos',
            name: 'Promotions',
            description: 'Deals and specials',
            importance: 4,
            visibility: 1,
            vibration: true,
          })
        } catch {
          console.warn('[push] createChannel failed')
        }
      }

      await FirebaseMessaging.addListener('tokenReceived', () => {
        syncPushToken()
      })
      await FirebaseMessaging.addListener('notificationActionPerformed', () => {
        try { openHandler?.() } catch { /* navigation must not crash the app */ }
      })
    } catch {
      listenersInstalled = false
      console.warn('[push] listener install failed')
    }
  })()
}
