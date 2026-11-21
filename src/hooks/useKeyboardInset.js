import { useEffect, useState } from 'react'

// How much of the layout viewport the on-screen keyboard is covering, from the
// bottom. iOS Safari and WKWebView don't shrink the layout viewport for the
// keyboard, so a position: fixed bottom sheet sits behind it; the visual
// viewport does shrink, and this measures the difference.
//
// While `active`: { inset, viewportHeight } tracked from window.visualViewport
// 'resize' and 'scroll'. Inactive, or no visualViewport: inset 0.
export function useKeyboardInset(active) {
  const [state, setState] = useState(() => ({
    inset: 0,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
  }))

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!active || !vv) return
    const update = () =>
      setState({
        inset: Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop))),
        viewportHeight: vv.height,
      })
    // First read deferred a frame so it lands after the sheet's own layout.
    const raf = requestAnimationFrame(update)
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [active])

  const hasVV = typeof window !== 'undefined' && !!window.visualViewport
  if (!active || !hasVV) return { inset: 0, viewportHeight: state.viewportHeight }
  return state
}
