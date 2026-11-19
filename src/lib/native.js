import { Capacitor } from '@capacitor/core'
import { PUBLIC_DOMAIN } from './publicDomain'

// True only inside the Capacitor iOS/Android shell. Always false on web.
export const IS_NATIVE = Capacitor.isNativePlatform()

// Origin for URLs that leave the app (Stripe return_url, share links).
// In the shell window.location.origin is capacitor://localhost, which no
// external service can redirect to. Web is unchanged.
export function getPublicOrigin() {
  return IS_NATIVE ? `https://${PUBLIC_DOMAIN}` : window.location.origin
}

// Per-restaurant app slug, baked at native build time (VITE_APP_SLUG=test).
// Ignored on web even if set, so a stray env var can't hijack ordr.co/.
export const APP_SLUG = IS_NATIVE ? (import.meta.env.VITE_APP_SLUG || null) : null
