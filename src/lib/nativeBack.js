import { useEffect, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import { IS_NATIVE } from './native'

// Android hardware/gesture back. Open overlays register here; back closes the
// topmost one, else navigates history, else minimizes (never exits).
// Web: the hook is a no-op and the listener is never installed.
const stack = []
let nextId = 0

export function useNativeBack(active, close) {
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!IS_NATIVE || !active) return
    const entry = { id: ++nextId, close: () => closeRef.current() }
    stack.push(entry)
    return () => {
      const i = stack.findIndex((e) => e.id === entry.id)
      if (i !== -1) stack.splice(i, 1)
    }
  }, [active])
}

export async function installNativeBackHandler() {
  if (!IS_NATIVE || Capacitor.getPlatform() !== 'android') return
  try {
    const { App } = await import('@capacitor/app')
    App.addListener('backButton', ({ canGoBack }) => {
      const top = stack.pop()
      if (top) {
        top.close()
      } else if (canGoBack) {
        window.history.back()
      } else {
        App.minimizeApp()
      }
    })
  } catch (err) {
    console.warn('[nativeBack] backButton listener not installed', err)
  }
}
