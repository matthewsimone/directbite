import { IS_NATIVE } from './native'

// Native shell only: exposes the restaurant's primary color as --brand so
// html.native rules (the tab bar's active state) can read it. No-op on web.
export function applyNativeBrand(primaryColor) {
  if (!IS_NATIVE) return
  const raw = typeof primaryColor === 'string' ? primaryColor.trim() : ''
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw : '#16A34A'
  const full = /^#[0-9a-f]{3}$/i.test(color) ? '#' + color.slice(1).split('').map(c => c + c).join('') : color
  document.documentElement.style.setProperty('--brand', full)
}

// Native shell only: the resolved --brand hex for places that need a literal
// color (inline styles, withAlpha, Stripe appearance). Web returns fallback.
export function getNativeBrand(fallback) {
  if (!IS_NATIVE) return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : fallback
}
