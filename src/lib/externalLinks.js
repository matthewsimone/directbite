import { Browser } from '@capacitor/browser'
import { IS_NATIVE, getPublicOrigin } from './native'

// Native only. WKWebView ignores target="_blank", and a relative link like
// /terms would load capacitor://localhost/terms with no way back. Every
// new-tab or absolute http(s) link opens in the in-app Safari sheet instead.
// tel:/mailto:/sms: and normal in-app links are left alone.
export function installExternalLinkHandler() {
  if (!IS_NATIVE) return
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = e.target.closest?.('a[href]')
    if (!a) return
    const href = a.getAttribute('href')
    if (!href || href.startsWith('#')) return
    if (/^(tel|mailto|sms):/i.test(href)) return
    const isAbsolute = /^https?:\/\//i.test(href)
    if (a.target !== '_blank' && !isAbsolute) return
    e.preventDefault()
    const url = isAbsolute ? href : new URL(href, getPublicOrigin()).toString()
    Browser.open({ url }).catch(() => {})
  })
}
