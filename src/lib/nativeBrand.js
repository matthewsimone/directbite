import { IS_NATIVE } from './native'

// Native shell only: exposes the restaurant's primary color as --brand so
// html.native rules (the tab bar's active state) can read it. No-op on web.
export function applyNativeBrand(primaryColor) {
  if (!IS_NATIVE) return
  const raw = typeof primaryColor === 'string' ? primaryColor.trim() : ''
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw : '#16A34A'
  document.documentElement.style.setProperty('--brand', color)
}
